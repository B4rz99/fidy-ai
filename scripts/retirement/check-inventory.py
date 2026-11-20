"""Rehearse the operator's read-only statement against a disposable frozen D1 schema."""
import sqlite3
import subprocess
import sys
from pathlib import Path

BASELINE = "fb53d9e755c14393048dc945fc0b7f117730d872"
MIGRATIONS = "apps/server/cloudflare/migrations"
QUERY = Path(__file__).with_name("legacy-inventory.sql")

# A shallow CI checkout may provide the pinned baseline as a second repository.
checkout = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
db = sqlite3.connect(":memory:")
files = subprocess.check_output(
    ["git", "ls-tree", "-r", "--name-only", BASELINE, MIGRATIONS], cwd=checkout, text=True
).splitlines()
assert files and files[-1].endswith("0015_remove_price_notices.sql")
for filename in files:
    migration = subprocess.check_output(
        ["git", "show", f"{BASELINE}:{filename}"], cwd=checkout, text=True
    )
    try:
        db.executescript(migration)
    except sqlite3.DatabaseError as error:
        raise RuntimeError(f"SQLite {sqlite3.sqlite_version} could not apply {filename}") from error


def census():
    db.execute("PRAGMA query_only = ON")
    try:
        return {
            name: (observed, complete, attention)
            for name, observed, complete, attention in db.execute(QUERY.read_text())
        }
    finally:
        db.execute("PRAGMA query_only = OFF")


empty = census()
assert len(empty) == 12 and set(empty.values()) == {(0, 1, 0)}
db.execute("""
    INSERT INTO anonymized_email_samples VALUES
    ('one','CO','notification-email','cloudflare-email','cloudflare-mime-v1',
     'structural-tags-v1','[]',0,0)
""")
db.execute("INSERT INTO erasure_writers VALUES ('one','synthetic','email','private',1)")
db.executemany("""
    INSERT INTO billing_provider_transactions
    (transaction_id,event_received_at_ms,event_signed_at,event_signed_status,
     event_lookup_attempts,event_resolved_at_ms) VALUES (?,1,1,'PENDING',0,?)
""", [("received", None), ("settled", 2)])
seen = census()
assert seen["structural_samples"] == (1, 1, 1)
assert seen["issued_r2_writers"] == (1, 1, 1)
assert seen["wompi_callback_candidates"] == (2, 1, 1)
db.executemany(
    "INSERT INTO erasure_writers VALUES (?,'synthetic','statement','private',1)",
    [(str(n),) for n in range(1001)],
)
assert census()["issued_r2_writers"] == (1000, 0, None)
db.execute("DROP TABLE anonymized_email_samples")
try:
    census()
except sqlite3.OperationalError as error:
    assert "no such table" in str(error)
else:
    raise AssertionError("An incomplete incumbent schema must refuse the census")
print("Passed empty, populated, truncated and missing-schema retirement inventories")
