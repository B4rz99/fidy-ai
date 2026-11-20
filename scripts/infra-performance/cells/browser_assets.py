"""Bind a deployable copy of the pinned web build to the disposable, key-gated Ingress."""
import base64
import gzip
import hashlib
import json
import mimetypes
import re


def pack(root, out):
    data, index = {}, {}
    for item in sorted(root.rglob("*")):
        path = item.relative_to(root).as_posix()
        if not item.is_file() or (path != "index.html" and not re.fullmatch(r"assets/[a-zA-Z0-9_./-]+", path)):
            continue
        if item.is_symlink() or path.endswith(".map") or not item.resolve().is_relative_to(root.resolve()):
            raise ValueError("Unexpected frozen build asset")
        raw = item.read_bytes()
        media = mimetypes.guess_type(path)[0] or "application/octet-stream"
        compressed = gzip.compress(raw, mtime=0)
        data[path] = [media, base64.b64encode(compressed).decode()]
        index[path] = dict(sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw))
    if "index.html" not in data or len(data) < 2:
        raise ValueError("Frozen web build is incomplete")
    (out/"browser-assets.json").write_text(json.dumps(index))
    (out/"browser-assets.mjs").write_text("export default " + json.dumps(data, separators=(",",":")) + ";")
