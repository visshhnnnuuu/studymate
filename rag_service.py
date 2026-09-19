"""Small Python RAG service for StudyMate.

Stores extracted document chunks, performs lightweight lexical retrieval, and
returns source passages to the Node chat gateway. It intentionally keeps the
LLM call in the Node gateway so credentials remain server-side.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from collections import Counter
import json
import re
import threading
import time

HOST = "127.0.0.1"
PORT = 8090
STORE = Path(__file__).parent / "data" / "rag_store.json"
LOCK = threading.Lock()
TOKEN_RE = re.compile(r"[a-zA-Z0-9_]{3,}")


def tokens(text: str):
    return [t.lower() for t in TOKEN_RE.findall(text)]


def load_store():
    try:
        return json.loads(STORE.read_text())
    except Exception:
        return []


def save_store(items):
    STORE.parent.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(items, indent=2))


def chunk_text(text: str, size: int = 900, overlap: int = 120):
    words = text.split()
    chunks = []
    start = 0
    while start < len(words):
        piece = " ".join(words[start:start + size]).strip()
        if piece:
            chunks.append(piece)
        if start + size >= len(words):
            break
        start += size - overlap
    return chunks


def ingest(payload):
    item_id = payload.get("id") or f"rag_{int(time.time() * 1000)}"
    name = payload.get("name", "Imported material")
    text = str(payload.get("text", "")).strip()
    entries = load_store()
    entries = [entry for entry in entries if entry.get("document_id") != item_id]
    chunks = chunk_text(text)
    for index, chunk in enumerate(chunks):
        entries.append({"document_id": item_id, "name": name, "chunk_id": index, "text": chunk, "tokens": tokens(chunk)})
    with LOCK:
        save_store(entries)
    return {"ok": True, "document_id": item_id, "chunks": len(chunks)}


def retrieve(payload):
    query = str(payload.get("query", ""))
    limit = min(int(payload.get("limit", 5)), 8)
    query_terms = Counter(tokens(query))
    scored = []
    for item in load_store():
        counts = Counter(item.get("tokens", []))
        overlap = sum(min(query_terms[t], counts[t]) for t in query_terms)
        if overlap:
            score = overlap / max(1, len(query_terms))
            scored.append({"score": round(score, 4), "documentId": item["document_id"], "name": item["name"], "chunkId": item["chunk_id"], "text": item["text"]})
    scored.sort(key=lambda item: item["score"], reverse=True)
    return {"ok": True, "results": scored[:limit]}


def delete_document(payload):
    document_id = str(payload.get("id", ""))
    entries = [entry for entry in load_store() if entry.get("document_id") != document_id]
    with LOCK:
        save_store(entries)
    return {"ok": True, "document_id": document_id}


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "service": "python-rag", "chunks": len(load_store())})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            if self.path == "/ingest":
                self._json(200, ingest(payload))
            elif self.path == "/retrieve":
                self._json(200, retrieve(payload))
            elif self.path == "/delete":
                self._json(200, delete_document(payload))
            else:
                self._json(404, {"error": "not found"})
        except Exception as exc:
            self._json(400, {"error": str(exc)})

    def log_message(self, *_):
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Python RAG service listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
