"""Cloudflare account evidence and exact resource requests for incumbent retirement."""
from pathlib import Path
import json
import os
import re
import subprocess
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

API = "https://api.cloudflare.com/client/v4/"
PAGE_SIZE = 100
MAX_PAGES = 20
MAX_REPLY = 4_000_000
HEX_ID = re.compile(r"[a-f0-9]{32}")
UUID = re.compile(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}")
WORKER = re.compile(r"[a-z0-9][a-z0-9-]{1,62}")
SQL = Path(__file__).with_name("legacy-inventory.sql")
CENSUS = {
    "structural_samples", "issued_r2_writers", "forwarded_email_receipts", "statement_staging",
    "upload_admission_events", "wompi_callback_candidates", "billing_attempts", "refund_attempts",
    "payment_enrollments", "whatsapp_deliveries", "connection_attempts", "provider_authentication_attempts",
}


class Refused(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Provider:
    def __init__(self, *, account, zone, token, builds_token):
        require(HEX_ID.fullmatch(account) and HEX_ID.fullmatch(zone) and token and builds_token,
                "Missing exact Cloudflare coordinates or credential")
        self.account, self.zone = account, zone
        self.token, self.builds_token = token, builds_token
        self.http = build_opener(NoRedirect())

    def request(self, path, *, method="GET", body=None, zone=False, builds=False, absent=False,
                empty_notifications=False):
        scope = f"zones/{self.zone}/" if zone else f"accounts/{self.account}/"
        require(isinstance(path, str) and not path.startswith("/") and "://" not in path,
                "Invalid private provider path")
        headers = {"Authorization": "Bearer " + (self.builds_token if builds else self.token)}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(API + scope + path, headers=headers, method=method,
                          data=None if body is None else json.dumps(body).encode())
        try:
            with self.http.open(request, timeout=25) as response:
                raw = response.read(MAX_REPLY + 1)
        except HTTPError as failure:
            if absent and failure.status == 404:
                return None
            if empty_notifications and failure.status == 404:
                payload = json.loads(failure.read(4097))
                if [item.get("code") for item in payload.get("errors", [])] == [11015]:
                    return None
            raise Refused(f"Cloudflare {method} refused with HTTP {failure.status}") from None
        require(len(raw) <= MAX_REPLY, "Provider reply exceeded the private inventory bound")
        data = json.loads(raw)
        require(data.get("success") is True and "result" in data, "Incomplete provider confirmation")
        return data

    def result(self, path, **kwargs):
        data = self.request(path, **kwargs)
        return None if data is None else data["result"]

    def pages(self, path, field, *, zone=False):
        rows, seen = [], set()
        for page in range(1, MAX_PAGES + 1):
            join = "&" if "?" in path else "?"
            data = self.request(path + join + urlencode({"page": page, "per_page": PAGE_SIZE}), zone=zone)
            batch, info = data["result"], data.get("result_info") or {}
            require(type(batch) is list and type(info) is dict and len(batch) <= PAGE_SIZE,
                    "Invalid paginated provider inventory")
            require(info.get("page", page) == page and info.get("count", len(batch)) == len(batch),
                    "Provider inventory page does not reconcile")
            for row in batch:
                identity = row[field]
                require(isinstance(identity, str) and identity and identity not in seen,
                        "Duplicate or missing provider resource identity")
                seen.add(identity)
            rows.extend(batch)
            total = info.get("total_count")
            last = info.get("total_pages")
            if total is not None:
                require(type(total) is int and total >= len(rows), "Invalid provider total count")
            if last is not None:
                require(type(last) is int and last >= 0 and (page <= last or not rows),
                        "Invalid provider page count")
            if (total is not None and len(rows) == total) or (
                last is not None and page >= last
            ) or (total is None and last is None and len(batch) < PAGE_SIZE):
                require(total is None or len(rows) == total, "Incomplete provider inventory")
                return rows
            require(batch, "Provider inventory stopped before its declared total")
        raise Refused("Provider inventory exceeded its page bound")

    def buckets(self):
        rows, cursor, cursors = [], None, set()
        for _ in range(MAX_PAGES):
            query = {"per_page": PAGE_SIZE}
            if cursor is not None:
                query["cursor"] = cursor
            page = self.request("r2/buckets?" + urlencode(query))
            batch = page["result"]["buckets"]
            require(type(batch) is list and len(batch) <= PAGE_SIZE, "Invalid R2 bucket page")
            rows.extend(batch)
            cursor = (page.get("result_info") or {}).get("cursor")
            if cursor is None or cursor == "":
                require(len(batch) < PAGE_SIZE, "R2 bucket listing omitted its continuation")
                return rows
            require(type(cursor) is str and cursor not in cursors and batch,
                    "Invalid R2 bucket continuation")
            cursors.add(cursor)
        raise Refused("R2 bucket inventory exceeded its page bound")

    def notification_targets(self, bucket):
        require(WORKER.fullmatch(bucket), "Invalid exact R2 notification source")
        result = self.result(f"event_notifications/r2/{bucket}/configuration", empty_notifications=True)
        if result is None:
            return set()
        require(result["bucketName"] == bucket and type(result["queues"]) is list,
                "Incomplete R2 notification source")
        targets = {row["queueId"] for row in result["queues"]}
        require(all(isinstance(key, str) and HEX_ID.fullmatch(key) for key in targets),
                "Invalid R2 notification queue target")
        return targets

    def objects(self, name):
        require(WORKER.fullmatch(name), "Invalid exact R2 bucket name")
        cursor, rows, seen, cursors = None, [], set(), set()
        for _ in range(MAX_PAGES):
            args = {"per_page": PAGE_SIZE}
            if cursor is not None:
                args["cursor"] = cursor
            page = self.request(f"r2/buckets/{name}/objects?" + urlencode(args))
            batch, info = page["result"], page.get("result_info") or {}
            require(type(batch) is list and type(info) is dict and len(batch) <= PAGE_SIZE,
                    "Invalid R2 object page")
            for row in batch:
                key, etag, size, modified = [row[k] for k in ("key", "etag", "size", "last_modified")]
                require(isinstance(key, str) and key and key not in seen and isinstance(etag, str)
                        and etag and type(size) is int and size >= 0 and isinstance(modified, str),
                        "Invalid or duplicate R2 object metadata")
                seen.add(key)
                rows.append([key, etag, size, modified])
            cursor = info.get("cursor")
            if cursor is None:
                require(info.get("is_truncated") is not True and
                        (info.get("is_truncated") is False or len(batch) < PAGE_SIZE),
                        "R2 object listing omitted its continuation")
                return sorted(rows)
            require(isinstance(cursor, str) and cursor and cursor not in cursors and batch,
                    "Invalid R2 object continuation")
            cursors.add(cursor)
        raise Refused("R2 object inventory exceeded its page bound")

    def census(self, database):
        require(UUID.fullmatch(database), "Invalid exact D1 database identity")
        statements = self.result(f"d1/database/{database}/query", method="POST",
                                 body={"sql": SQL.read_text(encoding="utf-8")})
        require(type(statements) is list and len(statements) == 1, "D1 census did not share one snapshot")
        statement, = statements
        require(statement.get("success") is True and statement["meta"]["rows_written"] == 0,
                "D1 inventory did not prove a read-only census")
        rows = statement["results"]
        require(len(rows) == len(CENSUS) and {r["source"] for r in rows} == CENSUS,
                "Missing D1 census source")
        for row in rows:
            seen, complete, attention = [row[k] for k in ("rows_up_to_limit", "complete", "attention_rows")]
            require(type(seen) is int and 0 <= seen <= 1000 and complete == 1 and
                    type(attention) is int and 0 <= attention <= seen, "Incomplete legacy census")
        return sorted(rows, key=lambda row: row["source"])

    def verify_public_health(self, opening):
        request = Request("https://api.fidyapp.com/health", method="GET")
        try:
            with self.http.open(request, timeout=20) as response:
                raw = response.read(4097)
        except HTTPError:
            raise Refused("Canonical public health refused") from None
        require(len(raw) <= 4096, "Invalid canonical public health")
        result = json.loads(raw)
        require(result.get("status") == "available" and result.get("gitRevision") == opening["revision"] and
                result.get("contractDigest") == opening["contractDigest"], "Canonical public release changed")

    def multipart_clear(self, bucket):
        access = os.environ.get("RETIREMENT_R2_ACCESS_KEY_ID")
        secret = os.environ.get("RETIREMENT_R2_SECRET_ACCESS_KEY")
        if not access or not secret:
            return None
        require(WORKER.fullmatch(bucket), "Invalid exact R2 multipart inventory target")
        credentials = {"PATH": os.environ["PATH"], "HOME": os.environ["HOME"],
                       "AWS_ACCESS_KEY_ID": access, "AWS_SECRET_ACCESS_KEY": secret,
                       "AWS_REGION": "auto", "AWS_PAGER": "", "AWS_EC2_METADATA_DISABLED": "true"}
        try:
            reply = subprocess.run(
                ["aws", "s3api", "list-multipart-uploads", "--bucket", bucket, "--max-uploads", "1",
                 "--no-paginate", "--endpoint-url", f"https://{self.account}.r2.cloudflarestorage.com"],
                env=credentials, capture_output=True, check=True, timeout=30
            )
        except (subprocess.SubprocessError, OSError):
            raise Refused("R2 multipart inspection refused") from None
        result = json.loads(reply.stdout)
        require(type(result.get("IsTruncated")) is bool, "Incomplete R2 multipart inventory")
        return not result["IsTruncated"] and result.get("Uploads", []) == []

    def delete_object(self, bucket, key):
        require(WORKER.fullmatch(bucket) and isinstance(key, str) and key and
                all(part not in {"", ".", ".."} for part in key.split("/")),
                "Unsafe exact R2 object address")
        self.request(f"r2/buckets/{bucket}/objects/" + quote(key, safe="/"), method="DELETE", absent=True)

    def delete(self, kind, key):
        paths = {
            "databases": "d1/database/",
            "workers": "workers/scripts/",
            "queues": "queues/",
            "workflows": "workflows/",
            "buckets": "r2/buckets/",
        }
        pattern = {"databases": UUID, "queues": HEX_ID}.get(kind, WORKER)
        require(kind in paths and pattern.fullmatch(key), "Invalid exact retirement address")
        return self.request(paths[kind] + quote(key, safe=""), method="DELETE", absent=True)
