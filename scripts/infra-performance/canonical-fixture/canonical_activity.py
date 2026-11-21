"""Read exact canonical signup and owner recovery observations from the opened Native Core."""

from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.error import HTTPError
from zipfile import ZipFile

from canonical_host_source import WORKFLOW_REF, protected_release_job
from successor_source import cloudflare
from hosted import HERE
from qualified_release import actions_get, git_read, protected_archive

sys.path.insert(0, str(HERE.parent / "deployed-fleet"))
from pilot import query

CORE = "fidy-native-storage-core"
OPEN = "native-verification.json.canonical-open"
SIGNUP = r"fidy\.operational component=canonical-signup operation=(google|microsoft) state=created\b"
WATCHDOG = r"fidy\.operational component=inspection-coverage operation=(ownerInspections) state=complete\b"
RECOVERY_ARTIFACT = "14596469892"
RECOVERY_RUN = "44662489274"
RECOVERY_DIGEST = "6e62f659994e237a7787ea326cda069e101344bc2b40960489a93ccaf348f5e0"
RECOVERY_REVISION = "b992abd28797606fa74fb0c7a4fda91bf13dc5a4"
RECOVERY_RUN_HEAD = "0bb23f4d28baef7ca37e908dad32a56a0aed4d00"


class ActivityRefused(ValueError):
    pass


def opened_release(reference, verifier, get=actions_get, git=git_read):
    if re.fullmatch(r"[1-9][0-9]{0,19}", reference["artifactId"]) is None:
        raise ValueError("Canonical activity requires an exact open archive")
    revision = json.loads(get("artifacts/" + reference["artifactId"]))["workflow_run"]["head_sha"]
    if (re.fullmatch(r"[a-f0-9]{40}", revision) is None or git("merge-base", revision, verifier) != revision):
        raise ValueError("Opening archive came from outside the current protected lineage")
    run, body = protected_archive(revision, reference["artifactId"], reference["sha256"],
                                  prefix="native-canonical-signup-open-", conclusions={"success"}, get=get)
    job = protected_release_job(run, get)
    expected = (
        "Capture exact closed canonical versions and the protected User Store census",
        "Upload only the compatible exact canonical signup versions",
        "Stage and verify both canonical signup Workers before opening",
        "Open the exact canonical signup pair and verify real provider redirects",
        "Retain exact canonical signup deployment and redirect evidence",
    )
    observed = [(step["name"], step["conclusion"]) for step in job["steps"] if step["name"] in expected]
    if observed != [(name, "success") for name in expected]:
        raise ValueError("The protected opening did not confirm the canonical deployment")
    with ZipFile(BytesIO(body)) as archive:
        entry, = archive.infolist()
        if entry.filename != OPEN or not 0 < entry.file_size <= 16384:
            raise ValueError("Unexpected opened deployment archive")
        opening = json.loads(archive.read(entry))
    if opening["revision"] != revision or opening["admission"] != "open":
        raise ValueError("Protected opening does not identify its own serving revision")
    return opening


def exact_events(account, version, since, until, label, pattern, read=query):
    filters = [
        {"key": key, "type": "string", "operation": op, "value": value}
        for key, op, value in (
            ("$workers.scriptName", "eq", CORE),
            ("$workers.scriptVersion.id", "eq", version),
            ("$metadata.message", "includes", label),
        )
    ]
    response = read(f"accounts/{account}/workers/observability/telemetry/query", {
        "queryId": "canonical-native-activity", "view": "events", "dry": True,
        "timeframe": {"from": since, "to": until}, "parameters": {"filters": filters, "limit": 100},
    })
    if response.get("success") is not True:
        raise ValueError("Native activity telemetry lookup refused")
    page = response["result"]["events"]
    entries = page["events"]
    if len(entries) >= 100 or page.get("count", len(entries)) != len(entries):
        raise ValueError("Native activity telemetry is incomplete")
    events = []
    seen = set()
    for row in entries:
        worker, metadata = row["$workers"], row["$metadata"]
        matched = re.search(pattern, metadata["message"])
        at, event_id = row["timestamp"], metadata["id"]
        if (not isinstance(at, int) or not since <= at < until
                or not isinstance(event_id, str) or not event_id or event_id in seen
                or worker["scriptName"] != CORE or worker["scriptVersion"]["id"] != version or not matched):
            raise ValueError("Unexpected event in the exact native activity query")
        seen.add(event_id)
        digest = hashlib.sha256((version + "/" + event_id + "/" + matched.group(0)).encode()).hexdigest()
        events.append({"kind": matched.group(1), "at": at, "sha256": digest})
    return events


def accepted_workerd_recovery(get=actions_get):
    artifact = json.loads(get("artifacts/" + RECOVERY_ARTIFACT))
    run = json.loads(get("runs/" + RECOVERY_RUN))
    if (str(artifact["id"]) != RECOVERY_ARTIFACT or artifact["expired"] is not False
            or artifact["name"] != f"native-fleet-{RECOVERY_RUN}-1"
            or str(artifact["workflow_run"]["id"]) != RECOVERY_RUN
            or artifact["workflow_run"]["head_sha"] != RECOVERY_RUN_HEAD
            or artifact["digest"] != "sha256:" + RECOVERY_DIGEST
            or str(run["id"]) != RECOVERY_RUN or run["head_sha"] != RECOVERY_RUN_HEAD
            or run["repository"]["full_name"] != "B4rz99/fidy-ai"
            or run["head_repository"]["full_name"] != "B4rz99/fidy-ai"
            or run["path"] != ".github/workflows/native-fleet.yml"
            or run["event"] != "pull_request" or run["run_attempt"] != 1 or run["conclusion"] != "success"):
        raise ValueError("Historical Workerd recovery source differs from the accepted proof")
    body = get("artifacts/" + RECOVERY_ARTIFACT + "/zip")
    if not 0 < len(body) <= 65536 or hashlib.sha256(body).hexdigest() != RECOVERY_DIGEST:
        raise ValueError("Historical Workerd recovery archive changed")
    with ZipFile(BytesIO(body)) as archive:
        entries = [entry for entry in archive.infolist() if entry.filename == "1000/report.json"]
        report, = entries
        if not 0 < report.file_size <= 8192:
            raise ValueError("Historical Workerd recovery report size differs")
        observed = json.loads(archive.read(report))
    if (observed["status"] != "pass" or observed["plan"]["revision"] != RECOVERY_REVISION
            or observed["plan"]["users"] != 1000 or observed["checks"]["actualDomainRecovery"] is not True
            or observed["rolling"]["attemptedOwners"] != 1003
            or observed["alarmRepairs"] != 1 or observed["completedReceiptExpiries"] != 1):
        raise ValueError("Historical report does not prove actual owned recovery")
    return {"kind": "accepted-workerd", "artifactId": RECOVERY_ARTIFACT, "runId": RECOVERY_RUN,
            "revision": RECOVERY_REVISION, "digest": RECOVERY_DIGEST}


def timestamp(stamp):
    return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000)


def native_canary(account, since, until, read=cloudflare):
    path = f"accounts/{account}/workflows/fidy-native-canary"
    workflow = read(path)
    if (workflow["name"] != "fidy-native-canary" or workflow["script_name"] != CORE
            or workflow["class_name"] != "OperationalCanaryWorkflowV1"):
        raise ValueError("Foreign Workflow in live background verification")
    rows = read(path + "/instances?status=complete&per_page=20")
    for row in rows:
        at = timestamp(row["started_on"])
        if (row["workflow_id"] == workflow["id"] and row["status"] == "complete"
                and row.get("trigger_source") == "binding" and since <= at < until
                and re.fullmatch(r"operational-canary-[0-9]+", row["id"])):
            detail = read(path + "/instances/" + row["id"])
            if detail["status"] == "complete" and since <= timestamp(detail["end"]) < until:
                return row["id"]
    raise ActivityRefused("No actual native background canary completion after the ordinary signup")


def outcomes(opening, account, end, read=query, read_canary=native_canary):
    start = timestamp(opening["openedAt"])
    if end <= start:
        raise ValueError("Canonical activity cannot predate opening")
    version = opening["workers"][CORE]["version"]
    signups = exact_events(account, version, start, end, "component=canonical-signup", SIGNUP, read)
    if len(signups) != 1:
        raise ActivityRefused(f"Expected one native provider account creation, observed {len(signups)}")
    signup, = signups
    complete = exact_events(account, version, signup["at"], end, "component=inspection-coverage", WATCHDOG, read)
    if not complete:
        raise ActivityRefused("No completed native watchdog traversal was observed after canonical signup")
    first = min(complete, key=lambda row: row["at"])
    canary = read_canary(account, signup["at"], end)
    background = hashlib.sha256((version + "/" + first["sha256"] + "/" + canary).encode()).hexdigest()
    return {"provider": signup["kind"], "signupDigest": signup["sha256"],
            "background": {"watchdogCompleted": True, "canaryCompleted": True, "digest": background}}


def main():
    try:
        env = os.environ
        expected = {
            "GITHUB_ACTIONS": "true", "GITHUB_REF_PROTECTED": "true",
            "GITHUB_REF": "refs/heads/trunk", "GITHUB_WORKFLOW_REF": WORKFLOW_REF,
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_RUN_ATTEMPT": "1",
            "FIXTURE_RELEASE_OPERATION": "verify-canonical-activity",
        }
        verifier = env["GITHUB_SHA"]
        if (any(env.get(name) != value for name, value in expected.items())
                or git_read("rev-parse", "HEAD") != verifier):
            raise ValueError("Requires current protected canonical activity verification")
        reference = {"artifactId": env["CANONICAL_OPENING_ARTIFACT"], "sha256": env["CANONICAL_OPENING_SHA256"]}
        opening = opened_release(reference, verifier)
        activity = outcomes(opening, env["CLOUDFLARE_ACCOUNT_ID"],
                            int(datetime.now(timezone.utc).timestamp() * 1000))
        directory = Path(env["RUNNER_TEMP"])
        with (directory / "native-canonical-observations.json").open("x") as evidence:
            json.dump({"opening": opening, "activity": activity,
                       "reference": reference, "recovery": accepted_workerd_recovery()}, evidence)
    except HTTPError as failure:
        sys.exit(f"Cloudflare canonical activity request returned HTTP {failure.code}.")
    except ActivityRefused as failure:
        sys.exit(str(failure))
    except (KeyError, ValueError, OSError, subprocess.SubprocessError):
        sys.exit("Protected canonical activity could not authenticate the opening, ordinary signup or actual native recovery.")


if __name__ == "__main__":
    main()
