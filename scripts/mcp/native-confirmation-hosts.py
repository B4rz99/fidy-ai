#!/usr/bin/env python3
"""Pinned native-host evidence against oauth-ingress.test.ts's opt-in real Core/D1 fixture.

Start that test with FIDY_988_HOST_BRIDGE_FILE=/tmp/fidy-988-core/ready.json, then:
  python3 scripts/mcp/native-confirmation-hosts.py --claude PATH --codex PATH
No real inference, production accounts, deployment or production credentials.
Operator PTY keystrokes, no hooks; acceptance is not independently verified human presence.
Codex's separate daemon is copied/pinned to the checked CLI and stopped per case.
The runner finishes the disposable bridge after its requested cases.
"""
import argparse
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import threading
import time
from urllib.request import urlopen

BRIDGE = "http://127.0.0.1:19488"
MODEL = "http://127.0.0.1:19489"
PINNED = {"claude": "2.1.289", "codex": "0.160.0"}
state = {"budgetId": "", "modelRequests": 0, "modelToolCalls": 0, "toolNames": [], "modelCompletions": 0}


def bridge(path):
    with urlopen(BRIDGE + path, timeout=30) as response:
        return json.load(response)


class Model(BaseHTTPRequestHandler):
    """Only emits the one exact synthetic Budget deletion, then a fixed terminal response."""
    def log_message(self, *_):
        pass

    def do_GET(self):
        body = b"{}"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        value = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        state["modelRequests"] += 1
        if "count_tokens" in self.path:
            body, media = json.dumps({"input_tokens": 100}), "application/json"
        elif "messages" in self.path:
            body, media = self.anthropic(value), "text/event-stream"
        elif "responses" in self.path:
            body, media = self.codex_response(value), "text/event-stream"
        else:
            body, media = "{}", "application/json"
        self.send_response(200)
        self.send_header("Content-Type", media)
        self.send_header("Content-Length", str(len(body.encode())))
        self.end_headers()
        self.wfile.write(body.encode())

    def anthropic(self, value):
        state["toolNames"] = [t.get("name") for t in value.get("tools", [])]
        tool = next((t for t in value.get("tools", []) if "deleteBudget" in t.get("name", "")), None)
        done = any(c.get("type") == "tool_result" for m in value.get("messages", [])
                   for c in (m.get("content", []) if isinstance(m.get("content"), list) else []))
        args = {"params": {"id": state["budgetId"]}}
        invoke = tool is not None and not done
        state["modelCompletions"] += int(done)
        state["modelToolCalls"] += int(invoke)
        content = {"type": "tool_use", "id": "fixture_call", "name": tool["name"], "input": {}} if invoke else {"type": "text", "text": "Native Core fixture finished."}
        message = {"id": "msg_fixture", "type": "message", "role": "assistant", "model": value.get("model"), "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 100, "output_tokens": 0}}
        events = [("message_start", {"message": message}), ("content_block_start", {"index": 0, "content_block": content}),
                  ("content_block_delta", {"index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(args)} if invoke else {"type": "text_delta", "text": content["text"]}}),
                  ("content_block_stop", {"index": 0}), ("message_delta", {"delta": {"stop_reason": "tool_use" if invoke else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 20}}), ("message_stop", {})]
        if not value.get("stream"):
            content["input"] = args if invoke else {}
            message.update(content=[content], stop_reason="tool_use" if invoke else "end_turn")
            return json.dumps(message)
        return "".join("event: " + kind + "\ndata: " + json.dumps({"type": kind, **data}) + "\n\n" for kind, data in events)

    def codex_response(self, value):
        tools = [(t, None) for t in value.get("tools", [])] + [(c, t.get("name")) for t in value.get("tools", []) for c in t.get("tools", [])]
        found = next(((t, ns) for t, ns in tools if "deleteBudget" in t.get("name", "")), None)
        done = any(i.get("type") == "function_call_output" for i in value.get("input", []))
        invoke = found is not None and not done
        state["modelCompletions"] += int(done)
        state["toolNames"] = [t.get("name") for t, _ in tools]
        state["modelToolCalls"] += int(invoke)
        if invoke:
            tool, namespace = found
            item = {"type": "function_call", "call_id": "fixture_call", "name": tool["name"], "arguments": json.dumps({"params": {"id": state["budgetId"]}})}
            if namespace:
                item["namespace"] = namespace
        else:
            item = {"type": "message", "role": "assistant", "id": "fixture_message", "content": [{"type": "output_text", "text": "Native Core fixture finished."}]}
        events = [{"type": "response.created", "response": {"id": "fixture_response"}}, {"type": "response.output_item.done", "item": item},
                  {"type": "response.completed", "response": {"id": "fixture_response", "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "input_tokens_details": None, "output_tokens_details": None}}}]
        return "".join("data: " + json.dumps(event) + "\n\n" for event in events)


def run_case(binary, host, decision, root):
    state.update(budgetId=bridge("/reset")["budgetId"], modelRequests=0, modelToolCalls=0, toolNames=[], modelCompletions=0)
    case = root / (host + "-" + decision)
    case.mkdir()
    home = case / "home"
    home.mkdir()
    env = {k: v for k, v in os.environ.items() if not re.search("KEY|TOKEN|SECRET|CREDENTIAL|AUTH|CLAUDE|ANTHROPIC|CODEX", k)}
    env.update(HOME=str(home), TERM="xterm-256color", DISABLE_TELEMETRY="1", DISABLE_NONESSENTIAL_TRAFFIC="1", OTEL_SDK_DISABLED="true")
    prompt = "Run only fidy's budgets.deleteBudget MCP tool once for the supplied synthetic Budget."
    if host == "claude":
        (home / ".claude.json").write_text(json.dumps({"hasCompletedOnboarding": True, "theme": "dark", "projects": {str(case.resolve()): {"hasTrustDialogAccepted": True, "allowedTools": ["mcp__fidy__*"]}}}))
        config = case / "mcp.json"
        config.write_text(json.dumps({"mcpServers": {"fidy": {"type": "http", "url": BRIDGE + "/mcp"}}}))
        env.update(CLAUDE_CONFIG_DIR=str(home), ANTHROPIC_API_KEY="disposable-fixture-not-real", ANTHROPIC_BASE_URL=MODEL, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", ENABLE_TOOL_SEARCH="false")
        args = [binary, prompt, "--mcp-config", str(config), "--strict-mcp-config", "--allowedTools", "mcp__fidy__*", "--tools", "", "--permission-mode", "default", "--debug-file", str(case / "debug.txt")]
        if decision == "headless":
            args += ["-p"]
    else:
        (home / "config.toml").write_text('model = "fixture-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Loopback fixture"\nbase_url = "' + MODEL + '/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[mcp_servers.fidy]\nurl = "' + BRIDGE + '/mcp"\n[projects.' + json.dumps(str(case.resolve())) + ']\ntrust_level = "trusted"\n')
        if decision == "headless":
            # Local tool permission is deliberately separate from native confirmation. This
            # exact-tool permission reaches elicitation even in exec; it does not answer forms.
            with (home / "config.toml").open("a") as config_file:
                config_file.write('\n[mcp_servers.fidy.tools."budgets.deleteBudget"]\napproval_mode = "approve"\n')
        env["CODEX_HOME"] = str(home)
        # Codex otherwise auto-updates its separate daemon beyond the checked CLI version.
        subprocess.run([binary, "app-server", "daemon", "start"], env=env, cwd=case, capture_output=True, timeout=30, check=True)
        subprocess.run([binary, "app-server", "daemon", "update", "--from-cli", "--yes"], env=env, cwd=case, capture_output=True, timeout=30, check=True)
        args = [binary, "exec", "--skip-git-repo-check", prompt] if decision == "headless" else [binary, "--no-alt-screen", prompt]
    master, slave = pty.openpty()
    fcntl.ioctl(slave, 0x80087467, struct.pack("HHHH", 45, 140, 0, 0))
    process = subprocess.Popen(args, cwd=case, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output, authenticated, warmed, answered, finished = b"", False, 0, False, False
    last_warm = 0
    daemon_version = ""
    started = time.monotonic()
    try:
        while time.monotonic() - started < 75 and process.poll() is None:
            if select.select([master], [], [], .1)[0]:
                try:
                    output += os.read(master, 65536)
                    (case / "terminal.txt").write_bytes(output)
                except OSError:
                    break
            plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace"))
            compact = "".join(plain.split())
            if not authenticated and "DoyouwanttousethisAPIkey?" in compact:
                time.sleep(.5)
                os.write(master, b"\x1b[A")
                time.sleep(.3)
                os.write(master, b"\r")
                authenticated = True
            if host == "codex" and not authenticated and "Allow the fidy MCP server" in plain:
                time.sleep(.6)
                os.write(master, b"\r")
                authenticated = True
            if warmed < 3 and "NativeCorefixturefinished." in compact and "requestsyourinput" not in compact and not state["modelToolCalls"] and decision != "headless" and time.monotonic() - last_warm > 5:
                time.sleep(3)
                os.write(master, b"Run the budgets.deleteBudget tool now.\r")
                warmed += 1
                last_warm = time.monotonic()
            if not answered and "Confirmarlaacción" in compact and decision != "headless":
                time.sleep(.6)
                if decision == "cancel":
                    os.write(master, b"\x1b")
                elif host == "claude":
                    os.write(master, b" ")
                    time.sleep(.3)
                    os.write(master, b"\x1b[B")
                    time.sleep(.3)
                    os.write(master, b"\r")
                else:
                    os.write(master, b"\x1b[A")
                    time.sleep(.3)
                    os.write(master, b"\r")
                answered = True
            if state["modelToolCalls"] and state["modelCompletions"] and "NativeCorefixturefinished." in compact:
                time.sleep(.5)
                finished = True
                break
    finally:
        if host == "codex":
            metadata = json.loads(subprocess.check_output([binary, "app-server", "daemon", "version"], env=env, cwd=case, text=True, timeout=10))
            daemon_version = metadata.get("appServerVersion", "")
            managed = metadata.get("managedCodexPath")
            if managed and not Path(managed).resolve().is_relative_to(home.resolve()):
                raise RuntimeError("Refusing to stop a daemon outside the disposable home")
            subprocess.run([binary, "app-server", "daemon", "stop"], env=env, cwd=case, capture_output=True, timeout=10, check=True)
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except (PermissionError, ProcessLookupError):
                try:
                    process.terminate()
                except (PermissionError, ProcessLookupError):
                    pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        os.close(master)
        (case / "terminal.txt").write_bytes(output)
    observed = bridge("/status")
    expected = (0, 1) if decision == "accept" else (1, 0)
    result = {"host": host, "version": PINNED[host], "decision": decision, "formAnswered": answered, "completed": finished, "elapsedSeconds": round(time.monotonic() - started, 2), "remaining": observed["remaining"], "acceptedAudit": observed["accepted"], "trace": observed["trace"], "modelToolCalls": state["modelToolCalls"], "toolNames": state["toolNames"]}
    if host == "codex":
        result["appServerVersion"] = daemon_version
    result["actualToolCalled"] = any(event["method"] == "tools/call" and event["tool"] == "budgets.deleteBudget" for event in observed["trace"])
    result["localToolPermission"] = "exact Budget tool preapproved; native form not answered" if host == "codex" and decision == "headless" else "normal interactive permission or Claude exact-server permission"
    result["passed"] = (result["remaining"], result["acceptedAudit"]) == expected and result["modelToolCalls"] > 0 and finished and result["actualToolCalled"] and (host != "codex" or daemon_version == PINNED[host]) and (decision == "headless" or answered)
    (case / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claude", required=True)
    parser.add_argument("--codex", required=True)
    parser.add_argument("--output", default="/tmp/fidy-988-core/hosts")
    parser.add_argument("--cases", nargs="+", default=["claude-accept", "claude-cancel", "codex-accept", "codex-cancel", "claude-headless", "codex-headless"])
    args = parser.parse_args()
    for host in PINNED:
        actual = subprocess.check_output([getattr(args, host), "--version"], text=True).strip()
        if PINNED[host] not in actual:
            parser.error("Expected pinned " + host + " " + PINNED[host] + ", got " + actual)
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 19489), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    try:
        for case in args.cases:
            host, decision = case.split("-", 1)
            results.append(run_case(getattr(args, host), host, decision, root))
        (root / "evidence.json").write_text(json.dumps({"trustBoundary": "OAuth-authorized client acceptance, not independently verified human presence", "actualSeam": "Public ingress → Core → OAuth canonical admission → immutable intent → atomic owner mutation + Audit in D1", "fixture": "Disposable approved OAuth credential injected by loopback fixture; canned model; actual pinned CLIs and PTYs; no hooks", "results": results}, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        bridge("/finish")
    if not all(result["passed"] for result in results):
        raise SystemExit("Native host evidence failed; inspect synthetic terminal artifacts in " + str(root))


if __name__ == "__main__":
    main()
