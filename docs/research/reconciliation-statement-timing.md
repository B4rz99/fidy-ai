# Statement evidence and Reconciliation timing

Research date: 2026-08-31

Scope: issue [#432](https://github.com/B4rz99/fidy-ai/issues/432), refining the Reconciliation specification in [#431](https://github.com/B4rz99/fidy-ai/issues/431). This note decides what “statement” means, how notification and statement dates are compared, and what capture event starts Reconciliation work. It does not define account hints or implement Reconciliation.

## Decision

For this workflow, **statement evidence means one Transaction captured from one uploaded CSV or XLSX row and carrying a `statement-line` SourceAttestation**. A notification email is notification evidence, not statement evidence.

Apply this timing policy only after equal Currency, exact amount, compatible direction, and the separately researched account-hint policy have admitted a pair:

1. Let `notificationDate` be the civil calendar date represented by the notification Transaction in the IANA time zone retained by its SourceAttestation.
2. Let `statementDate` be the civil calendar date represented by the uploaded row. Read the retained calendar date; do not treat the parser-generated midnight as an institution-supplied timestamp.
3. Let `delayDays = statementDate - notificationDate`, measured as the integer difference between the represented civil dates, not as elapsed 24-hour periods.
4. **Automatic window:** `0 <= delayDays <= 1`, with both boundaries inclusive. A same-day or following-day pair may link automatically only when the complete candidate policy yields one unambiguous match.
5. **User-review window:** `2 <= delayDays <= 30`, with both boundaries inclusive. A pair in this window never links automatically; it creates a pending Reconciliation question.
6. A negative delay or a delay greater than thirty days is not a Reconciliation candidate under this policy.

The rule is **directional**: the statement date may equal or follow the notification date, never precede it. Ambiguous pairs inside the automatic window also require User review. A model may rank multiple review candidates but cannot answer the User's Reconciliation question or override either timing boundary.

Start durable Reconciliation work **when either an eligible notification-email Transaction or a statement-line Transaction and its SourceAttestation commit**. Insert the work in the same User-scoped PostgreSQL transaction as that capture. A uniqueness constraint or equivalent idempotent claim must make either arrival order safe without duplicating pair decisions.

For statement evidence, this applies identically to a row accepted during normal processing and a pending statement NeedsReviewItem later resolved into a Transaction. Creating a NeedsReviewItem does not start Reconciliation because no statement Transaction exists yet. Resolving it starts work as part of the same commit that creates its Transaction and marks the item resolved. No work is started merely because an upload, parse, mapping, or review item exists.

## Why this rule

### A statement row does not currently carry an exact time

The current statement mapping has one `dateColumn` and allows only `yyyy-MM-dd`, `dd/MM/yyyy`, or `MM/dd/yyyy`; it has no timestamp format and no field identifying the date as purchase, authorization, posting, application, or value date ([`apps/server/src/core/ingestion/model.ts:379-394`](../../apps/server/src/core/ingestion/model.ts)). The parser constructs a zoned value from year, month, and day and converts the generated start-of-day value to UTC ([`apps/server/src/core/ingestion/rules.ts:232-264`](../../apps/server/src/core/ingestion/rules.ts), [`apps/server/src/core/ingestion/rules.ts:435-451`](../../apps/server/src/core/ingestion/rules.ts)). That UTC value is a storage representation of a civil date, not evidence that the institution observed an event at midnight.

The current and source-neutral expected precision is therefore **one calendar day**. CSV and XLSX are container formats, not date semantics. Until an institution-specific format profile proves both a finer source value and what that field means, Reconciliation must not infer hour or minute precision from an uploaded row.

Two privately supplied Colombian credit-card statement examples were inspected transiently without retaining their contents, passwords, identifiers, Money, or Counterparties in this artifact. One uses a single `Fecha transacción` column in `yyyy-MM-dd`; the other uses a single `Fecha` column in `dd/MM/yyyy`. Each transaction row carries one day-precision date and no separate purchase or posting timestamp. These examples support the precision decision but do not establish the exact CSV/XLSX export shape or the semantic meaning of every institution's date column.

Bancolombia officially offers statement downloads in XLS as well as PDF, establishing that XLS statement evidence is a realistic Colombian input. Its download instructions do not promise a universal row schema or timestamp field ([Bancolombia, “¿Cómo descargo extractos por la Sucursal Virtual Personas?”](https://www.bancolombia.com/centro-de-ayuda/preguntas-frecuentes/descargar-extractos-bancolombia-sucursal-virtual)).

### Purchase, notification, posting, and statement dates are different facts

Use these meanings in Reconciliation examples and implementation:

- **Purchase time:** when the User made the purchase, if the captured material states it.
- **Notification time:** the purchase/event instant represented by the notification Transaction's `occurredAt`. It is not the time Fidy received or processed the forwarded email.
- **Posting/application date:** when the institution records or applies the movement to the product.
- **Statement date:** the day-precision value in the mapped CSV/XLSX row. Its source-specific meaning may be purchase date or posting/application date; the current generic mapping does not retain that distinction.

Notification ingestion asks the model for the canonical `TransactionExtraction`, whose `occurredAt` is an exact UTC value describing when the Money moved, while email receipt and processing times have separate lifecycle uses ([`apps/server/src/core/transactions/model.ts:58-65`](../../apps/server/src/core/transactions/model.ts), [`apps/server/src/shell/ingestion/email-extractor.ts:37-76`](../../apps/server/src/shell/ingestion/email-extractor.ts), [`apps/server/src/shell/ingestion/forwarded-email-ingestion.ts:133-139`](../../apps/server/src/shell/ingestion/forwarded-email-ingestion.ts)). Exact schema precision does not prove that every email supplied an exact purchase time; the retained interpretation revision remains necessary. The timing rule deliberately projects the value to a calendar date rather than depending on sub-day precision.

Bancolombia says a credit-card purchase has its real purchase date and a different system-registration date, and that statements show the date on which the purchase was registered in the bank's system ([Bancolombia, “¿Con qué fecha quedan las compras que hago con mi Tarjeta de Crédito?”](https://www.bancolombia.com/centro-de-ayuda/preguntas-frecuentes/con-que-fecha-quedan-las-compras-que-hago-con-tarjeta-credito)). In separate guidance, Bancolombia describes two dates as the transaction date and an application date on the following business day ([Bancolombia, “¿Por qué tengo autorizaciones pendientes en mi Tarjeta?”](https://www.bancolombia.com/centro-de-ayuda/preguntas-frecuentes/autorizaciones-pendientes-tarjeta-credito)). These first-party descriptions show that “statement date” cannot safely be assumed to mean the purchase instant.

Visa likewise defines authorization as issuer approval or decline, clearing as a later process involving validation, financial assessment, and movement of the transaction, and settlement as the final stage that calculates positions and facilitates movement of funds ([Visa Developer, Glossary](https://developer.visa.com/pages/glossary)). These are distinct processing stages; authorization evidence and later account evidence need not share one timestamp.

### Colombian behavior exceeds one hour

Bancolombia states that purchases made Friday afternoon or night, Saturday, Sunday, or a holiday apply on the next business day. It also states that pending authorizations for ordinary domestic and international purchases may last up to seven calendar days, with a special maximum of thirty calendar days for categories such as hotels and car rentals ([Bancolombia, pending authorizations](https://www.bancolombia.com/centro-de-ayuda/preguntas-frecuentes/autorizaciones-pendientes-tarjeta-credito)). More directly, Bancolombia says domestic and international credit-card purchases may take up to seven calendar days to appear in movements, with the same thirty-day exceptional cases ([Bancolombia, “¿Cuánto tarda en cargarse una compra de Tarjeta Crédito?”](https://www.bancolombia.com/centro-de-ayuda/preguntas-frecuentes/tiempo-carga-compra-con-tarjeta-credito)).

This evidence rejects a one-hour rule. It supports calendar-date comparison and proves that weekend, holiday, merchant, and institution processing can cross multiple dates. Product policy nevertheless limits **automatic** linking to the same or following date: the one-day bound deliberately prefers User review over false automatic links among repeated equal-Money purchases.

The sourced seven-day ordinary behavior and thirty-day hotel/car-rental exception instead bound the review path. Pairs from day two through day thirty remain visible for the User to decide, while the model cannot turn those delayed cases into automatic links. This is a conservative product choice, not a claim that every Colombian institution posts every purchase within thirty days.

## Synthetic examples

All examples are fictional and use `America/Bogota`.

### Same day: statement row carries purchase date

- Purchase and notification time: Tuesday 2026-09-01 at 14:20.
- Posting date: Wednesday 2026-09-02.
- Uploaded row's statement date: 2026-09-01 because this format exports purchase date.
- `delayDays = 0`.

The timing check passes at its lower inclusive boundary. The statement's day precision must not be interpreted as Tuesday at 00:00.

### Weekend: statement row carries application date

- Purchase and notification time: Friday 2026-09-04 at 20:17.
- Posting/application date: Monday 2026-09-07.
- Uploaded row's statement date: 2026-09-07.
- `delayDays = 3`.

The pair is outside the automatic window but inside the User-review window. Fidy asks the User rather than silently linking or discarding this ordinary weekend case.

### Automatic upper boundary

- Purchase and notification time: Tuesday 2026-09-08 at 09:10.
- Uploaded row's statement date: Wednesday 2026-09-09.
- `delayDays = 1`.

The pair is inside the automatic window. It may link automatically only when every other candidate check yields one unambiguous match.

### Delayed User review

- Purchase and notification time: Tuesday 2026-09-08 at 09:10.
- Uploaded row's statement date: Monday 2026-09-28.
- `delayDays = 20`.

The pair cannot link automatically. If every other candidate check passes, Fidy creates a pending Reconciliation question for the User. Day thirty is included; day thirty-one is not a candidate.

### Earlier statement date

- Notification Transaction time: Tuesday 2026-09-08 at 00:05.
- Uploaded row's statement date: Monday 2026-09-07.
- `delayDays = -1`.

The pair is not a candidate because the rule is directional. No automatic link or pending Reconciliation question is created by this timing policy.

### Later NeedsReviewItem resolution

- An uploaded row has recognizable Money but no safely interpreted date, so it becomes a NeedsReviewItem on 2026-09-10.
- The User resolves it on 2026-09-20 with a statement date of 2026-09-07.
- The statement-line Transaction, SourceAttestation, resolved lifecycle, and Reconciliation work commit together on 2026-09-20.

The matching boundary uses the evidence dates, not the upload date, review creation date, resolution date, or work-processing date.

## Capture trigger and review delivery

Normal accepted rows call `captureStatementTransactionInScope` while finalizing the statement inside one User-scoped transaction ([`apps/server/src/shell/ingestion/worker.ts:102-170`](../../apps/server/src/shell/ingestion/worker.ts)). NeedsReviewItem resolution calls the same statement capture operation and then records the resolved Transaction identity ([`apps/server/src/shell/ingestion/mutations.ts:283-333`](../../apps/server/src/shell/ingestion/mutations.ts)). Notification-email processing likewise captures through its source-specific Transaction operation ([`apps/server/src/shell/ingestion/email-worker.ts:99-140`](../../apps/server/src/shell/ingestion/email-worker.ts)).

The implementation should make each source-specific capture atomically insert the same kind of durable Reconciliation work. Triggering on both sources prevents arrival order from changing behavior: the statement may discover an earlier notification, or the notification may discover an earlier statement. Durable uniqueness and stale-snapshot revalidation own duplicate work and races; handlers must not perform an in-memory follow-up.

A review candidate creates one pending Reconciliation question per unchanged pair. It does not send an immediate or paid WhatsApp message. Up to three pending questions are presented during the next User-initiated Turn, and canonical operations let authorized User-owned agents list and answer the same questions. `same purchase` creates the reversible link; `different purchases` records the bounded keep-separate decision owned by the later decision-memory ticket; an unresolved answer leaves both Transactions unchanged.

The review path still requires exact Money and Currency, compatible direction and account hints, same User, and unlinked Transactions. It never asks merely because two Transactions have similar amounts. Multiple candidates use one bounded choice rather than silently selecting a pair; the account-hint and presentation tickets own that shape.

Observability belongs to the later bounded worker orchestration, not this capture decision. The durable insert itself should add no financial fields to logs or telemetry.

## Rejected alternatives

### Exact elapsed-hour window

Rejected because statement evidence has day precision and institution processing crosses business-day boundaries. Comparing the generated midnight to an exact notification instant would manufacture precision and produce time-of-day-dependent results.

### Symmetric one-day window

Rejected. The sourced ordinary sequence is purchase/authorization followed by application/registration. Allowing an earlier statement date would admit a stale same-Money purchase without supporting evidence.

### Seven-day automatic window

Rejected as too permissive for automatic linking. Although Bancolombia documents that an ordinary purchase may take seven days to appear, exact repeated Money can occur within a week. Days two through seven therefore require User review rather than automatic linking.

### Thirty-day automatic window

Rejected because the sourced thirty-day behavior is exceptional and category-specific. Days two through thirty remain reviewable but cannot auto-link.

### Trigger only when the statement arrives

Rejected because a notification captured after an already uploaded statement would never start work. Either eligible source capture starts idempotent durable work.

### Trigger on upload or NeedsReviewItem creation

Rejected because neither event establishes a statement Transaction to compare. It would create stale or duplicate work when parsing fails, mapping changes, evidence expires, or a User never resolves the item.

## Evidence that would justify changing the policy

Change the rule only through a new reviewed decision when one or more of these exists:

1. official institution documentation or a production data contract identifies the exported date field as purchase, authorization, value, posting, or application date and defines its precision;
2. privacy-safe anonymized structural samples establish additional date columns or timestamps and retain the institution, format, parser revision, and anonymisation revision needed to interpret them;
3. bounded production measurements, recorded without Money, Counterparty, full account/card identifiers, or raw rows, show material review candidates beyond thirty days or deterministic false links inside the one-day automatic window;
4. a SupportedInstitution contract supplies authoritative completed-movement timestamps with stronger semantics than uploaded statement rows; or
5. launch scope changes from Colombia and first-party evidence establishes a different ServiceMarket policy.

An institution-specific rule may narrow or refine this generic policy when its evidence is stronger. A source-specific rule must not silently reinterpret previously captured SourceAttestations; historical interpretation remains tied to its recorded revisions and context.

## Research limits

The reviewed first-party Colombian sources establish Bancolombia behavior, not a statutory or industry-wide posting guarantee. No official cross-institution CSV/XLSX schema was found. The selected one-day automatic and thirty-day review boundaries are product policy for generic launch evidence, not a representation of universal bank settlement law.

The two personal statement examples were inspected only to establish their structural date fields. No password, personal statement content, account/card identifier, raw financial row, Counterparty, or real Money was copied into this artifact or retained as a research fixture.
