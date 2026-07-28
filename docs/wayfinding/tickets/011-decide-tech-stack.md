---
id: 011
title: "Decide: tech stack beyond TypeScript + Effect-TS"
label: wayfinder:grilling
status: closed
assignee: obarboza
blocked-by: [001, 002, 007]
resolved: 2026-07-23
---

## Question

Lock the remaining stack, informed by the SDK landscapes from 001/002 and the agent architecture from 007:

- Web framework for the dashboard app; how the dashboard document renders.
- API framework (Effect platform? tRPC-style? plain HTTP) and how CLI + MCP server wrap it.
- Database and schema approach for transactions/budgets/dashboard documents.
- Hosting/deployment target; WhatsApp webhook ingress.
- Statement/receipt parsing pipeline (LLM-based vs library-assisted).

## Resolution (2026-07-23)

Grilled with obarboza; eight decisions locked.

### 1. API framework: `@effect/platform` HttpApi

- Canonical operations defined once as Effect Schema operation definitions; the HTTP server, fully-typed client (consumed by the CLI and the agent toolkit), and OpenAPI spec are all derived from them — ticket 007's parity rule enforced by construction.
- tRPC rejected (own API definition system, second-class Effect); manually implemented HTTP rejected (no derivation, parity drifts). Accepted cost: `@effect/platform` pre-1.0 API churn.

### 2. Runtime: Bun

- `@effect/platform-bun` end-to-end; `@effect/sql-pg` rides the pure-JS `postgres` driver, which runs on Bun. No native-module dependencies remain in the stack (PNG rendering dropped, PDF decryption is WASM).
- Node is a one-import escape hatch (`BunHttpServer` → `NodeHttpServer`) if Bun misbehaves.

### 3. Database: PostgreSQL only, via `@effect/sql-pg`

- **One store, no Redis at MVP**: relational core (transactions, budgets, attestations); JSONB for dashboard documents and raw payloads (Schema-validated at the boundary); insert-only tables for the append-only ledgers (consent, audit, proactive events); Postgres-backed job queues (per-user serialization, ingest processing, corpus expiry).
- **Access layer: `@effect/sql-pg` + Effect Schema row models + Effect Migrator.** Hand-written SQL with every row decoded through Schema — one schema language across API operation schemas, rows, and tool definitions. Drizzle rejected after weighing: its compile-time query checking duplicates what Schema decode gives at runtime, while its table defs are a second source of truth (the drift 007 exists to kill); Prisma rejected outright.
- Accepted costs: SQL typos surface at decode time (runtime, loudly), migrations are hand-written sequential files with no diff tooling.

### 4. Web app: Vite + React SPA

- **No meta-framework.** An authenticated Spanish-only dashboard has no SEO/SSR need, and a pure SPA cannot cheat around the canonical API — it consumes the derived HttpApi client like every other agent, keeping "web UI is just another client" true by construction.
- **Tailwind + shadcn/ui** (vendored Radix components) for UI; **Recharts through shadcn's chart wrappers** renders the dashboard document's widgets (theming via shadcn CSS variables, dark mode included); **TanStack Router + TanStack Query** over the derived Effect client.
- Served as static files from the API container — no second runtime.

### 5. Scope amendment to 007: no chart images to WhatsApp at MVP

- The canonical "render widget/query as PNG" endpoint promised in ticket 007 is **out of MVP** — server-side chart rendering (ECharts SSR / headless browsers) judged complexity-not-worth-it. The hosted agent answers with text/numbers over WhatsApp (consistent with 014's text-only templates).
- Not foreclosed: a future effort can add it as a new canonical endpoint; nothing in the client-side chart choice blocks it.

### 6. Hosting: single-process modular monolith on Railway

- **One deployable**: one long-running Bun process in one Effect runtime — HTTP API, webhook handlers (Kapso, Wompi, Resend), agent loop, queue workers, static SPA files. The per-user 2–3s debounce/serialization forced a persistent process (serverless ruled out); split services earn nothing at MVP scale.
- **Railway, Hobby plan ($5/mo incl. $5 usage)** with Railway Postgres and cron. Expected real bill ~US$8–15/mo early on. Fly.io (Bogotá region) passed over — chat latency is LLM-dominated, webhooks async, ops fiddlier. Escape hatch: it's a Dockerfile + `pg_dump`.

### 7. Email ingress: Resend (inbound + outbound)

- Per-user ingest addresses (006) via Resend inbound — MX to Resend, parsed JSON webhooks to the monolith. Free tier (3k emails/mo, 100/day) covers ~20–30 forwarding users; Pro US$20/mo covers ~300. Outbound (013's email recovery) on the same account.
- Fallback documented: Cloudflare Email Routing + a dumb relay Worker (free at any volume) behind the same webhook handler; SES inbound rejected (S3/SNS/Lambda plumbing), Postmark strictly dominated (eval-only free tier).

### 8. Statement/receipt parsing: LLM-first, deterministic assists only

- **PDF statements → OpenAI natively** (Responses API PDF input; layout-aware, so bank tables survive — local text extraction rejected for flattening tables). **`mupdf` (WASM)** kept solely to decrypt password-protected statements in-memory per 006's used-once-never-stored rule.
- **CSV/XLSX → deterministic rows** (Papa Parse / SheetJS); nano makes one column-mapping call per bank format, then rows flow mechanically. No LLM-per-row.
- **Receipt photos/screenshots → nano vision** straight from Kapso media.
- **Every path ends in structured outputs whose JSON Schema is generated (`JSONSchema.make`) from the same canonical Effect Schema Transaction schema**, and responses are decoded back through it — a malformed extraction cannot enter the system; it fails decode into needs-review. No OCR stack, no table-extraction libraries.
