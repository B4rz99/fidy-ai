---
id: 008
title: "Decide: third-party agent auth & scoping"
label: wayfinder:grilling
status: open
assignee:
blocked-by: [003]
---

## Question

How does a user's *own* agent (Claude Code, an MCP client, a script) get access to that user's data — and only theirs?

- Token issuance flow (OAuth device flow? CLI login? MCP auth spec as of 2026?).
- Scope model: read vs write vs dashboard-edit; per-agent revocation.
- Rate/abuse controls for programmatic access.
- Any consent/logging obligations surfaced by regulation research (003).
