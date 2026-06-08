"""Long-lived JSON-RPC-over-stdio analyzer sidecar.

Reads newline-delimited JSON requests on stdin and writes one newline-delimited
JSON response per request on stdout. Stays warm so the daemon pays import +
parser startup once. Every request is isolated: a handler error returns a
structured ``error`` rather than killing the loop, so one bad file never takes
the analyzer down.

Request:  {"id": <any>, "method": "health"|"extractFile"|"indexGraph", "params": {...}}
Response: {"id": <any>, "result": {...}}  |  {"id": <any>, "error": {"message": "..."}}
"""

from __future__ import annotations

import json
import sys
import traceback

VERSION = "0.0.0"


def _handle(method: str, params: dict):
    if method == "health":
        return {"ok": True, "version": VERSION, "lang": "py"}
    if method == "extractFile":
        from .extract import extract_contracts

        return {"symbols": extract_contracts(params["filePath"], params.get("source", ""))}
    if method == "indexGraph":
        from .graph import index_graph

        return index_graph(params.get("files", []))
    raise ValueError(f"unknown method: {method}")


def _write(message: dict) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            _write({"id": None, "error": {"message": f"invalid JSON: {error}"}})
            continue

        request_id = request.get("id")
        method = request.get("method", "")
        params = request.get("params") or {}
        try:
            _write({"id": request_id, "result": _handle(method, params)})
        except Exception as error:  # noqa: BLE001 — isolate every handler failure
            _write(
                {
                    "id": request_id,
                    "error": {"message": str(error), "trace": traceback.format_exc()},
                }
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
