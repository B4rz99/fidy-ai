# Throwaway infrastructure topology probes

These probes answer whether fewer remote storage units, colocated SQL, sharding, or a different
recovery authority merit full application experiments. They are not implementation candidates.

Run from the repository root with its frozen dependencies installed:

```sh
node reports/performance/infra-topology-2026-11-08/native.mjs
bun reports/performance/infra-topology-2026-11-08/conventional.ts
node reports/performance/infra-topology-2026-11-08/transport.mjs
```

`native.mjs` uses isolated local workerd D1, R2 and SQLite Durable Objects. It compares one, two
and three guarded D1 units, a service-binding hop, a D1 Session, coordination in front of D1,
colocated Durable Object SQLite, and an independent SQLite Durable Object recovery registry.
It also compares twenty-call bursts against shared and isolated stores. Fixtures contain only
synthetic integer Money-like values and grants; they are not Fidy's domain schema. The checks
cover equal projections, refusal without Audit side effects, recovery-generation mismatch,
missing recovery authority and explicit recovery. They do not prove Fidy's complete authority,
Consent, erasure history, credential lookup, uniqueness, cancellation or migration behavior.
D1 replication and real Cloudflare placement cannot be established in local emulation.

`conventional.ts` measures a separate local HTTP/SQLite arrangement with 1,000 and 100,000
synthetic rows. Its independent generation file is a local control, not proof of a production
recovery service or independent disaster recovery. It creates and removes its own scratch files.

`transport.mjs` makes low-volume public HTTP/2 requests to health and static assets. It never
reads authenticated information. It records timing, fixed paths, encoding, cache status and edge;
trace output is restricted to country and colo and never retains IP or other trace fields.
It does not measure a complete view or establish a representative Colombian connection.

For an isolated hosted R2-only placement comparison, first run:

```sh
node reports/performance/infra-topology-2026-11-08/r2-native.mjs
python3 reports/performance/infra-topology-2026-11-08/r2-remote.py
```

This last command provisions three temporary token-protected Workers and one scratch R2 bucket
using existing Wrangler authorization. It has a 240-request ceiling, a two-hour authorization
expiry on the Worker, and cleanup with independent inventory verification. It binds no D1,
application Worker, production bucket or customer data. Inspect the final inventory's cleanup
verdict before considering the experiment complete. Do not deploy the broader native worker as
an application. Hosted application/D1 experiments require the existing account-wide budget
preflight; `budget-check.py` records that decision without weakening it.

Generated measurements stay ignored. Publish dated evidence and remaining work to the linked
GitHub issue. Keep this code on its prototype branch; do not merge it into production.
