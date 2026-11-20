"""Account budget and independent Cloudflare observations for ten fixed disposable Users."""
import hashlib
import json
import os
import re
import time
from dataclasses import asdict
from pathlib import Path

from observations import observation
from pilot import (CLEANUP_SECONDS, DAILY_READS, DAILY_WRITES, DAY, MAX_SECONDS,
                   PILOT_READS, PILOT_WRITES, RESERVE_READS, RESERVE_WRITES,
                   SIGNUP_SECONDS, Usage, admit, check_delta, iso, query, remaining_seconds,
                   usage, valid_usage)

ORDINALS = tuple(range(2, 12))
WINDOW_MS = 300_000
MIN_OWNERS = len(ORDINALS) + 3 + 2  # Three fixed owners and at least two registered smoke Users.
# Run 44637286958 measured 78,265/2,932 for its signed fixture on all owners.
# The deployed single-User continuation consumed another 50,924/401 account rows.
# Round up and allow for 1,196 retained B-tree cells at physical disposal in the native census.
ENROLL = (100_000, 3_500)
DISPOSE = (60_000, 2_000)
# Reserve shared observation/final settlement and residual usage inside the analytics lag.
TAIL = (100_000, 4_000)
WATERMARK_DELAY = 60
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"


def coverage(evidence, lookup):
    events = evidence["events"]
    start, = [r["at"] for r in events if r["stage"] == "observation-start"]
    end, = [r["at"] for r in events if r["stage"] == "observation-end"]
    created = [r for r in events if r["stage"] == "signup-created"]
    bindings = [r for r in events if r["stage"] == "member-bound"]
    members = evidence["members"]
    created_at = {r["ordinal"]: r["at"] for r in created}
    users = {m["user"] for m in members}
    physical = {m["physical"] for m in members}
    if (evidence["requestedPilotUsers"] != len(ORDINALS)
            or sorted(m["ordinal"] for m in members) != list(ORDINALS)
            or len(users) != len(ORDINALS) or any(not re.fullmatch(UUID, n) for n in users)
            or len(physical) != len(ORDINALS) or any(not re.fullmatch(r"[a-f0-9]{64}", n) for n in physical)
            or users.intersection(evidence["survivors"])
            or physical.intersection(n for n, _ in evidence["baseline"])
            or sorted(r["ordinal"] for r in created) != list(ORDINALS)):
        raise ValueError("Ten distinct new physical and registered logical Users required")
    if (end - start < 2 * WINDOW_MS or sorted(r["ordinal"] for r in bindings) != list(ORDINALS)
            or any(not 0 < created_at[r["ordinal"]] <= r["at"] <= start for r in bindings)
            or any(r["at"] < end for r in events if r["stage"] in ("member-admitted", "member-erased"))):
        raise ValueError("Ten bound members must precede both observation windows")
    # Query exactly the first two windows. In-window completions have both timestamps in range.
    result = lookup(start, start + 2 * WINDOW_MS)
    rows = result["coverageEvents"]
    previous = None
    totals = [dict.fromkeys(("wraps", "admitted", "attempted", "observed", "failed",
                             "unknown", "unsupported", "repaired"), 0) for _ in range(2)]
    for row in rows:
        completed = row["wrapped_at"]
        window = (completed - start) // WINDOW_MS
        if (window not in (0, 1) or (row["at"] - start) // WINDOW_MS != window
                or row["halt"] != "wrapped" or row["wraps"] <= 0
                or row["attempted"] != row["admitted"] or row["attempted"] < MIN_OWNERS
                or sum(row[key] for key in ("observed", "failed", "unknown", "unsupported")) != row["admitted"]
                or row["repaired"] > row["observed"]):
            raise ValueError("Watchdog tick does not establish fully accounted attempts")
        if previous and (row["wraps"] != previous["wraps"] + 1
                         or completed <= previous["wrapped_at"]
                         or completed // 60_000 != previous["wrapped_at"] // 60_000 + 1):
            raise ValueError("Interrupted watchdog wrap evidence")
        total = totals[window]
        total["wraps"] += 1
        for counter in total.keys() - {"wraps"}:
            total[counter] += row[counter]
        previous = row
    if any(t["wraps"] < 2 for t in totals):
        raise ValueError("Two successive completed wraps required inside each window")
    return {**result, "windows": totals, "windowStart": start, "windowEnd": start + 2 * WINDOW_MS,
            "observationEnd": end, "boundUsers": len(bindings),
            "minimumEligibleOwners": MIN_OWNERS, "completeAttemptCoverage": True}


def written_objects(account, namespace, start_ms, now, lookup):
    if (not re.fullmatch(r"[a-f0-9]{32}", namespace) or not re.fullmatch(r"[a-f0-9]{32}", account)
            or not now - DAY <= start_ms // 1000 <= now):
        raise ValueError("Invalid UserStore namespace or object observation window")
    response = lookup("graphql", {"query": """
        query($a:String!, $n:String!, $start:Time!, $end:Time!) {
          viewer { accounts(filter:{accountTag:$a}) { accountTag
            durableObjectsPeriodicGroups(limit:100,
              filter:{namespaceId:$n,datetime_geq:$start,datetime_leq:$end}) {
                dimensions {name objectId} sum {rowsWritten}
            }
          }}
        }""", "variables": {"a": account, "n": namespace, "start": iso(start_ms // 1000),
                            "end": iso(now)}})
    if response.get("errors"):
        raise ValueError("Physical object analytics refused")
    matched, = response["data"]["viewer"]["accounts"]
    rows = matched["durableObjectsPeriodicGroups"]
    if matched["accountTag"] != account or len(rows) >= 100:
        raise ValueError("Foreign or truncated physical object analytics")
    result = []
    for row in rows:
        n = row["sum"]["rowsWritten"]
        name, physical = row["dimensions"]["name"], row["dimensions"]["objectId"]
        if type(n) is not int or n < 0:
            raise ValueError("Malformed physical object counters")
        if n == 0:
            continue
        if not isinstance(physical, str) or not re.fullmatch(r"[a-f0-9]{64}", physical):
            raise ValueError("Malformed physical object counters")
        # Fixed release probes can have a non-User name. Only UUID-named Users can be matched.
        if isinstance(name, str) and re.fullmatch(UUID, name):
            result.append({"name": name, "id": physical})
    if len({r["name"] for r in result}) != len(result) or len({r["id"] for r in result}) != len(result):
        raise ValueError("Ambiguous UserStore physical identity")
    return result


def latest_for(events, stage, current):
    # Keep unresolved work reserved until a later periodic metrics bucket covers completion.
    return {row["ordinal"] for row in events if row["stage"] == stage and row["ordinal"] in ORDINALS
            and row["at"] // 1000 + WATERMARK_DELAY <= current.latest}


class AwaitWatermark(ValueError):
    """Known completed enrollments still have their conservative provisional reservations."""


def require_ten_room(phase, current, delta, now, enrolled, evidence, resumed=False, source_finished=None):
    events = evidence.get("events", [])
    confirmed = latest_for(events, "signup-created", current)
    erased = latest_for(events, "member-erased", current)
    # An original enrollment run may have lost its runner before archiving a final meter.
    # All original work predates this continuation. Until that watermark passes, reserve
    # all ten possible enrollments even when only the independent pre-enrollment archive survived.
    if resumed:
        potentially_enrolled = set(ORDINALS)
        upper_bound = source_finished or int(os.environ["FLEET_PILOT_STARTED_AT"])
        if current.latest >= upper_bound + WATERMARK_DELAY:
            confirmed = potentially_enrolled
    else:
        potentially_enrolled = set(enrolled)
    future = set(ORDINALS) - potentially_enrolled if phase in ("ten-begin", "ten-signup") else set()
    pending = len((potentially_enrolled | future) - confirmed)
    remaining = len((potentially_enrolled | future) - erased)
    available = (min(PILOT_READS - delta["reads"], DAILY_READS - RESERVE_READS - current.reads),
                 min(PILOT_WRITES - delta["writes"], DAILY_WRITES - RESERVE_WRITES - current.writes))
    minimum = (SIGNUP_SECONDS if phase in ("ten-begin", "ten-signup") else
               CLEANUP_SECONDS if phase in ("ten-check", "ten-resume") else 7 * 60)
    if remaining_seconds(now, MAX_SECONDS) < minimum:
        raise ValueError("Insufficient same-day time for remaining fleet work")

    def fits(pending_count):
        return all(have >= pending_count * enroll + remaining * dispose + tail
                   for have, enroll, dispose, tail in zip(available, ENROLL, DISPOSE, TAIL))
    if not fits(pending):
        completed = {event["ordinal"] for event in events if event["stage"] == "signup-created"
                     and 0 < event["at"] <= now * 1000 and event["ordinal"] in enrolled}
        if phase == "ten-signup" and fits(pending - len(completed - confirmed)):
            raise AwaitWatermark("Await original signup accounting")
        raise ValueError("Insufficient same-day fleet budget for outstanding work and cleanup")


def read_ledger(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def origin(rows, installed):
    first = rows[0]
    if (first["stage"] != "ten-begin" or first["pilotReads"] != PILOT_READS
            or first["pilotWrites"] != PILOT_WRITES
            or any(r.get("revision") != installed for r in rows)):
        raise ValueError("Original ten-User account ledger required")
    before = Usage(**first["usage"])
    valid_usage(before, before.sampled)
    return before


def last_sample(rows):
    for row in reversed(rows):
        if all(key in row for key in ("sampled", "latest", "reads", "writes")):
            return Usage(*(row[key] for key in ("sampled", "latest", "reads", "writes")))
    return Usage(**rows[0]["usage"])


def source_window(evidence):
    # Bind evidence for the original intervals before the continuation rewrites its checkpoint.
    stages = {"member-bound", "signup-created", "observation-start", "observation-end"}
    events = [(r["stage"], r["at"], r.get("ordinal")) for r in evidence["events"] if r["stage"] in stages]
    encoded = json.dumps([evidence["coreVersion"], evidence["members"], events],
                         sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def sample_ten(phase, revisions, args):
    directory = Path(os.environ["RUNNER_TEMP"])
    journal = directory / "native-fleet-meter.jsonl"
    path = Path(os.environ["SMOKE_ATTESTATION_FILE"] + ".fleet")
    installed = revisions["revision"]
    now = int(time.time())

    def append(stage, **values):
        with journal.open("a") as out:
            print(json.dumps({**revisions, "stage": stage, **values}), file=out)

    if phase == "ten-objects":
        namespace, start_ms = args
        print(json.dumps(written_objects(os.environ["CLOUDFLARE_ACCOUNT_ID"], namespace, int(start_ms), now, query)))
        return
    if phase == "ten-begin":
        current = usage()
        now = int(time.time())
        try:
            admit(current, now)
            require_ten_room(phase, current, {"reads": 0, "writes": 0}, now, [], {})
        except ValueError:
            with journal.open("x") as out:
                print(json.dumps({**revisions, "stage": "ten-begin-refused", "usage": asdict(current)}), file=out)
            raise
        with journal.open("x") as out:
            print(json.dumps({**revisions, "stage": phase, "usage": asdict(current),
                              "pilotReads": PILOT_READS, "pilotWrites": PILOT_WRITES}), file=out)
        return
    if phase == "ten-resume":
        provenance = json.loads((directory / "fleet-provenance.json").read_text())
        archived = directory / "fleet-source-meter.jsonl"
        rows = read_ledger(archived)
        origin(rows, installed)
        if (not re.fullmatch(r"[1-9][0-9]*", str(provenance["runId"]))
                or any(row["verifierRevision"] != provenance["sourceRevision"] for row in rows)):
            raise ValueError("Foreign archived fleet meter")
    else:
        rows = read_ledger(journal)
    continuation = next((r for r in rows if r["stage"] == "ten-resume"), {})
    source_finished = (provenance.get("sourceFinishedAt") if phase == "ten-resume"
                       else continuation.get("sourceFinishedAt"))
    if source_finished is not None and (type(source_finished) is not int
                                        or not 0 < source_finished <= int(os.environ["FLEET_PILOT_STARTED_AT"])):
        raise ValueError("Invalid source job completion bound")
    before = origin(rows, installed)
    resumed = phase == "ten-resume" or any(row["stage"] == "ten-resume" for row in rows)
    if phase != "ten-resume" and rows[-1]["verifierRevision"] != revisions["verifierRevision"]:
        raise ValueError("Missing revision-bound fleet budget")
    evidence = json.loads(path.read_text()) if path.is_file() else {}
    expected_verifier = provenance["sourceRevision"] if phase == "ten-resume" else revisions["verifierRevision"]
    if phase == "ten-resume" and not evidence:
        raise ValueError("Missing original ten-User checkpoint")
    if evidence and (evidence["revision"] != installed or evidence["verifierRevision"] != expected_verifier):
        raise ValueError("Foreign ten-User checkpoint")
    if phase == "ten-logs":
        if resumed:
            continuation, = [r for r in rows if r["stage"] == "ten-resume"]
            if (str(evidence.get("sourceRun")) != str(continuation["sourceRun"])
                    or evidence.get("sourceVerifierRevision") != continuation["sourceVerifierRevision"]
                    or source_window(evidence) != continuation["sourceWindowSha256"]):
                raise ValueError("Original observation windows or source run changed")
        observed = {}
        def lookup(start, end):
            rows = observation(query, os.environ["CLOUDFLARE_ACCOUNT_ID"], evidence["coreVersion"],
                               start, end, fleet=True)
            observed.update(windowStart=start, windowEnd=end, **rows)
            return rows
        try:
            result = coverage(evidence, lookup)
        except (KeyError, ValueError):
            append("ten-logs-incomplete", **observed)
            raise
        append(phase, **result)
        return
    if phase not in ("ten-signup", "ten-check", "ten-cleanup", "ten-resume", "ten-settle"):
        raise ValueError("Unknown ten-User metering phase")
    current = usage()
    now = int(time.time())
    delta = check_delta(before, current, now)
    previous = last_sample(rows)
    if (current.reads < previous.reads or current.writes < previous.writes
            or current.latest < previous.latest or current.sampled < previous.sampled
            or (phase == "ten-resume" and current.latest < previous.sampled)):
        raise ValueError("Account meter regressed or original source spend still unobserved")
    values = asdict(current)
    enrolled = [r["ordinal"] for r in rows if r["stage"] == "ten-signup"]
    if phase == "ten-signup":
        ordinal, = args
        if resumed or enrolled != list(ORDINALS[:len(enrolled)]) or len(enrolled) == len(ORDINALS) or int(ordinal) != ORDINALS[len(enrolled)]:
            raise ValueError("Only the next original cohort member may enroll")
        values["ordinal"] = int(ordinal)
    if phase == "ten-settle":
        finished_ms, = args
        finished = (int(finished_ms) + 999) // 1000
        if not before.sampled <= finished <= current.sampled + 1:
            raise ValueError("Invalid ten-User work interval")
        append(phase, **values)
        if current.latest >= finished and delta["reads"] > 0 and delta["writes"] > 0:
            append("ten-cumulative-delta", **delta)
            print("observed")
        else:
            print("pending")
        return
    try:
        require_ten_room(phase, current, delta, now, enrolled, evidence, resumed, source_finished)
    except AwaitWatermark:
        append("ten-await-watermark", **values)
        print("pending")
        return
    except ValueError:
        # Preserve sampled refusal evidence without admitting an ordinal or replacing its origin.
        with (directory / "native-fleet-refusal.jsonl").open("a") as out:
            print(json.dumps({**revisions, "phase": phase, "usage": values, "delta": delta}), file=out)
        raise
    if phase == "ten-resume":
        with journal.open("x") as out:
            for row in rows:
                print(json.dumps(row), file=out)
        values.update(sourceRun=provenance["runId"], sourceVerifierRevision=provenance["sourceRevision"],
                      sourceWindowSha256=source_window(evidence), sourceFinishedAt=source_finished)
    append(phase, **values)
    if phase == "ten-signup":
        print("admitted")
