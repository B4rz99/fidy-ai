# Fidy

An agent-first personal finance product launching only in Colombia. `CO` is the sole enabled
ServiceMarket, `es-CO` is the sole launch locale, `America/Bogota` is the default IANA time zone,
and Spanish is the product language. WhatsApp through Kapso is the primary channel; Wompi is the
billing provider; Colombian compliance behaviour and Category data remain direct launch choices.
The user's own agents are first-class clients of the same API the hosted agent uses.

**Launch enablement is not domain capability.** Enablement says where Fidy operates and what it
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
A jurisdiction where Fidy's product, commercial terms, providers, and compliance behaviour are
enabled. Colombia (`CO`) is the only enabled ServiceMarket. It is independent of Currency, locale,
time zone, channel, and identity.
_Avoid_: Country (when product enablement is meant), region, country settings.

**Transaction**:
One movement of Money, with a direction, optional Counterparty, and Category. It contains normalized
financial facts; where those facts came from and the context used to interpret them belong to its
SourceAttestations.
_Avoid_: Expense, payment, purchase, movimiento.

**Counterparty**:
The person or organization on the other side of a Transaction, when the captured material identifies
one. Its absence means the Counterparty was not known at capture; a purpose or purchased item is not
a substitute.
_Avoid_: Merchant, comercio, vendor, inferred business name, "Sin especificar".

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
taxonomy changes. Assigned at capture from an explicit Category, a user keyword rule, or the
categorization fallback; correctable by user keyword rules.

The direct launch taxonomy is flat: Restaurantes, Domicilios, Mercado, Transporte, Vivienda,
Servicios, Salud, Educación, Compras, Entretenimiento, Viajes, Impuestos, Transferencias, Retiros
de efectivo, Ingresos, and Otros. These Spanish labels and their presentation order are attributes
of stable opaque CategoryIds, never identity. A P2P or own-account movement is Transferencias; a
purchase paid through Nequi, Daviplata, or another app uses the underlying Counterparty or purpose
instead of the payment app. Keyword rules affect future capture only; changing existing history is
an explicit Transaction correction.
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
A capability declared once with its inputs, outputs, failures, access requirements, and hosted-agent
confirmation policy. The server, typed client, OpenAPI specification, MCP tools, and hosted agent
toolkit are derived from that declaration. The hosted agent has no private tools.
_Avoid_: Endpoint, route, API call, tool.

**Canonical query**:
A canonical operation that observes domain state without requesting a domain transition or external
effect. Audit, quota, and access-accounting writes do not change its classification.
_Avoid_: Read operation, read-only endpoint.

**Canonical mutation**:
A canonical operation that requests a domain transition, records durable work, or causes an external
effect. Every canonical mutation is transaction-composable and uses one reusable implementation for
individual and atomic-batch execution.
_Avoid_: Write operation, command, batch-eligible operation.

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
A bearer grant for canonical operations with scopes `read`, `write`, and `dashboard`. A
UserAgentToken is minted by a user for one of their own agents, may carry any non-empty scope
subset, and has a renewable inactivity deadline. A HostedAgentToken is internal to one hosted turn,
always carries every scope, has a short non-renewable hard expiry, and is revoked during normal
turn cleanup. Raw bearers are disclosed only to their immediate caller and never persisted.
_Avoid_: API key, credential, PAT, hosted grant.

**Transcript**:
The exact append-only record of retained User text, visible assistant text, canonical tool calls and
outcomes, and fixed metadata-only terminal Turn outcomes. Compaction physically removes the
terminal-Turn prefix it successfully incorporates; a failed or stale Compaction removes nothing. A
Transcript records what happened while retained; it never silently becomes a Memory or other User
truth.
_Avoid_: Memory, preference, context window, CompactedConversation.

**Turn**:
One admitted User request and its serialized hosted attempt. It is Pending after complete hosted
preflight succeeds and the exact User entry is retained; it becomes Completed after a visible assistant reply
is delivered, Failed after a handled model or delivery failure, or Interrupted when abandoned work
is recovered. Completed, Failed, and Interrupted are terminal. A terminal Turn may participate in a
contiguous Compaction prefix; a Failed or Interrupted Turn contributes its exact User entry and a
fixed metadata-only terminal marker.
_Avoid_: Message, model round, tool call, request.

**Memory**:
Formatting-normalized free text the User explicitly chose to retain for the durable-economic-context
purpose, reachable by both the hosted agent and the User's own agents through `remember`, `recall`,
`revise`, and `forget`. The server does not classify or censor arbitrary prose by semantic content;
the hosted agent is instructed to use Memory only for its stated purpose and to warn the User not to
submit sensitive values. Only current Memories are recalled; revision replaces stale text and
forgetting removes it.
_Avoid_: UserNote, fact, context, demographic profile.

**Compaction**:
The process that replaces any prior CompactedConversation and an exact contiguous terminal-Turn
Transcript segment with one new bounded CompactedConversation, then physically removes the
incorporated Transcript segment.
_Avoid_: Summarization, Transcript rewrite, Memory creation.

**CompactedConversation**:
The stored lossy conversation continuity produced by Compaction. It becomes the only retained
conversation continuity for incorporated Transcript entries; it is neither exact evidence nor a
Memory or authoritative financial truth.
_Avoid_: Summary, history, context window, Transcript.

**WorkingContext**:
The ordered, transient material assembled once for one hosted Turn from system policy, current
Memories, any CompactedConversation, the exact uncompacted conversation, and the active request. It is never
stored as another source of User truth.
_Avoid_: Memory, Transcript, context window, prompt.

### Identity, consent, accountability

**User**:
A person with a stable identity independent of phone numbers, channels, providers, and recovery
credentials. Their current ServiceMarket, locale, and IANA time zone are explicit, independent
context. No KYC; optional recovery email.
_Avoid_: Account, customer, client, titular (that word is reserved for its legal sense).

**WhatsAppIdentity**:
The concrete association between a User and a WhatsApp Business Portfolio-scoped user ID (BSUID).
Its identity key is Business Portfolio plus BSUID. A normalized E.164 phone number, parent BSUID,
and username are optional mutable evidence on that association: none can resolve, authorize,
reassociate, or address communication to a User. It is the launch channel identity, not the User
itself; message, contact, and conversation identifiers are delivery evidence, not identity.
_Avoid_: Phone identity, User identity, root identity, generic channel identity, provider identity.

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

**TrialPeriod**:
The immutable half-open UTC interval during which a newly consented User receives Pro access without
a Subscription. It starts once, when onboarding consent creates the stable User, and ends exactly
168 hours later. Returning identity resolution, consent restoration, and WhatsApp reassociation
never replace or extend it.
_Avoid_: Trial status, renewable trial, onboarding window.

**Subscription**:
The User's paid access to Fidy — weekly, monthly, or yearly Pro. Its activation ServiceMarket,
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
The boundary between permanent Free access and genuine Pro-only capabilities. Transaction browsing
and hosted analysis remain Free under their concrete monthly allowances; exhausting one of those
allowances is `quota_exhausted`, never Paywall. TrialPeriod or an active Pro Subscription grants Pro
access. Existing data remains available when either ends.
_Avoid_: Gate, upsell, quota, limit.

### Observability

**Work**:
The application behaviour a Span observes, held as the Effect that performs it. Observing work never
alters it: its success value, failure, and interruption reach the caller exactly as they would have
had telemetry been absent.
_Avoid_: Task, job, unit of work, operation (that is the code naming what the work does).

**Projector**:
A pure function that rebuilds an untrusted value into the exact shape allowed to leave the process.
It constructs each field from a closed schema instead of removing fields from the original, so a
field the schema does not declare cannot ride along.
_Avoid_: Filter, sanitizer, scrubber, serializer.
