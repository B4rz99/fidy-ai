"""Bind protected verifier revisions to the installed application source."""
import json
import re
import subprocess

APPLICATION = "b85bfb06ab573259c250231623b77b0f65e2ae5c"
STAGED_IDS = {
    "publicVersionId": "9937b1c5-bdc2-43eb-9cb4-3e65af4e00ab",
    "coreVersionId": "0421da6d-3cf8-4e99-a538-52b2b5c47ca2",
    "publicDeploymentId": "61dc398a-e734-4ca1-9de6-786d37e2e9d1",
    "coreDeploymentId": "d392e5c1-c447-4484-8d94-bb6c5371603e",
}
VERIFIER_FILES = {
    ".github/workflows/native-storage-release.yml",
    ".github/workflows/native-transaction-cohort.yml",
    "docs/operations/production-benchmark-budget.md",
    "infra/cloudflare/native-fallback-probe.test.ts",
    "infra/cloudflare/native-fallback-probe.ts",
    "infra/cloudflare/native-fallback-recovery.test.ts",
    "infra/cloudflare/native-fallback-recovery.ts",
    "infra/cloudflare/native-storage-release.ts",
    "infra/cloudflare/production-release.test.ts",
    "infra/cloudflare/production-release.ts",
    "infra/cloudflare/scripts/check-production-runtime-config.test.ts",
    "infra/cloudflare/verify-edge-policy.ts",
    "scripts/infra-performance/canonical-fixture/fallback_stage.py",
    "scripts/infra-performance/canonical-fixture/pairing_stage.py",
    "scripts/infra-performance/canonical-fixture/test_pairing_stage.py",
    "scripts/infra-performance/canonical-fixture/qualified_release.py",
    "scripts/infra-performance/canonical-fixture/staged_application.py",
    "scripts/infra-performance/canonical-fixture/test_fallback_stage.py",
    "scripts/infra-performance/canonical-fixture/test_unsealed_stage.py",
    "scripts/infra-performance/canonical-fixture/unsealed_stage.py",
}


def git_read(*args):
    return subprocess.check_output(["git", *args]).decode().removesuffix("\n")


def verify_tree(revision, git, application=APPLICATION):
    if not re.fullmatch("[a-f0-9]{40}", revision) or git("merge-base", application, revision) != application:
        raise ValueError("Staged application is not the ancestor of this verifier")
    changed = set(git("diff", "--name-only", "--no-renames", "-z", application, revision, "--").split("\0")) - {""}
    if not changed <= VERIFIER_FILES:
        raise ValueError("Verifier changed a staged Worker, Web, binding or dependency source")


def require_steps(get, run, verdict, steps):
    inventory = json.loads(get(f"runs/{run}/attempts/1/jobs?per_page=100"))
    if len(inventory["jobs"]) != inventory["total_count"]:
        raise ValueError("Incomplete protected workflow job inventory")
    release, = [job for job in inventory["jobs"] if job["name"] == "release"]
    observed = [(step["name"], step["conclusion"]) for step in release["steps"] if step["name"] in steps]
    if release["conclusion"] != verdict or observed != list(steps.items()):
        raise ValueError("Protected run did not establish the required stage and traffic outcomes")
