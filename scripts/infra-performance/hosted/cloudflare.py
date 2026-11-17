"""Bounded account analytics and D1 API transport for the disposable fixture."""
import datetime as dt
import json
import os
import re
import subprocess
from urllib.error import HTTPError
from urllib.request import build_opener, HTTPRedirectHandler, Request


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def command(args, cwd):
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=45)
    if proc.returncode:
        # Wrangler output can contain credentials; never include it in diagnostics.
        raise RuntimeError(f"{args[0]} could not provide the configured Cloudflare credential or account")
    return proc.stdout.strip()


class Cloudflare:
    def __init__(self, root):
        self.account = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or command(
            ["gh", "variable", "get", "CLOUDFLARE_ACCOUNT_ID", "--repo", "B4rz99/fidy-ai"], root)
        if not re.fullmatch("[0-9a-f]{32}", self.account):
            raise RuntimeError("Invalid Cloudflare account ID")
        self.token = os.environ.get("CLOUDFLARE_API_TOKEN")
        if not self.token:
            credentials = json.loads(command(["node", "node_modules/wrangler/bin/wrangler.js", "auth", "token", "--json"], root))
            self.token = next((value for key, value in credentials.items()
                               if key.lower().replace("_", "") in {"token","apitoken","oauthtoken","accesstoken"}
                               and isinstance(value, str) and value), None)
        if not self.token:
            raise RuntimeError("Cloudflare authentication unavailable")
        self.opener = build_opener(NoRedirects())

    def call(self, method, path, data=None):
        request = Request("https://api.cloudflare.com/client/v4/" + path, method=method,
                          headers={"authorization": "Bearer " + self.token, "content-type": "application/json"},
                          data=json.dumps(data).encode() if data is not None else None)
        try:
            with self.opener.open(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            raise RuntimeError(f"Cloudflare returned HTTP {error.code}") from None


def count(value):
    if type(value) is not int or value < 0 or value > 2**53 - 1:
        raise RuntimeError("Missing or invalid D1 row counters")
    return value


def observe(api):
    start = dt.datetime.now(dt.timezone.utc)
    day = start.date().isoformat()
    query = """query($account:String!, $day:Date!){viewer{accounts(filter:{accountTag:$account}){
      d1AnalyticsAdaptiveGroups(limit:1,filter:{date:$day}){sum{rowsRead rowsWritten}}}}}"""
    data = api.call("POST", "graphql", {"query":query,"variables":{"account":api.account, "day":day}})
    if data.get("errors"):
        raise RuntimeError("Cloudflare account analytics unavailable")
    try:
        account, = data["data"]["viewer"]["accounts"]
        group, = account["d1AnalyticsAdaptiveGroups"]
        counters = {k:count(group["sum"][k]) for k in ("rowsRead","rowsWritten")}
    except (KeyError, ValueError, TypeError):
        raise RuntimeError("Missing account-wide D1 observation") from None
    return {"accountId":api.account, "utcDate":day,"observedAtEpochMs":int(start.timestamp()*1000), **counters}
