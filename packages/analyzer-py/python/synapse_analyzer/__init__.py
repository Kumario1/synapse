"""Synapse Python analyzer sidecar.

Deterministic contract extraction (tree-sitter) and cross-file reference
resolution (jedi), emitting the same language-neutral Symbol shapes the rest of
Synapse speaks. Detection is never the LLM; this layer is pure AST/structural.
"""

__all__ = ["extract", "graph", "server"]
