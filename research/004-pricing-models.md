# Research 004: Pricing models for agent-first consumer products

- **Ticket:** tracker/tickets/004-research-pricing-models.md
- **Date:** 2026-07-22
- **Method:** Web search/fetch, preferring 2025–2026 sources. Facts and inference are separated; anything under an "Inference" heading or tagged *(inference)* is our reasoning, not a sourced fact.

---

## 1. Pricing models in AI/agent-first consumer products (confirmed facts)

### 1a. Flat subscription (PFM incumbents)

| Product | Model | Price (2026) | Notes |
|---|---|---|---|
| Monarch Money | Flat subscription, no free tier (7-day trial) | Core $99.99/yr or $14.99/mo; Plus $199/yr | Two-tier split introduced 2026; Plus = "power user" planning |
| Copilot Money | Flat subscription, no free tier | $95/yr or $13/mo | "AI categorization" bundled in single price; iOS/Mac only |
| Origin | Flat subscription | $99/yr or $12.99/mo (heavy $1-first-year promo) | AI financial planning bundled; aggressive acquisition discounting |
| Rocket Money | Freemium + pay-what-you-want premium | Free tier + Premium $7–$14/mo (user picks) | AI subscription detection free-ish; premium unlocks cancellation, smart savings |
| Cleo (AI chat-first PFM) | Freemium + ladder of paid tiers | Plus $5.99/mo (or $44.99/yr); Pro $8.99/mo; Builder $14.99/mo | Chat assistant is the free hook; paid tiers monetize cash advances / credit building, NOT chat volume |

Key observation: Cleo — the closest existing analogue to an agent-first consumer PFM — gives the AI chat away and monetizes adjacent financial products (advances, credit builder, express-transfer fees). The US "premium tracker" cluster (Monarch/Copilot/Origin) has converged on **~$95–$100/yr ≈ $8–13/mo** with no free tier.

### 1b. General-purpose AI assistants (flat tiers with usage limits)

- ChatGPT Plus, Claude Pro, Perplexity Pro, Google AI Pro: all **~$20/mo** standard tier; $100–$200/mo power tiers (ChatGPT Pro, Claude Max, Perplexity Max).
- The $20 tier is not unlimited: ChatGPT ~150 flagship messages / 3-hour window and ~10 Deep Research runs/mo; Perplexity Pro cut to ~200 Pro queries/week and 20 Deep Research/mo; Claude uses dynamic rolling 5-hour windows ("5× free usage") with no published fixed number.
- 2026 trend: **metered credits stacked on top of subscriptions** (Gemini top-up credits, ChatGPT Codex credits, Notion Credits). Third-party analysis: "the flat monthly fee increasingly buys you the floor, not the ceiling."
- **ChatGPT Go** launched as a budget tier: **COP $20,900/mo in Colombia** (≈US$6 in South America vs <$8 in the US), distributed via a Rappi partnership (1 free month; 6 months free for Rappi Pro Black). This is the single most relevant "what does an AI subscription cost a Colombian" anchor.

### 1c. Usage/credit-based agents

- **Manus**: Free (300 daily credits), $20/mo (4,000 credits), $40/mo, $200/mo. Credits burn by task complexity: simple chat 5–15 credits, complex research task 500–900 (~$3.50 plan-equivalent). Widely criticized as **unpredictable** — no upfront cost estimate, credits don't roll over.
- **Lindy**: ~$49.99/$99.99/$199.99/mo credit plans; premium-action multipliers and model-choice multipliers (frontier models burn credits faster); voice billed separately per minute.
- Recurring criticism across sources: pure credit pricing shifts cost risk to the consumer and "bills climb exactly when your agent gets useful."

### 1d. "Agent paid / data free" splits and hybrids

- **Notion** is the canonical arc: AI sold as a $8–10/user/mo add-on until May 2025 → add-on retired (converted poorly as an "optional extra") → AI bundled into the $20+ Business tier, **plus** usage credits ($10 per 1,000) for heavy agent use.
- RevenueCat's State of Subscription Apps: **35% of apps abandoned pure subscriptions for hybrid models in 2025**, with "Subscription + Tokens/Credits" dominant among AI apps, capturing 20–30% more ARPU from heavy users. Common pattern: free plan includes limited AI credits; exhausting them mid-task is the upgrade prompt.
- Freemium conversion benchmarks: consumer app freemium converts ~2.2% download-to-paid (fintech vertical ~4%); AI-native products: 6–8% considered good, 15–20% great; ChatGPT itself converts ~2–5% of WAU to paid.

---

## 2. Unit-economics practices for bounding LLM cost per user (confirmed facts)

- **The structural problem:** consumer AI pays inference on every session while most users never pay (Inworld: "cost is the wall in front of consumer AI"; only ~2% of ChatGPT users subscribe). Flat-rate pricing collides with **fat-tailed usage**: heavy users, long prompts, and multi-turn agents compress margins; multi-turn conversations re-feed full history each message, ballooning input tokens.
- **Model routing** is the most-cited lever: route classification/intent to nano models (~$0.10/M tokens), drafting to mid-tier ($1–3/M), frontier only for final reasoning ($10–15/M). Reported savings: 30–60% in mixed workloads generally; up to 60–85% with tiered 70/20/10 routing while keeping ~95% of frontier quality. Router overhead is negligible (<100 ms).
- **Prompt/context caching**: 50–90% cost reduction on cache-eligible workloads; context management (summarize/truncate history) directly attacks the multi-turn ballooning problem.
- **Caps and quotas as product design**: rolling message windows (ChatGPT 3h, Claude 5h), monthly deep-task quotas, gateway-level policies capping frontier-model calls at a percentage of traffic with real-time spend tracking. Frameworks explicitly cover "consumption cap design that preserves margin as usage scales."
- **Tailwind:** inference cost for constant quality dropped ~10×/yr (GPT-4-class ≈ $0.40/M tokens in 2026 vs $20 in 2022) — but frontier reasoning tokens remain expensive ($0.14 commodity vs $180 frontier per M), so routing discipline stays decisive.

### Inference for this product

- Free-tier features must be **deterministic (near-zero LLM cost)**: manual entry, dashboards, rule-based categorization. Any free LLM touchpoint should be strictly capped and routed to the cheapest model.
- Transaction categorization — the highest-frequency AI task in a PFM — is a classification workload: nano-model or embedding territory, roughly $0.001-order per transaction, so it can plausibly live in the free tier under a cap.
- The costly surface is **open-ended agent conversation and proactive analysis over long context** (full transaction history). That is where the paywall and the per-user cost cap must sit.
- A defensible target: keep blended inference COGS below ~20–30% of ARPU for paying users, enforced by routing + caching + a generous-but-real fair-use cap rather than visible credits.

---

## 3. Colombian consumer context (confirmed facts)

### Subscription price anchors (COP, 2025–2026)

| Reference | Price |
|---|---|
| Netflix Básico / Estándar / Premium | $18,900 / $29,900 / $44,900 per month (extra member $9,900) |
| Spotify Premium Individual | $18,500/mo (Dúo $24,500; Familiar $30,500; Estudiantes $10,100) |
| **ChatGPT Go (Colombia launch, Dec 2025)** | **$20,900/mo**, with Rappi free-month promos |
| ChatGPT Plus | US$20/mo (≈ COP 78,000–80,000) — priced in dollars, not localized |

### Fee tolerance in mass-market fintech

- **Nequi and Daviplata are free at the core**: no account fee, free P2P/Bre-B transfers, free QR receipt; Nequi Negocios has no monthly fee. Daviplata charges only at the margins (5th+ monthly withdrawal $2,000+IVA).
- The dominant "fee" conversation in 2026 is the **4×1000 tax** and new UVT-based caps — press coverage frames avoiding charges as the user's goal. The mass market is conditioned to expect **zero recurring fees** from money apps; monetization there is interchange, credit, and float, not subscriptions.
- Colombian PFM apps found in local roundups (Monefy, Goodbudget, Fintonic, MonAi, etc.) are free or low-cost freemium; **no established COP-priced PFM subscription benchmark exists** — local coverage emphasizes free apps, and bank-provided PFM (Bancolombia/Sura via Finerio Connect) is bundled free with accounts.
- Income context: 2026 minimum wage is **$1,750,905/mo** (+ $249,095 transport allowance ≈ $2,000,000 total; ≈ US$471–539).

### Inference for willingness to pay

- A "streaming-priced" subscription (~COP 18,000–30,000/mo) is the culturally established band for a valued personal digital service; ChatGPT Go at $20,900 proves an AI product can be sold in Colombia inside that band.
- Anything above ~COP 45,000/mo (Netflix Premium) exits mass-market territory; US-style $99/yr ≈ COP 33,000/mo would read as premium-niche here.
- A paid tier is a fight against a zero-fee default (Nequi/Daviplata conditioning), so the free tier must be genuinely useful and the paid tier must be framed as "an agent that works for you," not "app access."
- For a minimum-wage earner, COP 20,000/mo is ~1% of net income — plausible only for a clearly valuable service; realistic early adopters are middle-income digital natives already paying for 1–3 streaming/AI subscriptions.

---

## 4. Candidate freemium boundaries for this product (inference)

All three candidates share one boundary principle: **free = deterministic, paid = generative.** Manual tracking, dashboards, budgets, and rule/nano-model categorization are free (near-zero marginal cost, drives habit + data accumulation). Agent conversations, automation, and proactive insights — the LLM-cost-bearing surfaces — are what's sold.

### Candidate A — "Streaming-priced flat agent" (Copilot/Monarch model, localized)

- **Free:** manual tracking, dashboard, budgets, capped auto-categorization, a small monthly taste of the agent (e.g., 5 conversations/mo) as the conversion hook.
- **Paid (single tier): ~COP 19,900/mo or ~COP 159,900/yr** — anchored between Spotify ($18,500) and ChatGPT Go ($20,900). Unlimited-feeling agent chat with an invisible fair-use cap (rolling window, ChatGPT/Claude style), automation, weekly proactive insights.
- **Pros:** simplest story; matches how Colombians already buy digital services; annual plan smooths COGS. **Cons:** fat-tail risk concentrated in one tier; must enforce internal caps + routing to protect margin.

### Candidate B — "Go ladder" (two paid tiers, budget entry)

- **Free:** as above, no agent conversations (or 3/mo).
- **Básico ~COP 9,900/mo** (anchor: Netflix extra member $9,900, Spotify student $10,100): capped agent — e.g., 100 messages/mo, cheap-model routing, monthly insight digest.
- **Pro ~COP 24,900–29,900/mo** (anchor: Netflix Estándar $29,900): high/dynamic caps, frontier-model reasoning, automations, proactive alerts.
- **Pros:** ladder mirrors OpenAI's proven LatAm playbook (Go under Plus); low entry price fights the zero-fee reflex; caps make COGS per tier calculable. **Cons:** two tiers to explain; the cheap tier can cannibalize if caps are too generous.

### Candidate C — "Subscription + top-up credits" (hybrid, RevenueCat-trend model)

- **Free:** deterministic features + small monthly credit grant (e.g., enough for ~10 agent interactions), upgrade prompt fires when credits run out mid-task.
- **Paid ~COP 16,900–19,900/mo:** large monthly allowance covering ~P90 usage; heavy users buy top-up packs (e.g., COP 5,000 per pack) instead of forcing everyone to a $200-style tier.
- **Pros:** heavy-user cost is self-funding (20–30% extra ARPU per RevenueCat); cleanest margin protection. **Cons:** credit anxiety is the #1 complaint against Manus/Lindy — a trust-sensitive finance product may suffer from visible meters; mitigate by denominating in "conversations," not credits.

### Recommendation-shaped inference

Start with **Candidate A's simplicity at Candidate B's discipline**: one paid tier at ~COP 19,900/mo with hidden fair-use caps and aggressive model routing, plus a free tier whose agent taste is small and cheap-model-only. Hold Candidate B's ~COP 9,900 tier in reserve as a down-market lever once real usage distributions are known — adding a cheaper capped tier later is easy; removing credit meters or raising prices is hard.

---

## Sources

### AI/PFM product pricing
- https://www.fincomparelab.com/guides/monarch-money-pricing/
- https://getfinny.app/blog/monarch-money-pricing-2026
- https://www.thepennyhoarder.com/budgeting/monarch-money-review/
- https://www.fincomparelab.com/guides/copilot-money-pricing/
- https://www.thepennyhoarder.com/budgeting/budgeting-copilot-money-review/
- https://support.useorigin.com/hc/en-us/articles/21022711456141-How-much-does-Origin-cost
- https://www.fincomparelab.com/guides/origin-financial-pricing/
- https://www.thepennyhoarder.com/budgeting/rocket-money-review/
- https://tekpon.com/software/rocket-money/pricing/
- https://web.meetcleo.com/pricing
- https://www.fincomparelab.com/guides/cleo-pricing/
- https://lendedu.com/blog/cleo-app-review/
- https://thecollegeinvestor.com/32551/cleo-review/

### General AI assistant / agent pricing
- https://aiviewer.ai/guides/ai-pricing-comparison-2026/
- https://exploreaitogether.com/llm-usage-limits-comparison/
- https://perspectiveai.xyz/ai-pricing-guide-2026-every-plan-compared/
- https://spectrumailab.com/blog/perplexity-pro-vs-chatgpt-plus-vs-claude-pro-comparison-2026
- https://manus.im/docs/introduction/plans
- https://www.nocode.mba/articles/manus-ai-pricing
- https://www.eesel.ai/blog/manus-ai-pricing
- https://www.cloudtalk.io/blog/lindy-ai-pricing/
- https://www.ringg.ai/blogs/lindy-ai-pricing
- https://felloai.com/notion-ai-pricing/
- https://aitoolgrade.com/blog/notion-ai-pricing-2026.html

### Unit economics
- https://inworld.ai/blog/consumer-ai-cost-pricing
- https://tianpan.co/blog/2026-04-17-pricing-ai-features-unit-economics
- https://www.drivetrain.ai/post/unit-economics-of-ai-saas-companies-cfo-guide-for-managing-token-based-costs-and-margins
- https://www.requesty.ai/blog/ai-agent-cost-optimization-how-to-cut-llm-spend-by-80-percent-with-routing
- https://www.burnwise.io/blog/llm-model-routing-guide
- https://www.digitalapplied.com/blog/llm-model-routing-2026-cost-quality-optimization-engineering-guide
- https://www.cloudzero.com/blog/llm-api-pricing-comparison/
- https://www.informationdifference.com/whos-paying-for-your-prompt/

### Freemium benchmarks
- https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026/
- https://userpilot.com/blog/freemium-to-premium/
- https://www.gurustartups.com/reports/freemium-to-paid-conversion-rate-benchmarks
- https://www.saastr.com/freemium-is-back-the-ai-edition-but-youll-still-probably-need-50-million-active-users-for-freemium-to-actually-work-as-a-business-model/

### Colombian context
- https://selectra.com.co/streaming/netflix
- https://newsroom.rcnradio.com/actualidad/cuales-son-los-nuevos-precios-de-netflix-en-2026-y-de-cuanto-es-el-incremento-en-colombia
- https://www.noticiasrcn.com/tendencias/spotify-sube-de-precio-en-colombia-este-es-su-valor-923070
- https://www.elcolombiano.com/tecnologia/spotify-aumento-precio-premium-colombia-2025-NI28575923
- https://www.eltiempo.com/tecnosfera/apps/openai-lanza-chatgpt-go-en-colombia-costara-20-900-pesos-y-podra-tener-meses-gratis-con-rappi-3515980
- https://impactotic.co/inteligencia-artificial/openai-lanza-chatgpt-go-en-colombia-con-gpt-5-y-beneficios-en-rappi/
- https://www.infobae.com/tecno/2025/12/16/openai-ya-esta-disponible-en-colombia-anuncian-plan-economico-para-chatgpt-premium/
- https://www.nequi.com.co/tarifas-nequi
- https://www.daviplata.com/documents/d/guest/daviplata-tasas-y-tarifas
- https://www.infobae.com/colombia/2026/01/08/nequi-y-daviplata-tienen-nuevos-topes-y-reglas-en-2026-asi-cobran-ahora-por-el-impuesto-del-4x1000-en-las-transferencias/
- https://www.magneto365.com/co/blog/salario-minimo-vigente
- https://www.buk.co/blog/salario-minimo-2026-en-colombia
- https://www.larepublica.co/finanzas-personales/conozca-cuales-son-las-aplicaciones-que-pueden-ayudarle-a-administrar-sus-finanzas-4072931
- https://blog.finerioconnect.com/apps-financieras-clave-en-la-modernizacion-de-la-banca-en-colombia/
