# Colombia-first global-ready foundations

- **Status:** Accepted
- **Date:** 2026-07-26
- **Active specification:** [Agent-first personal finance MVP for Colombia](https://github.com/B4rz99/fidy-ai/issues/1)
- **Decision map:** [Global-ready foundations for a Colombia-first MVP](https://github.com/B4rz99/fidy-ai/issues/57)

## Context

fidy launches only in Colombia. Its direct launch choices are valuable: `CO`, `es-CO`,
`America/Bogota`, Spanish copy, WhatsApp through Kapso, Wompi, Colombian compliance behaviour, and
Colombian Category data.

Some early models treated those choices as universal facts. Whole-COP monetary values, a phone
number as the User's identity, and implicit ServiceMarket, locale, and time-zone context would make today's
records depend on configuration that can later change. Enabling another ServiceMarket would then
require reinterpreting Transactions and historical consent, ingestion, billing, schedules,
InsightEvents, and reports.

The opposite response would be to build multi-ServiceMarket machinery before a second
ServiceMarket exists:
provider and market registries, translation catalogs, generic channel identities, compliance-policy
engines, and migration operations. That machinery would add indirection without present variation
to justify or test it.

## Decision

Choose stable persisted meaning while keeping Colombia implementation direct.

- Money is exact, Currency-aware, and independent of ServiceMarket. Aggregation and comparison are
  Currency-scoped; fidy performs no FX conversion or cross-Currency netting.
- UserId is stable across channel and credential changes. Launch authentication uses concrete
  WhatsAppIdentity and AgentToken resolvers that reach the same User; no generic identity framework
  is introduced.
- A User's current ServiceMarket, locale, and IANA time zone are explicit and independent. Existing
  legal, financial, ingestion, delivery, billing, and persisted-report artifacts retain only the
  captured context needed to interpret them later.
- Category identity is stable across Colombian label, seed-order, and taxonomy changes.
- BillingAttempt completion is asynchronous and advances only from verified provider outcomes.
- Only real present seams are abstractions. Colombia-specific providers, compliance, pricing,
  categorization, scheduling, and copy stay in their owning modules.

Colombia remains the only enabled and launch-validated ServiceMarket. This decision does not add a
second ServiceMarket, FX, translations, a generalized provider or market registry, a compliance
engine, or a ServiceMarket migration operation.

## Consequences

Records created at launch keep the same meaning when a User changes a phone number or preferences,
when pricing or parsers are revised, and if expansion is considered later. Canonical operations can
carry recognized Currency without claiming that fidy operates in the Currency's markets.

The model carries some context that a Colombia-only implementation could otherwise assume, and
relational repos must project nested Money into queryable columns and reconstruct it. That cost is
paid at stable value and persistence seams, rather than spread through speculative runtime
selection machinery.

A future second ServiceMarket extends direct modules only where real variation appears. It may earn
new abstractions then; this ADR is not evidence that those abstractions should be built now.

## Rejected alternatives

### Hard-code the Colombia launch as universal domain meaning

Rejected because whole-COP values, phone-root identity, and implicit current context make persisted
records unstable. Expansion or ordinary User preference changes would require reinterpretation or
migration of facts whose original meaning should have been durable.

### Build generalized multi-market machinery now

Rejected because there is no second enabled ServiceMarket against which to validate the
abstractions. It
would obscure simple Colombian behaviour, create invalid generic concepts, and increase operational
scope without making current records more truthful.
