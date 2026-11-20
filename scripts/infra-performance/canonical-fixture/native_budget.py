"""Apply the existing shared native pilot reserve and bound the additional R2 account exposure."""
from dataclasses import asdict
from datetime import datetime
import time

# This path is set by protected_cohort before importing the existing native fleet meter.
from pilot import (DAY, DAILY_READS, DAILY_WRITES, MAX_AGE, PILOT_READS, PILOT_WRITES, RESERVE_READS,
                   RESERVE_WRITES, CLEANUP_READS, CLEANUP_WRITES, Usage, admit, check_delta, iso, usage)

# Reserve for both controller lifetimes, census delay, R2 custody, leases, and final settlement.
R2_OPERATIONS = 4096
R2_BYTES = 1_048_576
MAX_R2_OPERATIONS = 1_000_000
MAX_R2_BYTES = 10_000_000_000


def epoch(stamp):
    return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp())


def r2_usage(query, account, now):
    window = dict(account=account, start=iso(now-31*DAY+1), day=iso(now-now%DAY), end=iso(now))
    filters = "filter:{datetime_geq:$start,datetime_leq:$end}"
    result = query("graphql", {"variables": window, "query": """
      query($account:String!,$start:Time!,$day:Time!,$end:Time!){viewer{accounts(filter:{accountTag:$account}){
        accountTag
        total:r2OperationsAdaptiveGroups(limit:1,%s){sum{requests}}
        today:r2OperationsAdaptiveGroups(limit:1,filter:{datetime_geq:$day,datetime_leq:$end}){sum{requests}}
        latest:r2OperationsAdaptiveGroups(limit:1,%s,orderBy:[datetime_DESC]){dimensions{datetime}}
        storage:r2StorageAdaptiveGroups(limit:100,%s){dimensions{bucketName} max{payloadSize metadataSize}}
      }}}""" % (filters, filters, filters)})
    row, = result["viewer"]["accounts"]
    count, = row["total"]
    daily, = row["today"]
    today_requests = daily["sum"]["requests"]
    latest, = row["latest"]
    storage = row["storage"]
    requests = count["sum"]["requests"]
    buckets = [item["dimensions"]["bucketName"] for item in storage]
    sizes = [value for item in storage for value in [item["max"]["payloadSize"],item["max"]["metadataSize"]]]
    if (row["accountTag"] != account or not 0 <= now-epoch(latest["dimensions"]["datetime"]) <= MAX_AGE
            or not 0 < len(buckets) < 100 or len(buckets) != len(set(buckets))
            or "fidy-native-release-smoke" not in buckets
            or any(type(n) is not int or n < 0 for n in [requests, today_requests, *sizes])):
        raise ValueError("Missing fresh, bounded account R2 observations")
    if requests + R2_OPERATIONS > MAX_R2_OPERATIONS or sum(sizes) + R2_BYTES > MAX_R2_BYTES:
        raise ValueError("Insufficient Standard R2 free headroom")
    return dict(requests=requests, todayRequests=today_requests, upperBoundBytes=sum(sizes), sampled=now,
                latest=epoch(latest["dimensions"]["datetime"]))


def observe(query, account):
    return dict(sqlite=asdict(usage()), r2=r2_usage(query,account,int(time.time())))


def check(initial, current, phase, now):
    rows = Usage(**current["sqlite"])
    if phase == "begin":
        admit(rows, now)
        return
    baseline = Usage(**initial["sqlite"])
    if baseline.sampled // DAY != now // DAY:
        raise ValueError("Reserved native accounting day expired")
    delta = check_delta(baseline, rows, now)
    clean = phase in ("cleanup", "finish")
    r2_delta = current["r2"]["todayRequests"] - initial["r2"]["todayRequests"]
    if not 0 <= r2_delta <= (R2_OPERATIONS if clean else R2_OPERATIONS // 2):
        raise ValueError("Additional account R2 requests exceeded the native reserve or regressed")
    if (delta["reads"] + (0 if clean else CLEANUP_READS) > PILOT_READS
            or delta["writes"] + (0 if clean else CLEANUP_WRITES) > PILOT_WRITES
            or rows.reads + RESERVE_READS + (0 if clean else CLEANUP_READS) > DAILY_READS
            or rows.writes + RESERVE_WRITES + (0 if clean else CLEANUP_WRITES) > DAILY_WRITES):
        raise ValueError("Remaining native allowance reserved for cleanup")
    return delta


def recovery_reservation(original, current, now):
    """Lease one separately metered cleanup when the original UTC accounting window has closed."""
    from pilot import valid_usage
    rows = Usage(**current["sqlite"])
    valid_usage(rows, now)
    if (original["sqlite"]["sampled"] // DAY >= now // DAY or DAY-now % DAY <= 45*60
            or rows.reads+CLEANUP_READS+RESERVE_READS > DAILY_READS
            or rows.writes+CLEANUP_WRITES+RESERVE_WRITES > DAILY_WRITES):
        raise ValueError("Insufficient same-day independently metered recovery allowance")
    return current
