"""Rehearse the operator's read-only statement against a disposable frozen D1 schema."""
from io import BytesIO
import sqlite3
import subprocess
import sys
import tarfile
from pathlib import Path

BASELINE = "fb53d9e755c14393048dc945fc0b7f117730d872"
MIGRATIONS = "apps/server/cloudflare/migrations"
QUERY = Path(__file__).with_name("legacy-inventory.sql")

repo = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
db = sqlite3.connect(":memory:")
archive_bytes = subprocess.check_output(
    ["git", "archive", "--format=tar", BASELINE, MIGRATIONS], cwd=repo, timeout=15
)
with tarfile.open(fileobj=BytesIO(archive_bytes), mode="r:") as archive:
    files = sorted(
        (member for member in archive.getmembers() if member.isfile() and member.name.endswith(".sql")),
        key=lambda member: member.name,
    )
    if not files or not files[-1].name.endswith("0015_remove_price_notices.sql"):
        raise ValueError("Missing the final frozen D1 migration")
    for migration in files:
        body = archive.extractfile(migration)
        if body is None:
            raise ValueError("Missing a frozen D1 migration")
        try:
            db.executescript(body.read().decode())
        except sqlite3.OperationalError as error:
            raise RuntimeError(
                f"{migration.name} failed on SQLite {sqlite3.sqlite_version}; "
                "use SQLite 3.54.0"
            ) from error


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
