---
id: 010
title: "Decide: pricing model & free-tier boundary"
label: wayfinder:grilling
status: open
assignee:
blocked-by: [004]
---

## Question

With pricing-model research (004) in hand, lock the freemium design:

- The paid unit: flat tier, usage/agent-call credits, or hybrid.
- The free-tier boundary: what a free user gets (manual tracking? dashboard? limited agent messages?).
- COP price points and how LLM cost per user stays bounded.
- Whether payments ship in the MVP or fast-follow (pulls ticket 005's findings in when relevant).

**Constraint from [Decide: hosted agent architecture](007-decide-hosted-agent-architecture.md) (decision 2):** LLM cost per user is bounded at **US$1.50/paying user/month hard cap (alert at $1.00), free tier ~US$0.10/user/month**, with expected blended reality ~US$0.20 on gpt-5.4-nano-only. Pricing design takes these as given; there is no escalation model tier whose cost needs pricing in.
