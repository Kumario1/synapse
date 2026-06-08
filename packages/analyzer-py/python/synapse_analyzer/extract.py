"""Contract extraction for Python via tree-sitter.

Walks the concrete syntax tree and emits the public contract of a module:
module-level functions, classes (+ their public methods and annotated fields),
and module-level annotated constants. Each becomes a language-neutral Symbol
matching the protocol's ``CodeSymbol`` shape so it flows through the same
conflict engine as TypeScript symbols.

Only structural facts are read — never executed, never the LLM.
"""

from __future__ import annotations

import hashlib
import re
from typing import Optional

from tree_sitter import Language, Node, Parser
import tree_sitter_python

_LANGUAGE = Language(tree_sitter_python.language())
_PARSER = Parser(_LANGUAGE)

_WHITESPACE = re.compile(r"\s+")


def _normalize_text(text: str) -> str:
    """Collapse runs of whitespace and trim — matches the TS analyzer."""
    return _WHITESPACE.sub(" ", text).strip()


def _sig_hash(raw: str) -> str:
    """sha256 of the normalized signature — identical scheme to analyzer-ts."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _normalize_path(path: str) -> str:
    return path.replace("\\", "/")


def _symbol_id(file_path: str, name: str) -> dict:
    return {"raw": f"py:{_normalize_path(file_path)}#{name}"}


def _text(node: Optional[Node], source: bytes) -> str:
    if node is None:
        return ""
    return source[node.start_byte : node.end_byte].decode("utf-8", "replace")


def _is_public(name: str) -> bool:
    """Public contract = not a private (``_``-prefixed) name. ``__init__`` is the
    constructor contract, so dunders are kept."""
    if name.startswith("__") and name.endswith("__"):
        return True
    return not name.startswith("_")


def _span(file_path: str, node: Node) -> dict:
    # tree-sitter points are 0-indexed (row, column); Synapse spans are
    # 1-indexed lines, matching the TS analyzer.
    return {
        "path": _normalize_path(file_path),
        "startLine": node.start_point[0] + 1,
        "endLine": node.end_point[0] + 1,
    }


def _build_symbol(file_path: str, node: Node, kind: str, name: str, signature: Optional[dict]) -> dict:
    normalized_signature = None
    if signature is not None:
        normalized_signature = {**signature, "raw": _normalize_text(signature["raw"])}
    sig_hash = _sig_hash(normalized_signature["raw"]) if normalized_signature else _sig_hash(name)
    return {
        "id": _symbol_id(file_path, name),
        "kind": kind,
        "name": name,
        "visibility": "exported",
        "signature": normalized_signature,
        "sigHash": sig_hash,
        "span": _span(file_path, node),
        "lang": "py",
    }


def _type_parameters(node: Node, source: bytes) -> list[str]:
    type_params = node.child_by_field_name("type_parameters")
    if type_params is None:
        return []
    names: list[str] = []
    for child in type_params.named_children:
        if child.type == "type_parameter":
            ident = child.child_by_field_name("name") or (child.named_children[0] if child.named_children else None)
            names.append(_text(ident, source))
        elif child.type == "identifier":
            names.append(_text(child, source))
    return [name for name in names if name]


def _parameters(params_node: Optional[Node], source: bytes, drop_first_self: bool) -> list[dict]:
    if params_node is None:
        return []
    params: list[dict] = []
    for child in params_node.named_children:
        param = _parameter(child, source)
        if param is not None:
            params.append(param)
    if drop_first_self and params and params[0]["name"] in ("self", "cls"):
        params = params[1:]
    return params


def _parameter(node: Node, source: bytes) -> Optional[dict]:
    node_type = node.type
    if node_type == "identifier":
        return {"name": _text(node, source), "type": None, "optional": False}
    if node_type == "typed_parameter":
        # `name: type` — name is the first child, type is the `type` field.
        ident = node.named_children[0] if node.named_children else None
        type_node = node.child_by_field_name("type")
        return {
            "name": _text(ident, source),
            "type": _normalize_text(_text(type_node, source)) or None,
            "optional": False,
        }
    if node_type == "default_parameter":
        name_node = node.child_by_field_name("name")
        return {"name": _text(name_node, source), "type": None, "optional": True}
    if node_type == "typed_default_parameter":
        name_node = node.child_by_field_name("name")
        type_node = node.child_by_field_name("type")
        return {
            "name": _text(name_node, source),
            "type": _normalize_text(_text(type_node, source)) or None,
            "optional": True,
        }
    if node_type == "list_splat_pattern":
        ident = node.named_children[0] if node.named_children else None
        return {"name": f"*{_text(ident, source)}", "type": None, "optional": True}
    if node_type == "dictionary_splat_pattern":
        ident = node.named_children[0] if node.named_children else None
        return {"name": f"**{_text(ident, source)}", "type": None, "optional": True}
    # Bare `*`, `/` separators and anything unexpected are not real parameters.
    return None


def _render_param(param: dict) -> str:
    optional = "?" if param["optional"] else ""
    if param["type"]:
        return f"{param['name']}{optional}: {param['type']}"
    return f"{param['name']}{optional}"


def _callable_signature(node: Node, source: bytes, qualified_name: str, is_method: bool) -> dict:
    name_node = node.child_by_field_name("name")
    params_node = node.child_by_field_name("parameters")
    return_node = node.child_by_field_name("return_type")
    generics = _type_parameters(node, source)
    params = _parameters(params_node, source, drop_first_self=is_method)
    returns = _normalize_text(_text(return_node, source)) or None
    type_params = f"[{', '.join(generics)}]" if generics else ""
    params_text = ", ".join(_render_param(param) for param in params)
    returns_text = f" -> {returns}" if returns else ""
    signature = {
        "params": params,
        "returns": returns,
        "raw": f"def {qualified_name}{type_params}({params_text}){returns_text}",
    }
    if generics:
        signature["generics"] = generics
    return signature


def _function_symbol(file_path: str, node: Node, source: bytes, qualified_name: str, is_method: bool) -> dict:
    return _build_symbol(
        file_path,
        node,
        "method" if is_method else "function",
        qualified_name,
        _callable_signature(node, source, qualified_name, is_method),
    )


def _field_symbols_from_assignment(file_path: str, assignment: Node, source: bytes, class_name: str) -> list[dict]:
    """A class-body annotated assignment is a public field/attribute contract."""
    left = assignment.child_by_field_name("left")
    type_node = assignment.child_by_field_name("type")
    if left is None or type_node is None or left.type != "identifier":
        return []
    attr = _text(left, source)
    if not _is_public(attr):
        return []
    name = f"{class_name}.{attr}"
    type_text = _normalize_text(_text(type_node, source))
    signature = {"params": [], "returns": type_text or None, "raw": f"{name}: {type_text}"}
    return [_build_symbol(file_path, assignment, "field", name, signature)]


def _class_symbols(file_path: str, node: Node, source: bytes) -> list[dict]:
    name_node = node.child_by_field_name("name")
    class_name = _text(name_node, source)
    if not class_name or not _is_public(class_name):
        return []

    generics = _type_parameters(node, source)
    type_params = f"[{', '.join(generics)}]" if generics else ""
    class_signature = {"params": [], "returns": None, "raw": f"class {class_name}{type_params}"}
    if generics:
        class_signature["generics"] = generics
    symbols = [_build_symbol(file_path, node, "class", class_name, class_signature)]

    body = node.child_by_field_name("body")
    if body is None:
        return symbols

    for member in body.named_children:
        if member.type == "function_definition":
            method_name = _text(member.child_by_field_name("name"), source)
            if not method_name or not _is_public(method_name):
                continue
            qualified = f"{class_name}.{method_name}"
            symbols.append(_function_symbol(file_path, member, source, qualified, is_method=True))
        elif member.type == "decorated_definition":
            inner = member.child_by_field_name("definition")
            if inner is not None and inner.type == "function_definition":
                method_name = _text(inner.child_by_field_name("name"), source)
                if method_name and _is_public(method_name):
                    qualified = f"{class_name}.{method_name}"
                    symbols.append(_function_symbol(file_path, inner, source, qualified, is_method=True))
        elif member.type == "expression_statement":
            for expr in member.named_children:
                if expr.type == "assignment":
                    symbols.extend(_field_symbols_from_assignment(file_path, expr, source, class_name))

    return symbols


def _const_symbols(file_path: str, assignment: Node, source: bytes) -> list[dict]:
    """A module-level annotated assignment is a public const contract."""
    left = assignment.child_by_field_name("left")
    type_node = assignment.child_by_field_name("type")
    if left is None or type_node is None or left.type != "identifier":
        return []
    name = _text(left, source)
    if not _is_public(name):
        return []
    type_text = _normalize_text(_text(type_node, source))
    signature = {"params": [], "returns": type_text or None, "raw": f"const {name}: {type_text}"}
    return [_build_symbol(file_path, assignment, "const", name, signature)]


def _top_level_symbols(file_path: str, root: Node, source: bytes) -> list[dict]:
    symbols: list[dict] = []
    for node in root.named_children:
        definition = node
        if node.type == "decorated_definition":
            inner = node.child_by_field_name("definition")
            if inner is None:
                continue
            definition = inner

        if definition.type == "function_definition":
            name = _text(definition.child_by_field_name("name"), source)
            if name and _is_public(name):
                symbols.append(_function_symbol(file_path, definition, source, name, is_method=False))
        elif definition.type == "class_definition":
            symbols.extend(_class_symbols(file_path, definition, source))
        elif node.type == "expression_statement":
            for expr in node.named_children:
                if expr.type == "assignment":
                    symbols.extend(_const_symbols(file_path, expr, source))

    return symbols


def extract_contracts(file_path: str, source: str) -> list[dict]:
    """Extract the public contract symbols from one Python source string."""
    source_bytes = source.encode("utf-8")
    tree = _PARSER.parse(source_bytes)
    symbols = _top_level_symbols(file_path, tree.root_node, source_bytes)
    # Deterministic, id-sorted output — matches analyzer-ts.
    unique: dict[str, dict] = {}
    for symbol in symbols:
        unique[symbol["id"]["raw"]] = symbol
    return sorted(unique.values(), key=lambda symbol: symbol["id"]["raw"])
