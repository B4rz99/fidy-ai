"""Protected single-User pilot. Cloudflare counters cover the whole account, including cleanup."""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

DAY = 86400
MAX_AGE = 600
# Keep an entire 36-User rehearsal's measured cost available for the one-User pilot,
# rounded up from 1,661,321 reads and 70,639 writes, including physical cleanup.
PILOT_READS, PILOT_WRITES = 2_000_000, 75_000
DAILY_READS, DAILY_WRITES = 5_000_000, 100_000
RESERVE_READS, RESERVE_WRITES = 2_500_000, 10_000
MAX_SECONDS = 40 * 60


@dataclass(frozen=True)
class Usage:
    sampled: int
    latest: int
    reads: int
    writes: int


def valid_usage(usage, now):
    if (usage.sampled // DAY != now // DAY or usage.latest // DAY != now // DAY
            or not 0 <= now - usage.sampled <= MAX_AGE
            or not 0 <= now - usage.latest <= MAX_AGE):
        raise ValueError("Durable Object usage absent, stale or outside the UTC day")
    if any(type(value) is not int or value < 0 for value in (usage.reads, usage.writes)):
        raise ValueError("Invalid Durable Object SQLite row counters")


def admit(usage, now):
    valid_usage(usage, now)
    if (DAY - now % DAY <= MAX_SECONDS
            or usage.reads + PILOT_READS + RESERVE_READS > DAILY_READS
            or usage.writes + PILOT_WRITES + RESERVE_WRITES > DAILY_WRITES):
        raise ValueError("Insufficient same-day Durable Object row headroom")


def check_delta(before, current, now):
    valid_usage(current, now)
    if before.sampled // DAY != current.sampled // DAY:
        raise ValueError("Accounting day changed")
    reads, writes = current.reads - before.reads, current.writes - before.writes
    if not (0 <= reads <= PILOT_READS and 0 <= writes <= PILOT_WRITES):
        raise ValueError("Account row delta exceeds the pilot budget or regressed")
    return {"reads": reads, "writes": writes}


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def query(path, body):
    request = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/" + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def usage():
    now = int(time.time())
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    if not re.fullmatch("[a-f0-9]{32}", account):
        raise ValueError("Invalid Cloudflare account")
    window = 'filter:{datetime_geq:"%s",datetime_leq:"%s"}' % (iso(now - now % DAY), iso(now))
    # No namespace filter and no grouping on totals. The second alias supplies data recency.
    body = query("graphql", {"query": '''
        query($account:String!) {viewer {accounts(filter:{accountTag:$account}) {
          accountTag
          totals:durableObjectsPeriodicGroups(limit:1,%s) {sum {rowsRead rowsWritten}}
          latest:durableObjectsPeriodicGroups(limit:1,%s,orderBy:[datetime_DESC]) {dimensions {datetime}}
        }}}''' % (window, window), "variables": {"account": account}})
    if body.get("errors"):
        raise ValueError("Cloudflare rejected the Durable Object counters")
    [row] = body["data"]["viewer"]["accounts"]
    if row["accountTag"] != account:
        raise ValueError("Cloudflare account mismatch")
    [totals], [latest] = row["totals"], row["latest"]
    stamp = datetime.fromisoformat(latest["dimensions"]["datetime"].replace("Z", "+00:00"))
    return Usage(now, int(stamp.timestamp()), totals["sum"]["rowsRead"], totals["sum"]["rowsWritten"])


def run():
    if (os.environ.get("GITHUB_REF") != "refs/heads/trunk"
            or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or os.environ.get("NATIVE_STORAGE_ADMISSION") != "closed"
            or not re.fullmatch("[a-f0-9]{40}", os.environ.get("RELEASE_GIT_SHA", ""))
            or os.environ["RELEASE_GIT_SHA"] != os.environ.get("GITHUB_SHA")):
        raise ValueError("Closed protected dispatch at the exact source revision required")
    directory = Path(os.environ["RUNNER_TEMP"])
    journal = directory / "native-fleet-meter.jsonl"
    stop = directory / "native-fleet-stop"
    def record(stage, **values):
        with journal.open("a") as out:
            print(json.dumps({"stage": stage, "revision": os.environ["GITHUB_SHA"], **values}), file=out)
    before = usage()
    record("baseline", **asdict(before), pilotReads=PILOT_READS, pilotWrites=PILOT_WRITES)
    admit(before, int(time.time()))
    started = time.monotonic()
    interrupted = False
    with subprocess.Popen(["bun", "native-storage-release.ts", "fleet-pilot"],
                          cwd=Path(__file__).resolve().parents[3] / "infra/cloudflare") as driver:
        while driver.poll() is None:
            try:
                driver.wait(timeout=30)
            except subprocess.TimeoutExpired:
                if interrupted:
                    continue
                try:
                    current = usage()
                    record("running", **asdict(current))
                    check_delta(before, current, int(time.time()))
                    if time.monotonic() - started >= MAX_SECONDS - 15 * 60:
                        raise ValueError("Reserve window for cleanup")
                except Exception:
                    # The User's authenticated erasure remains available when further trials stop.
                    interrupted = True
                    stop.touch()
                    record("stop-admission")
    finished = int(time.time())
    record("driver", status=driver.returncode)
    for attempt in range(21):
        after = usage()
        delta = check_delta(before, after, int(time.time()))
        record("after", **asdict(after), accountDelta=delta)
        if after.latest >= finished and delta["reads"] > 0 and delta["writes"] > 0:
            if driver.returncode or interrupted:
                raise ValueError("Pilot incomplete")
            return
        if attempt < 20:
            time.sleep(15)
    raise ValueError("Post-cleanup counters missing")

if __name__ == "__main__":
    try:
        run()
    except Exception as exc:
        # Log no response body, account token or authentication material.
        sys.exit("Fleet pilot failed (" + type(exc).__name__ + "); inspect protected checkpoints")
