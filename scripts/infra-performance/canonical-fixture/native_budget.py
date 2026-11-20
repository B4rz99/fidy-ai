"""Apply the existing shared native pilot reserve and bound the additional R2 account exposure."""
from dataclasses import asdict
from datetime import datetime
import time

# This path is set by protected_cohort before importing the existing native fleet meter.
from pilot import (DAY, DAILY_READS, DAILY_WRITES, MAX_AGE, RESERVE_READS,
                   RESERVE_WRITES, CLEANUP_READS, CLEANUP_WRITES, Usage, admit, check_delta, iso, usage)

# The eight-original fixture, 30 history reads and physical erasure measured 173,511
# cursor reads, 5,919 cursor writes and 31 alarm writes on workerd. Allow 500k/20k
# for foreground work and account-meter lag, plus the independent recovery reserve.
COHORT_READS = 500_000 + CLEANUP_READS
COHORT_WRITES = 20_000 + CLEANUP_WRITES
# Reserve for both controller lifetimes, census delay, R2 custody, leases, and final settlement.
R2_OPERATIONS = 4096
R2_BYTES = 1_048_576
MAX_R2_OPERATIONS = 1_000_000
MAX_R2_CLASS_B = 10_000_000
MAX_R2_BYTES = 10_000_000_000


def epoch(stamp):
    return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp())


def operations_by_action(groups):
    if not isinstance(groups, list) or not 0 < len(groups) < 100:
        raise ValueError("Incomplete R2 operation breakdown")
    counts = {}
    for group in groups:
        name, count = group["dimensions"]["actionType"], group["sum"]["requests"]
        if not isinstance(name, str) or not name or name in counts or type(count) is not int or count < 0:
            raise ValueError("Invalid R2 operation breakdown")
        counts[name] = count
    return counts


def aggregate_requests(rows):
    if not isinstance(rows, list) or len(rows) != 1:
        raise ValueError("Missing R2 operation aggregate")
    try:
        count = rows[0]["sum"]["requests"]
    except (KeyError, TypeError) as error:
        raise ValueError("Malformed R2 operation aggregate") from error
    if type(count) is not int or count < 0:
        raise ValueError("Invalid R2 operation count")
    return count


def r2_usage(query, account, now):
    window = dict(account=account, start=iso(now-31*DAY+1), day=iso(now-now%DAY), end=iso(now))
    filters = "filter:{datetime_geq:$start,datetime_leq:$end}"
    result = query("graphql", {"variables": window, "query": """
      query($account:String!,$start:Time!,$day:Time!,$end:Time!){viewer{accounts(filter:{accountTag:$account}){
        accountTag
        total:r2OperationsAdaptiveGroups(limit:1,%s){sum{requests}}
        classA:r2OperationsAdaptiveGroups(limit:1,filter:{datetime_geq:$start,datetime_leq:$end,actionType_neq:"GetObject"}){sum{requests}}
        byAction:r2OperationsAdaptiveGroups(limit:100,%s){dimensions{actionType} sum{requests}}
        today:r2OperationsAdaptiveGroups(limit:1,filter:{datetime_geq:$day,datetime_leq:$end}){sum{requests}}
        latest:r2OperationsAdaptiveGroups(limit:1,%s,orderBy:[datetime_DESC]){dimensions{datetime}}
        storage:r2StorageAdaptiveGroups(limit:100,%s){dimensions{bucketName} max{payloadSize metadataSize}}
      }}}""" % (filters, filters, filters, filters)})
    row, = result["viewer"]["accounts"]
    total = aggregate_requests(row.get("total"))
    filtered = aggregate_requests(row.get("classA"))
    today_requests = aggregate_requests(row.get("today"))
    actions = operations_by_action(row["byAction"])
    grouped_total = sum(actions.values())
    # Adaptive totals and grouped estimates can diverge. Only GetObject is excluded from Class A.
    class_a = max(filtered, grouped_total - actions.get("GetObject", 0))
    requests = max(total, grouped_total, class_a, today_requests)
    latest, = row["latest"]
    storage = row["storage"]
    buckets = [item["dimensions"]["bucketName"] for item in storage]
    sizes = [value for item in storage for value in [item["max"]["payloadSize"],item["max"]["metadataSize"]]]
    if (row["accountTag"] != account or not 0 <= now-epoch(latest["dimensions"]["datetime"]) <= MAX_AGE
            or not 0 < len(buckets) < 100 or len(buckets) != len(set(buckets))
            or "fidy-native-release-smoke" not in buckets
            or any(type(n) is not int or n < 0 for n in sizes)):
        raise ValueError("Missing fresh, bounded account R2 observations")
    return dict(requests=requests, upperBoundClassA=class_a,
                todayRequests=today_requests, upperBoundBytes=sum(sizes), sampled=now,
                latest=epoch(latest["dimensions"]["datetime"]))


def observe(query, account):
    return dict(sqlite=asdict(usage()), r2=r2_usage(query,account,int(time.time())))


def r2_room(sample, operations, storage):
    class_a = sample.get("upperBoundClassA", sample["requests"])
    if (class_a + operations > MAX_R2_OPERATIONS
            or sample["requests"] + operations > MAX_R2_CLASS_B
            or sample["upperBoundBytes"] + storage > MAX_R2_BYTES):
        raise ValueError("Insufficient Standard R2 free headroom")


def check(initial, current, phase, now):
    rows = Usage(**current["sqlite"])
    if phase == "begin":
        r2_room(current["r2"], R2_OPERATIONS, R2_BYTES)
        admit(rows, now, reads=COHORT_READS, writes=COHORT_WRITES)
        return
    baseline = Usage(**initial["sqlite"])
    if baseline.sampled // DAY != now // DAY:
        raise ValueError("Reserved native accounting day expired")
    delta = check_delta(baseline, rows, now)
    clean = phase in ("cleanup", "finish")
    r2_delta = current["r2"]["todayRequests"] - initial["r2"]["todayRequests"]
    growth = max(0, current["r2"]["upperBoundBytes"] - initial["r2"]["upperBoundBytes"])
    if growth > R2_BYTES:
        raise ValueError("Account R2 storage growth exceeds the experiment reserve")
    r2_room(current["r2"], R2_OPERATIONS - r2_delta, R2_BYTES - growth)
    if not 0 <= r2_delta <= (R2_OPERATIONS if clean else R2_OPERATIONS // 2):
        raise ValueError("Additional account R2 requests exceeded the native reserve or regressed")
    if (delta["reads"] + (0 if clean else CLEANUP_READS) > COHORT_READS
            or delta["writes"] + (0 if clean else CLEANUP_WRITES) > COHORT_WRITES
            or rows.reads + RESERVE_READS + (0 if clean else CLEANUP_READS) > DAILY_READS
            or rows.writes + RESERVE_WRITES + (0 if clean else CLEANUP_WRITES) > DAILY_WRITES):
        raise ValueError("Remaining native allowance reserved for cleanup")
    return delta


def recovery_reservation(original, current, now):
    """Lease one separately metered cleanup when the original UTC accounting window has closed."""
    from pilot import valid_usage
    rows = Usage(**current["sqlite"])
    valid_usage(rows, now)
    r2_room(current["r2"], R2_OPERATIONS, R2_BYTES)
    if (original["sqlite"]["sampled"] // DAY >= now // DAY or DAY-now % DAY <= 45*60
            or rows.reads+CLEANUP_READS+RESERVE_READS > DAILY_READS
            or rows.writes+CLEANUP_WRITES+RESERVE_WRITES > DAILY_WRITES):
        raise ValueError("Insufficient same-day independently metered recovery allowance")
    return current
