---
id: 012
title: "Task: assemble the MVP spec"
label: wayfinder:task
status: closed
assignee: obarboza
blocked-by: [006, 007, 008, 009, 010, 011, 013, 014, 016]
resolved: 2026-07-23
---

## Question

The destination ticket. With every decision closed, assemble the buildable MVP spec: product scope, ingestion design, agent architecture, agent-facing surface (API/CLI/MCP), dashboard-document model, pricing, compliance posture, and stack — one document, ready to hand to implementation sessions. Resolution closes the map.

## Resolution (2026-07-23)

**Asset: [`SPEC.md`](../../SPEC.md)** at the repo root — the buildable MVP spec, assembled from all nine closed decision tickets plus the five research findings. Thirteen sections: product scope, identity/onboarding/consent, compliance posture, ingestion, canonical API conventions, third-party auth & scoping, hosted agent, proactivity, dashboard document model, pricing & billing, tech stack & deployment, a consolidated domain-entity list, and an explicit "open items for the build" section.

Notes on assembly:

- Every design statement links back to the ticket or research doc that holds its rationale — the spec is the synthesis, the tickets stay the provenance.
- The map's remaining **Not yet specified** fog (category taxonomy detail, recurring-detection approach, product naming/brand) was deliberately deferred by the tickets themselves as build-time work, not decisions blocking the way — it's carried into the spec as **§13 Open items for the build**, alongside the dashboard-DSL hardening list from ticket 009 and the config knobs the decisions left as tunables.
- Launch gates (lawyer review of the política, Wompi KYB) are recorded in §13 as gates, not build blockers. [Task: Wompi merchant onboarding prerequisites](015-task-wompi-onboarding-prereqs.md) remains open in parallel — it gates launch billing, not implementation.

**This resolution closes the map.** The way is clear: implementation sessions start from `SPEC.md`.
