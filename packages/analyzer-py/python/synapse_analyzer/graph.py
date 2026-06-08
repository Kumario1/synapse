"""Cross-file dependency graph for Python via jedi.

tree-sitter (``extract``) gives the symbols; jedi resolves references across
files accurately (its strength), so an edge ``A -> B`` means symbol ``A``'s body
references symbol ``B`` — even through imports and aliases. Only symbol ids and
edges leave this process; never source.

The files are materialized into a temporary jedi project so import resolution
works exactly as it would in the real tree, then the temp dir is removed.
"""

from __future__ import annotations

import os
import tempfile
from typing import Optional

import jedi

from .extract import extract_contracts, _normalize_path


def _enclosing_symbol(symbols: list[dict], line: int) -> Optional[dict]:
    """The innermost extracted symbol whose span contains ``line`` (1-indexed)."""
    best: Optional[dict] = None
    for symbol in symbols:
        span = symbol["span"]
        if span["startLine"] <= line <= span["endLine"]:
            if best is None or span["startLine"] >= best["span"]["startLine"]:
                best = symbol
    return best


def index_graph(files: list[dict]) -> dict:
    """Build ``{symbols, edges}`` for a set of ``{filePath, source}`` files."""
    normalized = [
        {"filePath": _normalize_path(file["filePath"]), "source": file.get("source", "")}
        for file in files
    ]

    symbols_by_file: dict[str, list[dict]] = {}
    all_symbols: dict[str, dict] = {}
    for file in normalized:
        symbols = extract_contracts(file["filePath"], file["source"])
        symbols_by_file[file["filePath"]] = symbols
        for symbol in symbols:
            all_symbols[symbol["id"]["raw"]] = symbol

    edges: dict[str, dict] = {}

    with tempfile.TemporaryDirectory(prefix="synapse-py-graph-") as project_dir:
        abs_to_rel: dict[str, str] = {}
        for file in normalized:
            abs_path = os.path.join(project_dir, file["filePath"])
            os.makedirs(os.path.dirname(abs_path), exist_ok=True)
            with open(abs_path, "w", encoding="utf-8") as handle:
                handle.write(file["source"])
            abs_to_rel[os.path.realpath(abs_path)] = file["filePath"]

        project = jedi.Project(project_dir)

        for file in normalized:
            rel_path = file["filePath"]
            file_symbols = symbols_by_file[rel_path]
            if not file_symbols:
                continue
            abs_path = os.path.join(project_dir, rel_path)
            try:
                script = jedi.Script(path=abs_path, project=project)
                references = script.get_names(all_scopes=True, references=True, definitions=False)
            except Exception:
                continue

            for reference in references:
                source_symbol = _enclosing_symbol(file_symbols, reference.line or 0)
                if source_symbol is None:
                    continue
                try:
                    targets = reference.goto(follow_imports=True, follow_builtin_imports=False)
                except Exception:
                    continue

                for target in targets:
                    target_path = target.module_path
                    if target_path is None:
                        continue
                    target_rel = abs_to_rel.get(os.path.realpath(str(target_path)))
                    if target_rel is None:
                        continue
                    target_symbol = _enclosing_symbol(
                        symbols_by_file.get(target_rel, []), target.line or 0
                    )
                    if target_symbol is None:
                        continue
                    if target_symbol["id"]["raw"] == source_symbol["id"]["raw"]:
                        continue
                    key = f"{source_symbol['id']['raw']}->{target_symbol['id']['raw']}"
                    edges[key] = {
                        "from": source_symbol["id"],
                        "to": target_symbol["id"],
                        "kind": "references",
                    }

    sorted_symbols = sorted(all_symbols.values(), key=lambda symbol: symbol["id"]["raw"])
    sorted_edges = sorted(
        edges.values(),
        key=lambda edge: f"{edge['from']['raw']}->{edge['to']['raw']}",
    )
    return {"symbols": sorted_symbols, "edges": sorted_edges}
