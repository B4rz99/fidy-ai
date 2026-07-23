---
id: 004
title: "Research: pricing models for agent-first consumer products"
label: wayfinder:research
status: closed
assignee: research-subagent (fired at charting, 2026-07-22)
blocked-by: []
resolved: 2026-07-22
---

## Question

What pricing models exist for AI/agent-first consumer products, and which fit a freemium PFM whose costs scale with agent usage?

1. Survey real examples: flat subscription (Monarch ~$100/yr), usage/credit-based (per-message, per-action), hybrid tiers with usage caps, "pay for the agent, data free" splits.
2. Unit economics framing: how products keep LLM cost per user bounded (caps, model routing, batching).
3. Colombian consumer context: willingness-to-pay reference points for local subscriptions (streaming, Nequi/Daviplata fee tolerance), COP price anchoring.
4. Candidate freemium boundaries for this product: what's free (manual tracking? dashboard?) vs paid (agent conversations, automation, proactive insights).

## Resolution (2026-07-22)

Full findings: [research/004-pricing-models.md](../../research/004-pricing-models.md) (merged from branch `research/pricing-models`).

Three candidate models surfaced (detail and COP anchors in the doc):

1. **Flat "streaming-priced" agent tier (~COP 19,900/mo)** — free deterministic tracking/dashboard; one paid tier of unlimited-feeling agent chat behind invisible fair-use caps. Anchored between Spotify Colombia (COP 18,500) and ChatGPT Go Colombia (COP 20,900 — proof an AI subscription sells locally in that band); matches the US PFM cluster (~$95–100/yr).
2. **Two-tier "Go ladder"** — Básico ~COP 9,900 (capped agent, cheap-model routing) + Pro ~COP 24,900–29,900 (frontier reasoning, automations, proactive alerts).
3. **Subscription + top-up credits** — the dominant 2025–26 hybrid (+20–30% ARPU from heavy users), but visible credit meters are a top user complaint and risky for a trust-sensitive finance product.

Doc's recommendation (inference): launch model 1 with model 2's internal cost discipline (model routing 60–85% savings, prompt caching, rolling-window caps); hold the COP 9,900 tier in reserve. Universal boundary: **free = deterministic, paid = generative**. Nequi/Daviplata condition the market to zero fees, so the free tier must stand alone. The decision itself is ticket 010's.
