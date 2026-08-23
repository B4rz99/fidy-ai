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

**FinancialRecord**:
The coherent, best-available history of a User's financial life assembled from every available
capture path. It exposes its coverage and uncertainty; it never claims to be complete or authoritative.
_Avoid_: Complete financial record, authoritative ledger, source of truth.

**Transaction**:
One completed movement of Money, with a direction, optional Counterparty, and Category. Provisional,
rejected, and cancelled institution movements are neither shown nor made Transactions. It contains
normalized financial facts; where those facts came from and the context used to interpret them belong
to its SourceAttestations.
_Avoid_: Expense, payment, purchase, movimiento.

**Counterparty**:
The person or organization on the other side of a Transaction, when the captured material identifies
one. Its absence means the Counterparty was not known at capture; a purpose or purchased item is not
a substitute.
_Avoid_: Merchant, comercio, vendor, inferred business name, "Sin especificar".

**SourceAttestation**:
An append-only record of where a Transaction was learned from — a notification email, statement line,
manual entry, or Connection movement — together with the captured ServiceMarket, locale, IANA time
zone, source channel or institution, and interpretation revision needed to explain it later. While
retained, its historical contents are not rewritten; personal evidence remains only for its documented
purpose and period and may be suppressed, irreversibly anonymized where appropriate, or deleted when
required by Titular rights, purpose expiry, law, or institution contract.
_Avoid_: Source, origin, evidence, permanently retained provenance.

**Correction**:
Replacing normalized facts for the same real-world movement when newer institution evidence or an
explicit User decision establishes they were wrong. It does not create another Transaction; an
explicit User correction takes precedence over later institution metadata for the corrected fields.
_Avoid_: Reversal, deletion, reconciliation.

**Reversal**:
A completed movement that economically undoes an earlier completed movement. Each is a separate
Transaction in the FinancialRecord; the earlier Transaction is never rewritten out of existence.
_Avoid_: Correction, deletion, cancellation, refund (unless that is what the movement actually is).

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
receipt photo, screenshot, voice note, or typed sentence. An institution's notification email is
accepted only when that User has no Connection to it or the Connection is Ended; material received
in any other Connection state is not retained.
_Avoid_: Import, Synchronization, parsing (that is one step inside it).

**Account**:
An institution-held financial account a User authorized Fidy to access through a Connection. Access
does not imply that the User is its sole legal owner; removing authorization stops future
Synchronization without ordinary lifecycle changes deleting prior Transactions that retain a valid
purpose.
_Avoid_: User account, provider account, exclusively owned account.

**Balance**:
The latest institution-reported available Money for one Account, paired with when Fidy observed it
unless the institution contract supplies a distinct as-of time. When no conclusive available Balance
exists, it is unavailable: Fidy does not substitute another balance kind, combine Account Balances
into a financial position, or derive Balance from Transactions.
_Avoid_: Total, processed balance, ledger balance, Known Financial Position.

**SupportedInstitution**:
A financial institution enabled for Connections only after Fidy establishes production eligibility,
secure durable authorization, Account and completed-movement semantics, stable traversal, observable
coverage and freshness, and revocation and deletion obligations.
_Avoid_: Research candidate, sandbox integration, available bank.

**ConnectionAttempt**:
A short-lived, single-use initiation that binds one User and SupportedInstitution to a secure browser
handoff. The browser must prove the same Fidy User before institution authorization; expiry or callback
replay requires a new attempt. It is not yet a Connection or authorization.
_Avoid_: Connection, session, login link, ConsentRecord.

**Connection**:
A stable, revocable association through which a User authorizes one SupportedInstitution to expose
selected Accounts and financial data to Fidy. A User has at most one active Connection per institution;
ending it stops future access without ordinary lifecycle changes deleting prior Transactions that
retain a valid purpose, and later reauthorization preserves the Connection and Account identities. It
is Connecting until authorization and Account discovery
succeed, then Active even while historical Synchronization continues; Action required and Ended are
the other states. Temporary Synchronization failures do not change its lifecycle.
_Avoid_: FinancialConnection, integration, bank link, provider account, ConsentRecord.

**Synchronization**:
Retrieving the maximum available authorized account, balance, and movement data through a Connection,
then refreshing as frequently as its institution contract and rate budget safely permit. Institution
events may wake it early but are never financial evidence; polling remains the correctness fallback.
Coverage and last successful refresh are tracked per Account and summarized for the Connection; an
Account becomes stale after two expected successful refreshes are missed. Completed Transactions become
visible as each page commits, concurrent requests share one pending refresh, and only minimal institution
evidence for hidden provisional movements is retained.
_Avoid_: Ingestion, real-time feed, import, sync.

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
effect. Audit, quota, and access-accounting writes do not change its classification. Every canonical
query uses one reusable implementation for HTTP and hosted-agent execution.
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

**PAT (Personal Access Token)**:
A User-authorized bearer grant for one of their own agents to invoke canonical operations with a
non-empty subset of `read`, `write`, and `dashboard`. It has no fixed lifetime, dies after 90 days
without successful use, and its raw bearer is disclosed once to its immediate caller and never
persisted. A User-owned agent never manages Consent; terms updates neither revoke nor block its PAT,
while explicit Consent revocation prevents later work with `user_action_required`.
_Avoid_: API key, credential, Agent Session.

**PATPairing**:
A short-lived bootstrap in which a User-owned client retains a private device code and presents a
public user code for approval in the authenticated web app. Approval binds one exact recipient and
scope set; only the initiating client can claim the PAT bearer, once.
_Avoid_: Device login, magic-link delivery, WhatsApp approval, token exchange.

**BrowserLoginPairing**:
A short-lived web authentication bootstrap in which the browser retains a private verifier while an
established WhatsAppIdentity, VerifiedEmailCredential, or SupportRecoveryCase approves the pairing
for the same stable User. Public references cannot establish a session, and one approved pairing can
bootstrap one stable-User web session.
_Avoid_: Magic-link login, device login, WhatsApp login link, recovery session.

**Transcript**:
The exact append-only record of retained User text, visible assistant text, canonical tool calls and
outcomes, and fixed metadata-only terminal Turn outcomes. Compaction physically removes the
terminal-Turn prefix it successfully incorporates; a failed or stale Compaction removes nothing. A
Transcript records what happened while retained; it never silently becomes a Memory or other User
truth.
_Avoid_: Memory, preference, context window, CompactedConversation.

**Hosted Agent Session**:
A Fidy-owned sequence of hosted Turns for one User separated from the next Hosted Agent Session by
at least 15 minutes without activity: its opening, its latest Turn becoming terminal, or a Pending
Turn starting. A Pending Turn counts as activity from when it started rather than exempting the
Hosted Agent Session indefinitely, because admission evaluates the boundary while holding the Turn
lock, so every Pending Turn it can observe was abandoned. It retains the onboarding Consent basis
accepted when it begins and may continue indefinitely while active.
Policy or terms updates take effect when the next Hosted Agent Session begins; explicit revocation
prevents admission of another Turn but does not interrupt a Turn already in progress. User-owned
agents do not receive or manage Hosted Agent Sessions.
_Avoid_: Conversation (the retained conversation crosses Hosted Agent Sessions), WhatsApp service
window, PAT session, external-agent session.

**Turn**:
One admitted User request and its serialized hosted attempt within one Hosted Agent Session. It is Pending
after complete hosted preflight succeeds and the exact User entry is retained; it becomes Completed
after a visible assistant reply is delivered, Failed after a handled model or delivery failure, or
Interrupted when abandoned work is recovered. Completed, Failed, and Interrupted are terminal. A
terminal Turn may participate in a contiguous Compaction prefix; a Failed or Interrupted Turn
contributes its exact User entry and a fixed metadata-only terminal marker. Turn identity remains
unique across Hosted Agent Sessions, and retained Transcript entries carry one sequence that is
authoritative across Turns rather than restarting per Hosted Agent Session.
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
The stored lossy continuity for one Hosted Agent Session produced by Compaction. It is never loaded
into another Hosted Agent Session and becomes the only retained
conversation continuity for incorporated Transcript entries; it is neither exact evidence nor a
Memory or authoritative financial truth.
_Avoid_: Summary, history, context window, Transcript.

**WorkingContext**:
The ordered, transient material assembled for one hosted Turn from system policy, current Memories,
the current Hosted Agent Session's CompactedConversation and exact uncompacted conversation, and the
active request, then reused across its hosted rounds. Prior Hosted Agent Sessions remain retained but
are excluded. It is never stored as another source of User truth.
_Avoid_: Memory, Transcript, context window, prompt.

### Identity, consent, accountability

**User**:
A person with a stable identity independent of phone numbers, channels, providers, and recovery
credentials. A User comes into existence only with one VerifiedEmailCredential, which never becomes
their identity. Their current ServiceMarket, locale, and IANA time zone are explicit,
independent context; Fidy performs no KYC, and institution data never defines identity.
_Avoid_: Account, customer, client, titular (that word is reserved for its legal sense).

**WhatsAppIdentity**:
The concrete association between a User and a WhatsApp Business Portfolio-scoped user ID (BSUID).
Its identity key is Business Portfolio plus BSUID. A normalized E.164 phone number, parent BSUID,
and username are optional mutable evidence on that association: none can resolve, authorize,
reassociate, or address communication to a User. It is the launch channel identity, not the User
itself; recovery can restore access to the User but cannot replace this association.
_Avoid_: Phone identity, User identity, root identity, generic channel identity, provider identity.

**VerifiedEmailCredential**:
The one verified mailbox credential required for a User. It can approve BrowserLoginPairing for
ordinary email login or recovery to that same stable User, but is neither the User's identity nor
session authority and cannot create another User or change WhatsAppIdentity.
_Avoid_: EmailIdentity, account email, recovery email, login identity, identity provider.

**BackupRecoveryCode**:
A one-time credential disclosed to a User for the exceptional case where both their
VerifiedEmailCredential and WhatsAppIdentity are unavailable; after disclosure only its digest
remains with Fidy. Losing all three established proofs leaves no safe recovery path.
_Avoid_: Support override, recovery answer, identity document, financial proof.

**SupportRecoveryCase**:
A tracked support decision that uses a User's pre-issued BackupRecoveryCode to approve an existing
BrowserLoginPairing. Its evidence is closed, metadata-only, and never redefines User ownership.
_Avoid_: Manual account transfer, support note, identity review, WhatsApp reassociation.

**ConsentRecord**:
An append-only entry recording that a stable User agreed to a specific disclosure at a specific UTC
instant — onboarding, a PAT grant, a proactivity opt-in, or a revocation. It retains the exact
historical disclosure context and origin-qualified decision evidence needed to remain interpretable
and carries its subject, because a Ley 1581 artifact that cannot say who consented is not evidence.
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
The immutable half-open UTC interval during which a newly onboarded User receives Pro access without
a Subscription. It starts once, when verified email completes onboarding and creates the
stable User, and ends exactly 168 hours later. Returning identity resolution, consent restoration,
and WhatsApp reassociation never replace or extend it.
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
