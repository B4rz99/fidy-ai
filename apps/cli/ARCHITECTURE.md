# CLI architecture

`@fidy/cli` is a Bun-only User-facing presentation application, not a domain or authorization
implementation. Its surface is `login`, `status`, local `logout`, and server-derived canonical
queries, mutations and ordered atomic batches, in Spanish. It owns one saved login, with no
profiles, pasted PATs, passwords or headless credential provisioning. Friendly scalar flags derive
from the canonical encoded input schema; structured file/stdin input remains the complete contract.

`support-recovery` is a separate private operator command, outside canonical discovery and saved PAT
authority. It collects no User identity or browser-private verifier. Cloudflare Access authenticates
the operator; the existing Worker resolves the stable User, consumes proof and approves the pairing.
Only Browser Login creates a WebSession. See [operator evidence](src/support-recovery/FEATURE.md).

## Runtime and execution

The reviewed runtime is Bun `1.4.3-canary.1`, full revision
`13a98b0dbd136bcc5c98a8adfb53c909aa3183cc`. Run `bash scripts/install-bun.sh`, then put the reported
directory first on PATH. `bun run cli login` prompts for the exact recipient, non-empty unique
scope set and fixed lifetime. Explicit non-secret arguments are also supported:

```sh
bun run cli login --recipient 'Mi agente' --scopes read --lifetime 7
bun run cli status --json
bun run cli logout
bun run cli commands --json
bun run cli categories listCategories --json
bun run cli transactions listTransactions --help
bun run cli transactions listTransactions --currency COP --json
bun run cli transactions createTransaction --amount 25000 --currency COP --direction outflow \
  --occurred-at 2026-01-01T12:00:00.000Z --json
bun run cli transactions listTransactions --input request.json --json
# request.json: {"query":{"currency":"COP"}}
# --input - reads stdin instead; it cannot be combined with a file.
bun run cli transactions createTransaction --input transaction.json --json
bun run cli dashboard initializeDashboard --json
bun run cli dashboard applyDashboardEdit --input edit.json --json
bun run cli operations executeAtomicBatch --input batch.json --json
# edit.json: {"payload":{"op":"set-title","title":"Mi tablero"}}
# batch.json: {"payload":{"calls":[{"callId":"01900000-0000-4000-8000-000000000001",
#   "operation":"dashboard.applyDashboardEdit","input":{"payload":{"op":"set-title","title":"Mi tablero"}}}]}}
```

The CLI refuses another runtime revision before accessing credentials. The installer uses
a retained repository release and reviewed SHA-256 digests; it never trusts the moving `canary` URL.
If upstream removes an asset, installation fails closed rather than silently moving to a new
runtime. Supported installer targets are macOS, glibc Linux and Windows (Git Bash), x64 and arm64.
The x64 build requires AVX2. Runtime upgrades are deliberate source changes. Until a verified
stable release supplies local-only Windows persistence, retain all six checksum-verified upstream
archives in a versioned repository release before refreshing the canary pin; each refresh updates all platform digests, exact revision,
installer/CI paths and recovery guidance, then reruns native conformance and the full CI gate.

The workspace builds server declarations before CLI/web and bundles the executable for Bun.
Repository ownership/dependency checks include CLI files, and CI runs its build, focused behavior
suite and real-public/Core/browser journey. Cloudflare remains the sole server runtime authority.

## Owners and publication

- `command/contract.ts` declares safe output; `operations.ts` interprets local commands and
  its private presentation vocabulary supports Spanish human/JSON output. Recipient metadata is
  JSON-escaped, including C1 and bidirectional controls, even in human output. JSON mode emits
  one safe event per stdout line; interactive prompts use stderr.
- `login/operations.ts` owns a single non-resumable pairing, with only public progress and safe
  persisted grant facts escaping. Grant input and output derive from server schemas.
- `direct-client/runtime.ts` constructs `HttpApiClient` from the server-published `PATPairingApi`.
  It also owns the fixed-origin bounded transport seam handed to #970. It does not copy routes,
  protocol schemas or canonical policy. The direct API remains outside stable-User canonical work.
- `canonical/operations.ts` owns policy-derived discovery, whole-input decoding, generic invocation,
  canonical result encoding and terminal-safe presentation. `canonical/runtime.ts` constructs one
  credential-bound generated client per invocation and owns bounded file/stdin consumption.
  Runtime dispatch has one narrow typed bridge; the selected canonical input codec checks the
  complete request before it reaches the client and its result/failure codec encodes the output.
  The catalog includes middleware failures, so expired/revoked authority and Consent refusal use
  the same canonical envelopes as ordinary declared failures. No suggestion is executed.
- `credential/contract.ts` declares `load`, `save`, `clear`, `Option` absence and redacted bearer
  values. `runtime.ts` owns native/file persistence. `main.ts` alone composes production adapters,
  process arguments, OS home and interruption handling.
- `support-recovery` owns argument-free interactive presentation, hidden bounded key input and
  one-decision certainty. Its runtime captures a bounded Access assertion from scoped `cloudflared`
  children and reuses the fixed-origin bounded HTTP policy. The command runs before home/native
  store construction, has no local recovery authority, accepts no raw proof flags and never retries.

The CLI consumes only `@fidy/server/client`, never private server/native implementation.
Expected transport/storage rejections become closed local failures. Neither raw causes nor HTTP
objects are diagnostic values. Existing server Work observation plus closed local progress/failure
output suffices for this short workflow; no client tracing exporter, URL tracing, content telemetry
or automatic trace propagation is enabled.

## Credential exception and local persistence

The **local native credential store is an intentional recoverable-bearer exception**. The server
continues to persist digests only. Bun.secrets is the only raw-bearer persistence adapter. Application
values remain Redacted until native storage or the narrow HTTP authorization adapter needs plaintext.
There is no file/environment fallback. macOS uses Keychain, Linux requires a running Secret Service,
and Windows uses Credential Manager with explicit `persist: "local"`.

Bun 1.4.1 and 1.4.2 hardcode Windows roaming-capable persistence. The pinned build includes upstream
[1016a7a](https://github.com/oven-sh/bun/commit/1016a7afb04a24098e9530d9a95b91d482d17f20), which adds the
local-only option. See the [official API](https://bun.sh/docs/runtime/secrets) and the pinned
[Windows implementation](https://github.com/oven-sh/bun/blob/13a98b0dbd136bcc5c98a8adfb53c909aa3183cc/src/jsc/bindings/SecretsWindows.cpp).
This API is experimental; native-provider evidence is distinct from deterministic adapter fixtures.

One fixed native service is qualified by `https://api.fidyapp.com`. Safe schema-validated grant
metadata lives in the OS User's home under `.fidy/cli/grant.json`. A lock directory serializes local
load/save/clear and usability probes. UNIX directories/files are private. Metadata and bearer must
both exist and have matching short id; partial persistence is inconsistent, not a usable login.
Logout can clear inconsistent access. A crash may leave `login.lock`; remove it only after ensuring
no other instance is active. The CLI does not automatically steal a lock or overwrite a saved login.

Native operations have no cancellation API. Once begun they settle under an uninterruptible owned
persistence section, so an interrupted caller does not abandon a pending save or release its lock
prematurely. Preflight verifies native set/get/delete and metadata write usability before starting a
pairing, but a later failure remains possible and never reports login success.

## Transport, claim certainty and lifetime

Operation help and `commands --json` reflect identities, descriptions and JSON schemas from the
assembled server catalog, including access, kind and confirmation metadata. Saved scopes select
eligible presentation only. `write` and `dashboard` remain independent; a `read`-only grant exposes
no mutations or batches. Account-security operations that exclude PATs are unavailable even through
direct selection or raw batch input. The server independently checks every call.
Queries with no input require no file or invented payload; other queries take their canonical
nested `{params, query, payload, headers}` shape from one explicit file/stdin source or generated
scalar flags. `--help` and machine discovery include each flag's canonical path, required status,
encoded constraints (including descriptions and literal choices), structured-only fields and naming
policy. Omission lets the canonical decoder apply defaults; the CLI never invents them.

Flag names use unique leaf names in kebab-case. All colliding suffixes grow together using the
nearest meaningful parent; top-level transport prefixes are a last resort. `input`, `help` and
`json` are reserved. If full paths still collide, the operation falls back to structured input.
Derivation traverses ordinary objects and local schema references to depth eight and exposes at
most 24 scalars. Numeric/boolean encoded types and strings with enum, format or a pattern without
whitespace character classes are eligible; a scalar-or-null union is eligible for its scalar
representation. Other unions, arrays, unconstrained/free-text strings and deeper shapes remain
structured-only. This is a deterministic encoded-shape policy, not semantic prose classification.
Required structured-only fields mean the whole invocation needs file/stdin; optional ones can be
omitted but cannot be overridden with flags. Potentially sensitive/free-text input belongs in
file/stdin to avoid shell-history disclosure. Typed credential bootstrap is never a canonical flag.

Field flags require separate `--name value` pairs, including `true`/`false` for booleans; there are
no implicit booleans, aliases, positional values or `--name=value` syntax. Unknown, duplicate or
ambiguous names and mixing operation flags with `--input` fail before any file read or remote
execution. Empty strings, false and zero remain explicit values; omitted fields stay omitted.
The CLI assembles required containers and supplied nested fields, then crosses the same complete
canonical decoder and generated-client path as JSON. Money and branded/date text remain encoded
strings until that decoder. Input-free commands stay input-free; optional query filters can all be
omitted. Parser work is bounded to 50 arguments of 256 characters each.
Input is limited to 64 KiB, responses to 1 MiB, and both have 15-second deadlines. Money remains
exact decimal text; DateTime and Option values cross the selected canonical JSON codec rather
than being stringified as runtime objects. Machine stdout contains one canonical envelope;
human stdout adds Spanish result/failure labels. Retry-After and guidance use stderr. Declared
failure codes/messages and partial SuggestedOperation arguments remain in the envelope. Only
eligible operations receive executable next-call guidance; no suggestion bypasses input decoding.
Failures exit nonzero without silent login, retries or commercial-allowance inference.
Existing server metadata-only Work observation suffices for these synchronous canonical workflows;
no client content tracing is added. Transport captures bounded Retry-After metadata before success/error decoding and
retains no raw response or cause for diagnostics.

Canonical allowance display consumes the server-published `CanonicalAllowance` codec and
`canonicalAllowanceHeaders` names. Transport projects only `Fidy-Canonical-Allowance`,
`Fidy-Canonical-Limit`, `Fidy-Canonical-Remaining` and `Fidy-Canonical-Reset`, with bounded header
text and runtime decoding before presentation. Projection precedes typed success/error decoding:
Effect's `decoded-and-response` mode returns only after successful decoding and cannot preserve
metadata on its own for declared failures. Valid Free standing displays remaining/limit, shared-PAT
meaning and an exact ISO UTC reset on stderr; `uncapped` displays no monthly counter or reset,
while explicitly retaining security protections. Missing, malformed or unpublished standing is
unavailable, never zero. `quota_exhausted`, `rate_limited` and `paywall_required` receive distinct
guidance, and only Retry-After supplies a request delay. Canonical JSON stdout remains one unchanged
envelope: there is no extra metadata JSON mode or appended domain field. There is no local balance,
automatic quota query, retry or telemetry. Explicit `quota getQuota` derives from the ordinary
canonical declaration and retains the server's unmetered, security-protected semantics.

Atomic input uses the server-owned non-empty ordered child union and declared maximum of twelve
calls, with caller-chosen UUID `callId` correlation. Each child's schema, eligibility and scope are
checked locally, then current server authority, tier, Consent, domain policy and atomicity are
rechecked authoritatively. The envelope is not a grant. Queries, recursive batches, standalone
mutations and browser-only children cannot gain authority through it. The broad canonical child
schema remains the decoding contract; batch help projects eligible child input/result alternatives
through the server owner's same schema builder and limits, without rebinding the canonical codecs
or introducing an independent CLI child-policy map. Children cannot read earlier
children's writes. Retained-owner collision and statement/Dashboard-child restrictions remain
server decisions, not CLI sequencing promises. Child-addressed failures retain `failedCallIndex`,
operation and field issues, and explain whole-domain rollback without denying rejected-call Audit.

Canonical requests are bounded to 64 KiB locally; server per-child and whole-batch limits still
apply. Mutation transport loss, malformed/unexpected responses, deadlines and interruption can
follow a commit. They report uncertainty, never a no-effect claim or an automatic replay. Locally
owned work is cancelled on interruption, without claiming server rollback. Recovery directs the
User to inspect current state or use only the operation's explicitly retry-safe protocol, preserving
caller-supplied retry identities without generating or replaying them. Unindexed server failures
do not imply rollback. A successful envelope means only its declared result: durable acceptance
is not necessarily completed asynchronous work. Hosted confirmation metadata never grants the CLI
browser or hosted-session authority.

Both fresh and saved access are bound to the fixed production API origin. There is no API-origin
argument or environment override. The only displayed approval URL is
`https://fidyapp.com/settings/pats`; proof and PAT never enter URLs, browser state or arguments.

The transport refuses redirects, omits ambient cookies, bounds requests and streamed response bytes,
and owns a 15-second deadline. Login sleeps on advertised cadence, honors `PollingDelayed` without
implying reduced scopes, never lowers the advertised cadence for a shorter retry hint, and stops
at the pairing deadline. A second, local work budget derives from the server's ten-minute pairing
lifetime plus a single request deadline; hostile expiry/cadence cannot cause an unbounded loop or
an overflowing native timer. SIGINT/SIGTERM interrupts Effect work;
HTTP request/reader ownership cancels the underlying work. Proof remains in memory and is never
resumed after restart. No transport or claim retry is automatic.

A lost claim response is ambiguous because the server may have consumed its one-time disclosure.
Post-claim storage failure is similarly non-recoverable. Both direct the User to review/revoke the
grant in the authenticated web app and begin a new pairing; neither rediscloses a bearer or silently
replays a claim. Approval fixes expiration. Claim and use never renew it.

Status reports only local availability, safe grant facts and local expiry, explicitly without fresh
remote verification. Logout removes local access; it never invokes PAT management or claims server
revocation. PAT callers still have no PAT-management authority.

## Test seams

Focused tests exercise public login orchestration with TestClock, native/file store construction,
derived-client transport, and command output. Real-filesystem adapter tests cover metadata mismatch,
origin substitution and partial persistence. Cancellation/overflow tests assert owned reader cleanup,
not only fiber termination. Test-only process ownership in `test/process.test-fixture.ts` also
settles each real child and closes its reader on interruption; native conformance and browser
acceptance share this seam rather than starting detached processes. `bun run --cwd apps/cli test:native` checks actual cross-process native
persistence. Linux browser CI runs inside an unlocked DBus/Secret Service session. The browser gate runs the
shared suite and then `bun run --cwd apps/web test:browser:cli` with a fresh, dedicated public/Core
and D1 topology; the shared suite excludes the CLI mutation journey so other journeys cannot alter
its exact query results or Audit evidence. Separate macOS and Windows native jobs are required
whenever unit verification is selected. A dedicated Linux packaging job runs
`bun run --cwd apps/cli build:native` to bundle that same native probe and real credential adapter,
with its Windows persistence script beside the bundle. The macOS/Windows jobs download only this
same-run artifact and install the pinned Bun runtime, not workspace dependencies; packaging and
native jobs all participate in the fail-closed merge gate. The one-minute conformance-step deadline
remains independent of setup. Windows additionally reads the native credential's persistence enum
(never its blob) and requires local-machine storage.

`test/journey-entry.ts` is an explicitly broad test composition. It runs the same command/login/store
and derived-client behavior in separate Bun processes with an isolated real native service. Only its
raw transport maps the fixed production origin onto the existing loopback public/Core topology. It
is not bundled, exported, or reachable from production main. Browser acceptance approves the public
code through the existing fresh web UI, then verifies second-process status and authorized query
reuse through Category listing and Transaction browsing, exact-Money Transaction creation,
Dashboard initialization/edit and an ordered mixed-owner batch. A loopback-only bounded metadata
observer proves attributable accepted PAT Audit for each mutation child; it is never part of
public ingress. Public/Core negative cases prove independent scopes, cross-User refusal and
whole-domain rollback. No production test-only issuance route exists. Secrets are excluded from
traces, screenshots, video and subprocess output.

`test/allowance-entry.ts` is a separate test-only process composition. The server's Canonical Admission
integration tests feed actual D1-backed response bodies and allowlisted headers into this process;
its synthetic credential and replaced transport invoke the same generated client, decoding and
stderr/stdout presentation as production. It proves Free success, exhausted and declared-failure
metadata, shared-PAT replay standing, Trial uncapped standing and security refusal. This is local
server-adapter-to-CLI evidence, not a live ingress/provider or Production test.
