# Model-free real-host probes

Extract as `host-probes.py` in the isolated scratch directory. This drives the actual installed Claude CLI and Codex app-server protocol; it does not implement MCP, invoke a model or inspect credential files. Use only fresh disposable profiles. All profile paths are resolved to the same physical spelling and subprocesses are bounded and terminated. Output is a safe outcome projection, not raw login/callback text.

```python
"""Model-free host probes. Run only in the disposable scratch directory."""
import json
import os
import pty
import select
import subprocess
import sys
import time
from pathlib import Path

root = Path.cwd().resolve()
mode, profile = sys.argv[1:3]
env = {key: value for key, value in os.environ.items() if not key.endswith("API_KEY")}
if mode == "claude-login":
    env.update(CLAUDE_CONFIG_DIR=str(root / profile), DISABLE_TELEMETRY="1", DISABLE_NONESSENTIAL_TRAFFIC="1")
    master, slave = pty.openpty()
    process = subprocess.Popen([str(root / "node_modules/.bin/claude"), "mcp", "login", "spike"], stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    output = b""
    deadline = time.monotonic() + 20
    try:
        while time.monotonic() < deadline and process.poll() is None:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    output += os.read(master, 65536)
                except OSError:
                    break
        text = output.decode(errors="replace")
        print(json.dumps({"host": "Claude Code", "authenticated": 'Authenticated with "spike"' in text, "issuerRejected": "issuer" in text.lower() and 'Authenticated with "spike"' not in text}))
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait()
        os.close(master)
elif mode == "codex-discover":
    env["CODEX_HOME"] = str(root / profile)
    process = subprocess.Popen([str(root / "node_modules/.bin/codex"), "app-server", "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    def send(message):
        process.stdin.write((json.dumps(message) + "\n").encode())
        process.stdin.flush()
    send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "fidy-disposable-spike", "version": "0.0.0"}, "capabilities": {"experimentalApi": True}}})
    send({"method": "initialized", "params": {}})
    send({"id": 2, "method": "mcpServerStatus/list", "params": {"serverName": "spike"}})
    deadline = time.monotonic() + 20
    output = None
    pending = b""
    try:
        while time.monotonic() < deadline:
            if select.select([process.stdout], [], [], 0.1)[0]:
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    message = json.loads(line)
                    if message.get("id") == 2:
                        output = message
                if output is not None:
                    break
        result = output.get("result", {}) if output else {}
        print(json.dumps({"host": "Codex", "completed": output is not None, "servers": [{"name": row["name"], "authStatus": row["authStatus"], "toolsError": row.get("toolsError"), "serverInfo": row.get("serverInfo"), "tools": sorted(row.get("tools", {}).keys())} for row in result.get("data", [])], "error": output.get("error") if output else None}))
    finally:
        process.terminate()
        process.wait()
else:
    raise SystemExit("Use claude-login or codex-discover")
```
