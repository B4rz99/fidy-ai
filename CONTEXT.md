# fidy-ai

An agent-first personal finance product for Colombia. Spanish-only, COP-only. WhatsApp is the
primary channel; the user's own agents are first-class clients of the same API the hosted agent
uses.

This is a single bounded context — one language across the whole product. Slices are aggregates
within it, not separate contexts.

## Language

### Money and records

**Transaction**:
One movement of money, in whole COP pesos, with a direction and a merchant.
_Avoid_: Expense, payment, purchase, movimiento.

**SourceAttestation**:
An immutable record of where a Transaction was learned from — a notification email, a statement
line, or a manual entry. A Transaction may have several; none is ever deleted.
_Avoid_: Source, origin, evidence.

**Reconciliation**:
Deciding that two records describe the same real-world purchase, and linking them. A reversible
link, never a deletion. Not an entity — a process over Transactions.
_Avoid_: Deduplication, matching, merge (as a noun).

**Category**:
A user-facing classification for spending, from a Colombian taxonomy. Assigned automatically at
capture, correctable by user keyword rules.
_Avoid_: Tag, label, bucket.

**Budget**:
A monthly cap on one Category. Alerts latch once each at 80% and 100% per month.
_Avoid_: Limit, goal, target.

**RecurringSeries**:
A repeating charge detected from history — a subscription, a rent payment.
_Avoid_: Subscription (that word means the user's own paid plan), recurring transaction.

### Ingestion

**Ingestion**:
Turning something the user forwards, uploads, or says into a Transaction. Email, statement,
receipt photo, screenshot, voice note, or typed sentence.
_Avoid_: Import, sync, parsing (that is one step inside it).

**NeedsReviewItem**:
Something ingestion could not confidently turn into a Transaction, held in a visible queue. Never
silently discarded.
_Avoid_: Failed import, error, unparsed item.

**IngestSample**:
Retained ingestion material — raw forwarded email kept ~90 days, plus an indefinite anonymised
structural version used to build parsers and regression fixtures. Personal data under Ley 1581.
_Avoid_: Corpus, training data, log.

### The agent surface

**Canonical operation**:
A capability defined once as a contract, from which the server, typed client, OpenAPI spec, MCP
tools, and the hosted agent's toolkit are all derived. The hosted agent has no private tools.
_Avoid_: Endpoint, route, API call, tool.

**Affordance**:
A suggested next canonical operation attached to a response — `{ tool, args?, hint }`. It is what
makes a response navigable: an agent reads its next worthwhile call off the body rather than
knowing the API in advance. Aimed at the invariant that one is never advertised when it would fail
for the caller — nothing enforces that yet, so today an entry says a call is worth making, not that
it will succeed, and the wire text agents read says exactly that.
_Avoid_: Link, hint (alone), suggestion, next action.

**InsightEvent**:
Something the product decided is worth telling the user, as a record with a lifecycle — pending,
delivered, read, dismissed. WhatsApp is one consumer; agents pull the same stream.
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
A person, identified at root by their WhatsApp phone number in E.164. No KYC. Optional recovery
email.
_Avoid_: Account, customer, client, titular (that word is reserved for its legal sense).

**ConsentRecord**:
An append-only entry recording that a specific person agreed to a specific disclosure at a
specific time — onboarding, a token grant, a proactivity opt-in, or a revocation. Carries its
subject, because a Ley 1581 artifact that cannot say who consented is not evidence.
_Avoid_: Agreement, opt-in, permission.

**AuditLogEntry**:
Metadata-only record of one canonical call — who, which token, which operation, what outcome.
Never bodies. Carries its subject, for the same reason as ConsentRecord.
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
The user's own paid plan with fidy — weekly, monthly, or yearly Pro.
_Avoid_: Membership, plan (alone), recurring charge (that is a RecurringSeries).

**Paywall**:
The boundary between free and Pro. The rule is mechanical: any agent turn that loads transaction
history beyond the single record being captured is paid.
_Avoid_: Gate, upsell, limit.
