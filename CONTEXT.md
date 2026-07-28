# fidy-ai

An agent-first personal finance product launching only in Colombia. `CO` is the sole enabled
ServiceMarket, `es-CO` is the sole launch locale, `America/Bogota` is the default IANA time zone,
and Spanish is the product language. WhatsApp through Kapso is the primary channel; Wompi is the
billing provider; Colombian compliance behaviour and Category data remain direct launch choices.
The user's own agents are first-class clients of the same API the hosted agent uses.

**Launch enablement is not domain capability.** Enablement says where fidy operates and what it
supports today. Capability says what the domain can represent without changing a record's meaning.
Only Colombia is enabled, while a Transaction can retain Money in any recognized Currency. That
does not promise a second ServiceMarket, foreign copy or providers, or FX conversion.

This is a single bounded context — one language across the whole product. Slices are aggregates
within it, not separate contexts.

## Language

### Money and records

**Money**:
A non-negative exact amount together with its Currency. The operation that uses Money decides
whether zero is meaningful; a Transaction, Budget cap, or billing charge requires a positive value.
Amounts in different Currencies are never compared or added as though they shared a denomination.
_Avoid_: Amount (as the whole value), signed money, floating-point money.

**Currency**:
A recognized monetary denomination with defined fractional precision. Currency gives Money its
monetary meaning and is independent of ServiceMarket, locale, and presentation.
_Avoid_: Country, market, locale, currency symbol.

**ServiceMarket**:
A jurisdiction where fidy's product, commercial terms, providers, and compliance behaviour are
enabled. Colombia (`CO`) is the only enabled ServiceMarket. It is independent of Currency, locale,
time zone, channel, and identity.
_Avoid_: Country (when product enablement is meant), region, country settings.

**Transaction**:
One movement of Money, with a direction, merchant, and Category. It contains normalized financial
facts; where those facts came from and the context used to interpret them belong to its
SourceAttestations.
_Avoid_: Expense, payment, purchase, movimiento.

**SourceAttestation**:
An immutable record of where a Transaction was learned from — a notification email, a statement
line, or a manual entry — together with the captured ServiceMarket, locale, IANA time zone, source
channel or provider, and interpretation revision needed to explain it later. A Transaction may have several;
none is ever deleted.
_Avoid_: Source, origin, evidence.

**Reconciliation**:
Deciding that two records describe the same real-world purchase, and linking them. Candidates must
have equal Currency and exact amount. The link is reversible, never a deletion. Not an entity — a
process over Transactions.
_Avoid_: Deduplication, matching, merge (as a noun).

**Category**:
A user-facing classification for spending with an identity that survives label, seed-order, and
taxonomy changes. Colombian labels and merchant knowledge are the only launch data. Assigned
automatically at capture, correctable by user keyword rules.
_Avoid_: Tag, label, bucket.

**Budget**:
A monthly positive Money cap on one Category and Currency. Only outflows in that Category and
Currency contribute. Alerts latch once each at 80% and 100% per month.
_Avoid_: Limit, goal, target.

**RecurringSeries**:
A repeating charge detected from comparable Transaction Money in one Currency — rent or another
recurring transaction.
_Avoid_: Subscription (that word means the user's own paid plan).

### Ingestion

**Ingestion**:
Turning something the user forwards, uploads, or says into a Transaction. Email, statement,
receipt photo, screenshot, voice note, or typed sentence.
_Avoid_: Import, sync, parsing (that is one step inside it).

**NeedsReviewItem**:
Something ingestion could not confidently turn into a Transaction, held in a visible queue with
its captured interpretation context intact until resolution. Never silently discarded.
_Avoid_: Failed import, error, unparsed item.

**IngestSample**:
Retained ingestion material — raw forwarded email kept ~90 days, plus an indefinite anonymised
structural version used to build parsers and regression fixtures. It retains the ServiceMarket,
source format or provider, parser revision, and anonymisation revision needed to interpret it. Personal
data under Ley 1581.
_Avoid_: Corpus, training data, log.

### The agent surface

**Canonical operation**:
A capability declared once with its inputs, outputs, failures, and access requirements. The server,
typed client, OpenAPI specification, MCP tools, and hosted agent toolkit are derived from that
declaration. The hosted agent has no private tools.
_Avoid_: Endpoint, route, API call, tool.

**SuggestedOperation**:
A canonical operation attached to a response because it may be worthwhile for the calling agent to
invoke next, together with any known inputs and a short reason. It makes the response navigable
without requiring the agent to know the API in advance.
_Avoid_: Affordance, link, hint (alone), suggestion, next action.

**InsightEvent**:
Something the product decided is worth telling the user, as a record with a lifecycle — pending,
delivered, read, dismissed. A scheduled occurrence retains the schedule version, ServiceMarket,
locale, IANA time zone, scheduled UTC instant, and any Money groups needed to preserve its meaning.
WhatsApp is one consumer; agents pull the same stream.
_Avoid_: Notification, alert, push (those are delivery, not the record).

**AgentToken**:
A scoped bearer token a user mints in chat for one of their own agents. Scopes are `read`,
`write`, `dashboard`.
_Avoid_: API key, credential, PAT.

**UserNote**:
Free-text the user asked to be remembered, reachable by both the hosted agent and the user's own
agents through `remember` / `recall`.
_Avoid_: Memory, fact, context.

**RollingSummary**:
The stored "story so far" that aged-out conversation messages are folded into.
_Avoid_: History, context window, transcript (that is the full record).

### Identity, consent, accountability

**User**:
A person with a stable identity independent of phone numbers, channels, providers, and recovery
credentials. Their current ServiceMarket, locale, and IANA time zone are explicit, independent
context. No KYC; optional recovery email.
_Avoid_: Account, customer, client, titular (that word is reserved for its legal sense).

**WhatsAppIdentity**:
The concrete association between a User and one normalized, unique WhatsApp phone number in E.164.
It is the launch channel identity, not the User itself; provider identifiers are delivery evidence,
not identity.
_Avoid_: User identity, root identity, generic channel identity, provider identity.

**ConsentRecord**:
An append-only entry recording that a stable User agreed to a specific disclosure at a specific UTC
instant — onboarding, a token grant, a proactivity opt-in, or a revocation. It retains the exact
ServiceMarket, disclosure locale, immutable policy or disclosure revision and hash, purposes,
channel, and provider-qualified message evidence needed to remain interpretable. Carries its
subject, because a Ley 1581 artifact that cannot say who consented is not evidence.
_Avoid_: Agreement, opt-in, permission.

**AuditLogEntry**:
Metadata-only record of one canonical call — who, which token, which operation, what outcome.
Never bodies. Carries its stable User subject, for the same reason as ConsentRecord.
_Avoid_: Log, event, trace.

**Titular**:
The legal term under Ley 1581 for the person a piece of personal data is about. Used only when
speaking about data-protection rights, never as a synonym for User.

**Asesoría**:
Regulated financial advice. The product describes the user's own data and gives generic education
freely, but never gives personalized investment, credit, or tax recommendations.
_Avoid_: Advice (unqualified), recommendation.

### Money in, money out

**Subscription**:
The User's paid access to fidy — weekly, monthly, or yearly Pro. Its activation ServiceMarket,
billing periods, PriceRevisions, tax treatment, provider references, refunds, and UTC instants stay
historically interpretable.
_Avoid_: Membership, plan (alone), recurring charge (that is a RecurringSeries).

**PriceRevision**:
An immutable version of Subscription price terms: exact Money, billing period, tax treatment, and
the ServiceMarket in which the terms were offered. A later price change never rewrites a prior
billing period.
_Avoid_: Current price, price config, rate.

**BillingAttempt**:
One asynchronous attempt to collect a Subscription charge, retaining its Money, PriceRevision,
provider references, and UTC instants. Starting one yields `pending`; only a verified provider
outcome advances it to `succeeded` or `failed`.
_Avoid_: Charge (alone), synchronous payment, settlement promise.

**Paywall**:
The boundary between free and Pro. The rule is mechanical: any agent turn that loads transaction
history beyond the single record being captured is paid.
_Avoid_: Gate, upsell, limit.
