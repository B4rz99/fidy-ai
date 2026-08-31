# Safe account hints and Reconciliation candidates

Research date: 2026-08-31

Scope: issue [#434](https://github.com/B4rz99/fidy-ai/issues/434), refining the Reconciliation specification in [#431](https://github.com/B4rz99/fidy-ai/issues/431) and using the timing decision from [#432](https://github.com/B4rz99/fidy-ai/issues/432#issuecomment-5484359437). This note decides which account hints Reconciliation may retain, how it compares them, how candidates and outstanding work stay bounded, and which facts may reach model judgment. It does not implement hint extraction, matching, links, or User questions.

## Decision

### Safe hint shape

A Reconciliation hint is source-specific evidence retained with the owning SourceAttestation. It is not a Transaction fact, Account, payment instrument, identifier, identity claim, or authorization input.

The closed shape has three independently optional slots, with at most one value in each slot:

```text
cardLastFour: exactly four ASCII decimal digits
accountLastFour: exactly four ASCII decimal digits
instrumentLabel: normalized non-empty text of at most 64 Unicode code points
```

Examples of admitted encoded values are `cardLastFour = "1234"`, `accountLastFour = "8062"`, and `instrumentLabel = "visa oro"`. The stored suffix contains only four digits, never masking characters. The kind is part of the value: card suffix `1234` and account suffix `1234` are not comparable merely because their digits happen to agree.

The following are forbidden as Reconciliation hints:

- a complete or variable-length card or account number;
- a prefix, BIN, routing number, CVV, expiry, PIN, password, token, or bearer material;
- an arbitrary masked string such as `****-****-1234` rather than the closed suffix value;
- a provider customer id, statement id, email address, phone number, document number, TransactionId, AccountId, or another unrelated identifier;
- a hash, encryption, tokenization, or other stable derivative of a complete card/account number;
- an inferred label or suffix not explicitly supported by captured material; or
- a generic Account record introduced solely for Reconciliation.

Raw evidence can already contain sensitive material for its separate bounded ingestion purpose. A source adapter may transiently project an explicitly identified complete number to its final four digits, but no complete value may cross the safe-hint decoder, enter Reconciliation persistence, reach a model, or appear in a log, error, question, or AuditLogEntry. Model output that supplies more than the closed value is invalid rather than truncated after decoding.

### Label normalization

An `instrumentLabel` is admitted only when the evidence explicitly presents text as the card, account, or product used. A Counterparty, institution name, email sender, subject line, filename, purchased item, or free-form description is not an instrument label.

Normalize one admitted label in this exact order:

1. apply Unicode NFKC normalization;
2. replace every contiguous Unicode whitespace sequence with one ASCII space;
3. trim leading and trailing whitespace;
4. apply Unicode default lowercase through the runtime's locale-independent lowercase operation;
5. reject an empty result, control characters, or a result longer than 64 Unicode code points.

Do not strip accents or punctuation, translate words, remove product tiers, expand abbreviations, perform fuzzy matching, or map institution-specific aliases without a separately versioned source-format rule. Thus `Visa Oro` and `VISA   ORO` normalize equally, while `Visa`, `Visa Oro`, and `TC Visa Oro` remain distinct.

A suffix adapter may remove explicit masking/separator characters only while parsing the source representation. The decoded hint itself must be exactly four ASCII digits. Four digits found incidentally in Money, a date, a telephone number, a statement reference, or prose are not a hint.

### Hint comparison

Comparison is deterministic and conflict-first:

1. If both sides have `cardLastFour` and the values differ, the result is `conflict`.
2. If both sides have `accountLastFour` and the values differ, the result is `conflict`.
3. Otherwise, if any same slot agrees exactly after normalization, the result is `equal`.
4. Otherwise the result is `unknown`.

Consequences:

| Notification evidence | Statement evidence | Result     | Candidate effect          |
| --------------------- | ------------------ | ---------- | ------------------------- |
| card `1234`           | card `1234`        | `equal`    | supporting evidence       |
| card `1234`           | card `9876`        | `conflict` | exclude before model work |
| account `1234`        | account `9876`     | `conflict` | exclude before model work |
| card `1234`           | account `1234`     | `unknown`  | compatible, not agreement |
| card `1234`           | no hint            | `unknown`  | compatible, not agreement |
| no hint               | no hint            | `unknown`  | compatible, not agreement |
| label `Visa Oro`      | label `VISA  ORO`  | `equal`    | supporting evidence       |
| label `Visa Oro`      | label `Visa`       | `unknown`  | compatible, not conflict  |

A differing label is not a conflict because source channels may abbreviate or rename the same product. If one pair has an equal slot and a different same-kind suffix, conflict wins. Missing or incomparable evidence is never silently promoted to equality.

### Candidate policy

One newly captured eligible notification-email or statement-line Transaction is the anchor. Its candidates are Transactions satisfying every condition below:

1. same explicit User;
2. the opposite eligible source kind—notification email versus statement line;
3. equal Currency;
4. exact decimal Money amount equality, with no rounding, tolerance, locale conversion, or FX conversion;
5. the same Transaction direction from the User's perspective;
6. timing admitted by #432: statement civil date is directionally 0–30 days after notification civil date;
7. hint comparison is `equal` or `unknown`, never `conflict`;
8. both Transactions remain unlinked and otherwise eligible for Reconciliation; and
9. no still-applicable User keep-separate decision excludes the unchanged pair.

A candidate is only a possible same purchase. Hint equality does not establish a match, and hint absence does not establish either equality or difference.

Timing controls the permitted outcome:

- **0–1 civil days:** one deterministic candidate may link through the deterministic policy. If model judgment is needed, one unique model winner at or above `0.90` may link. A tie, lower confidence, malformed result, timeout, or provider failure requires User review.
- **2–30 civil days:** the pair always requires User review, regardless of model confidence. A model may rank choices but cannot answer for the User.
- **Earlier than the notification date or after day 30:** not a candidate; a model cannot override the boundary.

Every link still revalidates the complete same-User snapshot after model work and before commit. Model confidence cannot override Currency, amount, direction, timing, hint conflict, ownership, link state, or a keep-separate decision.

### Candidate and work bounds

One work item may load at most **eight candidates**. The indexed candidate query requests nine rows: eight usable rows plus one overflow sentinel. It predicates User, opposite source kind, Currency, exact amount, direction, timing, and eligible state in PostgreSQL before the limit; it does not load a User's FinancialRecord and filter it in memory.

If the ninth row exists, the set is overflowed. The worker must not truncate it into an apparently unique set, auto-link, or call the model. It leaves every Transaction independent and records one bounded review/overflow outcome. The later question interface may page candidates or direct the User to explicit canonical linking, but it may not hide overflow and imply that the first eight were exhaustive.

At most one model call occurs per claimed work item. Its candidate array has at most eight entries. Retry policy may retry transport internally only within that one bounded adapter call and deadline; it may not multiply semantic judgments.

Outstanding Reconciliation work is bounded to **100 rows per User**, following the existing notification-email outstanding-work precedent. Reserve one row for a coalescing `rescan-required` marker: at most 99 targeted Transaction work rows plus one marker. Capture below the bound inserts one idempotent targeted row. Capture at the bound atomically upserts the single marker instead of adding another row; it never silently drops the need to revisit accepted evidence and never rejects or rolls back the accepted Transaction merely because Reconciliation is behind.

The marker drains eligible uncheckpointed Transactions in stable indexed pages of at most 25, creates targeted work only as capacity becomes available, and remains pending until no eligible uncheckpointed capture remains. Uniqueness permits at most one outstanding targeted item per anchor Transaction and one marker per User. These are product bounds; implementation may choose relational details that preserve exactly these observable limits.

### Minimal model projection

The model receives one closed object containing:

```text
anchor:
  label: ephemeral label local to this call
  sourceKind: notification-email | statement-line
  civilDate: YYYY-MM-DD
  counterparty: absent or normalized bounded text

candidates: at most eight entries, each containing:
  label: ephemeral label local to this call
  sourceKind: notification-email | statement-line
  civilDate: YYYY-MM-DD
  counterparty: absent or normalized bounded text
  hintComparison: equal | unknown
```

Counterparty text is capped at **120 Unicode code points** for this projection. Captured text remains untrusted data and is framed as such. Ephemeral labels are simple per-call positions such as `anchor` and `candidate-1`; they are not persisted domain ids.

Money, Currency, and direction are deliberately absent because deterministic policy has already proved the required relationship and every candidate shares it. Actual hint values are absent because the model needs only the comparison result. The projection also excludes:

- raw or rendered email, subject, sender, HTML, images, and provider payload;
- raw statement rows, headers, filenames, cells, formulas, and StatementRowEvidence;
- SourceAttestations and broad Transaction objects;
- complete or masked card/account values and safe suffix digits;
- Category, notes, correction metadata, and User prose;
- UserId, TransactionId, AccountId, statement/provider ids, hashes, and other stable identifiers; and
- model prompts, explanations, or responses from prior work.

One closed structured result may name one ephemeral candidate and return `same-movement`, `different-movements`, or `uncertain` with bounded confidence. Reconciliation never persists model prose, raw prompts, or raw responses.

## Evidence

### Current implementation has no hint seam

The current canonical `TransactionExtraction` is derived from only Money, Counterparty, direction, and `occurredAt`; neither account/card hints nor arbitrary identifiers are Transaction facts ([`apps/server/src/core/transactions/model.ts:143-149`](../../apps/server/src/core/transactions/model.ts)). Current statement mapping similarly understands date, amount, optional Counterparty, Currency, and direction columns but no account/card/product hint ([`apps/server/src/core/ingestion/model.ts:379-417`](../../apps/server/src/core/ingestion/model.ts)). Notification extraction asks the model for that same `TransactionExtraction`, so it cannot currently return a hint ([`apps/server/src/shell/ingestion/email-extractor.ts:67-77`](../../apps/server/src/shell/ingestion/email-extractor.ts)).

SourceAttestation is the existing source-specific ownership seam: statement and notification variants retain source mechanism and interpretation evidence separately from normalized Transaction facts ([`apps/server/src/core/transactions/model.ts:186-231`](../../apps/server/src/core/transactions/model.ts)). **Conclusion:** later implementation should derive source-specific extraction shapes and retain decoded hints with their owning SourceAttestation or an equally narrow source-attached projection, rather than widening Transaction or introducing Account machinery.

### Safe suffixes and labels reflect real product selection

Bancolombia's official extract instructions require the last four digits of the product in one channel. The same instructions distinguish savings accounts, current accounts, and credit cards, allow extract search by product name or number, and offer XLS downloads ([Bancolombia, “¿Cómo descargo extractos por la Sucursal Virtual Personas?”](https://www.bancolombia.com/centro-de-ayuda/preguntas-frecuentes/descargar-extractos-bancolombia-sucursal-virtual), sections “Kioscos” and “Sucursal Virtual Personas”). This does not prove that every exported row or notification contains the suffix. It does establish that a four-digit suffix and a product name are real, bounded ways a Colombian institution distinguishes the product associated with statement evidence.

Bancolombia publicly names a product “Oro” under its Visa card family ([Bancolombia, “Tarjeta de Crédito Oro Visa”](https://www.bancolombia.com/personas/tarjetas-de-credito/visa/oro), breadcrumb and heading). Product-owner evidence for the expected notification corpus says some emails omit suffixes and instead supply an instrument label such as `Visa Oro` ([issue #434 decision comment](https://github.com/B4rz99/fidy-ai/issues/434#issuecomment-5484550520)). These facts support a bounded label slot, while the lack of a universal public email/export schema requires conservative exact comparison rather than bank-wide aliases or fuzzy matching.

The existing synthetic XLSX fixture contains only `Date`, `Amount`, `Description`, and `Type`; it supplies no hint ([`apps/server/src/shell/ingestion/fixtures/synthetic-statement.xlsx`](../../apps/server/src/shell/ingestion/fixtures/synthetic-statement.xlsx)). The existing synthetic received email says only `Compra por COP 25.000` and supplies no suffix or label ([`apps/server/src/shell/ingestion/fixtures/resend-received-email.ts:1-13`](../../apps/server/src/shell/ingestion/fixtures/resend-received-email.ts)). These are evidence-backed wholly absent cases, not evidence that production formats never carry hints.

### Resource and privacy bounds

The existing email policy bounds unfinished work per User at 100: fifty current-month Free emails plus fifty deferred emails ([`apps/server/src/core/ingestion/email-policy.ts:3-12`](../../apps/server/src/core/ingestion/email-policy.ts)). Reusing 100 as the Reconciliation outstanding-work ceiling is a product choice aligned with an existing reviewed ingestion bound, not a claim that the two queues have identical cost.

Fidy's security policy requires purpose-minimal personal/financial persistence and provider egress, runtime decoding at every trust boundary, allowlisted logs, User isolation, and hard bounds on model calls, queue depth, and storage ([`SECURITY_STANDARDS.md`](../../SECURITY_STANDARDS.md), sections 1, 3, 4, 8, and 10). The closed hint shape, comparison-only model field, eight-candidate limit, one-call limit, and 100-row coalescing backlog are direct product applications of those invariants.

## Privacy purpose and retention

The sole purpose of a safe hint is deciding whether two same-User Transactions may describe the same real-world purchase. It may be used for candidate exclusion, support, stale-snapshot revalidation, and a bounded User question. It must not be used to resolve a User, authorize an Account, address a provider request, infer account ownership, build a financial identifier profile, or enrich unrelated domain records.

A hint is retained no longer than its owning SourceAttestation remains retained for its documented purpose. Suppression, irreversible anonymisation, or deletion of the owning attestation removes the hint under the same policy. Reconciliation links, questions, work rows, AuditLogEntries, logs, and model-judgment records do not copy the raw hint. They may retain only the closed comparison outcome and source/material revision coordinates needed to detect stale work. A stable hash of a suffix or label is still a copied identifier and is not permitted as a workaround.

The model projection exists only for the duration of its one judgment call. Provider retention follows the configured hosted-model purpose and contract; Fidy does not additionally persist the payload or response. Telemetry records bounded workflow coordinates such as candidate count, overflow, outcome class, latency, and safe failure reason, never Money, Counterparty, hint value, TransactionId, prompt, or response.

## Synthetic examples

All values are fictional.

### Equal suffix

A notification says the purchase used card ending `1234`; the statement format identifies card ending `1234`. Currency, exact amount, direction, and timing also pass. Hint comparison is `equal`, but the pair is still only a candidate until the complete policy decides it.

### Conflicting suffix

A notification identifies card ending `1234`; the statement identifies card ending `9876`. Comparison is `conflict`, so the pair is excluded without a model call even if Money and date agree.

### Different namespaces

A notification identifies card ending `1234`; the statement identifies account ending `1234`. Comparison is `unknown`, because the values name different kinds of evidence. The digits do not become a cross-kind identity.

### Product label only

A notification identifies `Visa Oro`; the statement identifies `VISA   ORO`. Both normalize to `visa oro`, so comparison is `equal`. If the statement says only `Visa`, comparison is `unknown`, not conflict and not fuzzy equality.

### One-sided and absent

A notification has card ending `1234` while the statement has no hint: `unknown`. Neither source has a hint: also `unknown`. Both cases may remain candidates if every other deterministic rule passes, but absence contributes no positive evidence.

### Candidate overflow

Nine same-User statement Transactions have equal Currency, exact amount, direction, admitted dates, and no hint conflict with one notification. The query observes the ninth sentinel, marks overflow, makes no model call, and cannot claim the first eight form an exhaustive or unique choice.

## Rejected alternatives

### One generic four-digit value

Rejected because an account suffix and card suffix can differ for the same purchase or coincidentally agree for unrelated products. The kind must remain part of the evidence.

### Treating `Visa Oro` as an Account or unique instrument id

Rejected. A product label may be shared, abbreviated, or renamed. Exact equality can support a candidate, but the label confers no ownership, identity, uniqueness, or authorization.

### Different labels are conflicts

Rejected because notification and statement channels may render one product at different specificity. Only same-kind suffix disagreement has sufficiently closed semantics for deterministic exclusion.

### Fuzzy or accent-insensitive label matching

Rejected because it invents institution-specific equivalence and makes collisions hard to explain. A future versioned adapter may add an alias only from format-specific evidence.

### Sending suffix digits to the model

Rejected because deterministic code can compare them exactly. The model needs only `equal` or `unknown`; sending digits adds personal financial evidence without adding judgment value.

### Truncating candidate overflow

Rejected because a truncated set can manufacture a unique winner and silently omit the true pair. Overflow is an explicit bounded outcome.

### Failing Transaction capture when Reconciliation is full

Rejected because Reconciliation is follow-on work, not a condition for accepting valid evidence. The one coalescing marker preserves eventual bounded discovery without unbounded queue growth.

## Evidence that would justify revision

Revise this policy only through a reviewed decision supported by one or more of:

1. a privacy-safe structural sample or official source contract proving another explicit masked hint shape and its semantics;
2. a versioned institution format proving that two differing labels or cross-kind suffixes are comparable;
3. bounded production measurements showing material false links despite suffix conflict handling or material missed candidates caused by the eight-candidate bound;
4. measured worker throughput and backlog age showing that the 100-row/25-page work policy is unsafe or insufficient; or
5. a SupportedInstitution completed-movement contract providing stronger account evidence under its own purpose and retention rules.

Any revision must remain source-specific and prospective by interpretation revision. It must not reinterpret historical SourceAttestations using a current alias table or turn hints into generic Account identity.

## Research limits

No official cross-institution schema for Colombian notification email or CSV/XLSX statement rows was found. Bancolombia's documentation proves product selection conventions and XLS availability, not that every row or notification contains the same clue. Product-owner evidence establishes `Visa Oro` as an expected notification example, while current synthetic fixtures establish valid absence cases. The policy therefore admits only three narrow shapes, treats labels conservatively, and gives absence explicit unknown semantics.

No personal statement, email, Money value, Counterparty, card/account number, password, or raw row was copied into this artifact.
