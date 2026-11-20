"""Fence only the exact incumbent writers after the protected native cutover plan is authenticated."""
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import subprocess
import sys

from disposition import SCOPE, active_worker, indexed, queue_graph, validate_scope, provider_inventory
from opening_source import ACCOUNT, ZONE
from provider import Provider, Refused, require
from provenance import ID, REPOSITORY, REVISION, SHA

WORKFLOW = REPOSITORY + "/.github/workflows/native-storage-release.yml@refs/heads/trunk"
INCUMBENT_DOMAINS = {
    "app.fidyapp.com": ("6d1dc510634cbcd8a6dcc1708f6b3d90df0f9ef4", "fidy-web"),
    "api.fidyapp.com": ("133265e618b99c89427c1c04e274028e8caf50ba", "fidycloudflare-ingress-production-hf6ajjsszff23h5z"),
}
NATIVE = {"core": "fidy-native-storage-core", "ingress": "fidy-native-storage-ingress"}
ACTIVE = ("queued", "running", "waiting", "waitingForPause", "rollingBack")


def protected_inputs(env):
    required = {
        "GITHUB_ACTIONS": "true", "GITHUB_REF_PROTECTED": "true", "GITHUB_REF": "refs/heads/trunk",
        "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_RUN_ATTEMPT": "1",
        "GITHUB_WORKFLOW_REF": WORKFLOW, "FIXTURE_RELEASE_OPERATION": "transfer-canonical-hosts",
        "NATIVE_STORAGE_ADMISSION": "closed", "NATIVE_STORAGE_HOSTS": "staged",
        "CLOUDFLARE_ACCOUNT_ID": ACCOUNT,
    }
    require(all(env.get(key) == value for key, value in required.items()),
            "Incumbent fence requires the protected canonical transfer")
    verifier = env["GITHUB_SHA"]
    require(REVISION.fullmatch(verifier) and
            subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, timeout=10).strip() == verifier,
            "Incumbent fence has a different verifier checkout")
    for kind in ("SOURCE", "SMOKE", "PLAN"):
        require(ID.fullmatch(env.get("CANONICAL_" + kind + "_ARTIFACT", "")) and
                SHA.fullmatch(env.get("CANONICAL_" + kind + "_SHA256", "")),
                "Protected native smoke, source or exact cutover plan is missing")
    temp = Path(env["RUNNER_TEMP"])
    plan = json.loads((temp / "native-canonical-host-approved.json").read_bytes())
    source = json.loads((temp / "native-canonical-host-source.json").read_bytes())
    require(plan["applied"] is False and plan["verifierRevision"] == verifier and
            isinstance(plan["resources"], list) and plan["resources"] and
            source["verifierRevision"] == verifier and REVISION.fullmatch(source["revision"]),
            "Canonical writer fence does not belong to the approved read-only plan")
    for kind, key in (("SOURCE", "source"), ("SMOKE", "smoke")):
        reference = source[key]
        require(reference["artifactId"] == env["CANONICAL_" + kind + "_ARTIFACT"] and
                reference["sha256"] == env["CANONICAL_" + kind + "_SHA256"],
                "Canonical writer fence has different protected evidence")
    return source, temp


def check_domains(provider):
    domains = indexed(provider.pages("workers/domains", "hostname"), "hostname")
    for host, (identity, worker) in INCUMBENT_DOMAINS.items():
        row = domains.get(host)
        require(row and row["id"] == identity and row["service"] == worker and
                row["zone_id"] == provider.zone and row["enabled"] is True,
                "Canonical incumbent hostname differs from the approved transfer")
    require(not any(row["service"] in SCOPE["workers"] and host not in INCUMBENT_DOMAINS
                    for host, row in domains.items()), "Unexpected incumbent hostname attachment")


def require_closed_source(provider, source):
    for role, worker in NATIVE.items():
        require(active_worker(provider, worker) == {"deployment": source["deployments"][role],
                                                  "version": source["versions"][role]},
                "Native Worker changed after the successful smoke")
        result = provider.result(f"workers/scripts/{worker}/versions/{source['versions'][role]}")
        bindings = indexed(result["resources"]["bindings"], "name")
        require(bindings["NATIVE_STORAGE_ADMISSION"]["text"] == "closed" and
                bindings["RELEASE_GIT_SHA"]["text"] == source["revision"],
                "Native Worker has different closed release bindings")


def disable_worker(provider, worker, record):
    path = "workers/scripts/" + worker
    schedule = provider.result(path + "/schedules")["schedules"]
    exposure = provider.result(path + "/subdomain")
    require(type(schedule) is list and all(isinstance(row["cron"], str) for row in schedule) and
            type(exposure["enabled"]) is bool and type(exposure["previews_enabled"]) is bool,
            "Incomplete incumbent Worker writer state")
    record({"stage": "worker-fence-offered", "worker": worker,
            "cron": [row["cron"] for row in schedule],
            "workersDev": exposure["enabled"], "previews": exposure["previews_enabled"]})
    if schedule:
        provider.result(path + "/schedules", method="PUT", body=[])
    if exposure["enabled"] or exposure["previews_enabled"]:
        provider.result(path + "/subdomain", method="POST",
                        body={"enabled": False, "previews_enabled": False})
    observed = provider.result(path + "/subdomain")
    require(provider.result(path + "/schedules")["schedules"] == [] and
            observed["enabled"] is False and observed["previews_enabled"] is False,
            "Incumbent Worker remained scheduled or externally exposed")
    record({"stage": "worker-fence-verified", "worker": worker})


def pause_queue(provider, identity, name, record):
    path = "queues/" + identity
    observed = provider.result(path)
    require(observed["queue_id"] == identity and observed["queue_name"] == name and
            type(observed["settings"].get("delivery_paused", False)) is bool, "Exact incumbent queue changed")
    paused = observed["settings"].get("delivery_paused", False)
    record({"stage": "queue-pause-offered", "queue": identity, "previouslyPaused": paused})
    if not paused:
        provider.result(path, method="PATCH", body={"settings": {"delivery_paused": True}})
    final = provider.result(path)
    require(final["queue_id"] == identity and final["queue_name"] == name and
            final["settings"] == {**observed["settings"], "delivery_paused": True},
            "Incumbent queue settings changed outside the delivery fence")
    record({"stage": "queue-pause-verified", "queue": identity})


def await_workflows(provider, record):
    from time import sleep
    for attempt in range(7):
        busy = []
        for name in SCOPE["workflows"]:
            if any(provider.result(f"workflows/{name}/instances?status={state}&per_page=1") != []
                   for state in ACTIVE):
                busy.append(name)
        if not busy:
            record({"stage": "workflows-quiescent", "count": len(SCOPE["workflows"])})
            return
        record({"stage": "workflow-quiescence-pending", "workflows": busy})
        if attempt < 6:
            sleep(20)
    raise Refused("Incumbent workflows have not quiesced")


def fence(provider, source, record):
    require_closed_source(provider, source)
    check_domains(provider)
    graph = provider_inventory(provider)
    workers = validate_scope(graph)
    require(workers == set(SCOPE["workers"]) and
            set(SCOPE["queues"]) <= set(graph["queues"]) and set(SCOPE["workflows"]) <= set(graph["workflows"]),
            "An exact incumbent writer identity is missing")
    routes = provider.pages("workers/routes", "id", zone=True)
    require(not any(row.get("script") in workers for row in routes),
            "Unreviewed zone route references an incumbent Worker")
    queue_graph(provider, graph["queues"], workers, require_paused=False)
    check_domains(provider)
    for identity, name in SCOPE["queues"].items():
        pause_queue(provider, identity, name, record)
    for worker in sorted(workers):
        disable_worker(provider, worker, record)
    await_workflows(provider, record)
    require_closed_source(provider, source)
    check_domains(provider)
    record({"stage": "incumbent-writer-fence-verified"})


def main():
    try:
        env = os.environ
        source, temp = protected_inputs(env)
        provider = Provider(account=ACCOUNT, zone=ZONE, token=env["CLOUDFLARE_API_TOKEN"],
                            builds_token=env["CLOUDFLARE_BUILDS_READ_TOKEN"])
        os.umask(0o077)
        with (temp / "native-canonical-incumbent-fence.jsonl").open("x", encoding="utf-8") as receipt:
            def record(row):
                receipt.write(json.dumps({**row, "observed": datetime.now(timezone.utc).isoformat()}) + "\n")
                receipt.flush()
            record({"stage": "prevalidated", "nativeRevision": source["revision"],
                    "planArtifact": env["CANONICAL_PLAN_ARTIFACT"]})
            fence(provider, source, record)
    except (Refused, ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as failure:
        message = str(failure) if isinstance(failure, Refused) else "Protected incumbent writer fence refused"
        print(message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
