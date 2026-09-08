# Notification-email format evidence for safe hint capture

Recorded: 2026-09-08. Related issues: #438, #434, #431.

## Evidence origin and handling

The product owner supplied three raw notification emails during the #438 implementation/design
conversation: a DAVIbank card notification, a BBVA PSE notification, and a RappiCard purchase
notification. This note records structural observations, not the original personal messages.

The originals were inspected as user-provided text. Their displayed SPF/DKIM/DMARC results were
not independently verified. Neither copied headers nor sender text establish authenticity or User
authority. No remote images, links, or stylesheets were fetched.

Do not commit the original emails. They contain recipient addresses, a personal name, transaction
values, dates, suffixes, message identifiers, routing information, and tracking parameters. These
values are intentionally absent from this note and the companion fixtures. Public product names
and field labels are retained because they establish interpretation semantics.

Companion synthetic fixtures live beside their format implementations under
`apps/server/src/shell/ingestion/email-interpretation/formats/*/fixtures/`. They reproduce the
meaningful HTML structures using fictional values, not byte-exact anonymized copies. They omit most layout,
CSS, transport headers, and MIME wrappers. Consequently they are evidence for semantic extraction
examples, not proof of full original-message parsing or provider transformation behavior.

## Observed formats

### DAVIbank card notification

- Outer MIME structure: multipart/mixed containing multipart/related with one UTF-8 HTML part;
  quoted-printable content-transfer encoding.
- The body explicitly says `con tu tarjeta <span>Visa Oro</span>` in a purchase notification.
- A transaction table pairs `Comercio`, `Monto`, `Fecha`, and `Hora` with their values.
- The amount uses a comma separator and contains no explicit Currency in the transaction table.
- The date uses `YYYY/MM/DD`; time includes seconds without an explicit body time zone.
- No account or card suffix was observed in the transaction content.
- Images are external references presented as logos/navigation/decorative content; their bytes
  were not inspected. The financial fields are HTML text.

Expected safe hints:

```text
cardLastFour: absent
accountLastFour: absent
instrumentLabel: visa oro
```

The label is supported by the explicit card sentence, not inferred from the bank name, sender,
Counterparty, or filename.

### BBVA PSE notification

- Outer MIME structure: multipart/mixed containing multipart/related with one UTF-8 HTML part;
  quoted-printable content-transfer encoding.
- Deeply nested presentation tables place field labels and values in sibling column structures.
- Fields include `Tipo de transacción` (`Pago PSE`), `Cuenta terminada en`,
  `Fecha de la operación`, `Establecimiento`, `Valor`, and `Hora`.
- `Cuenta terminada en` is followed by one asterisk and four decimal digits. The observed suffix
  begins with zero. Preserve that structural case using a different fictional suffix in fixtures.
- A separate `Ref` value and footer phone numbers are not account hints.
- Amount has a bare `$`, comma grouping, and dot decimal fraction; the body does not establish an
  unambiguous ISO Currency.
- Date uses `YYYY-MM-DD`; time has minute precision without an explicit body time zone.

Expected safe hints for the fictional fixture:

```text
cardLastFour: absent
accountLastFour: 0012
instrumentLabel: absent
```

`Pago PSE` is a movement/channel description, not an instrument label. The asterisk belongs to the
source representation and is not retained in the decoded suffix.

### RappiCard purchase notification

- One UTF-8 HTML body with quoted-printable transfer encoding and an encoded-word subject.
- The body explicitly says `Realizaste una compra con tu RappiCard`.
- Separate two-column sections contain `Monto`, `Método de pago`, `No. de autorización`,
  `Comercio`, and `Fecha de la transacción`.
- `Método de pago` is one asterisk plus four decimal digits, with a leading zero. Its card meaning
  comes from the explicit purchase-with-RappiCard context; the generic field label alone does not
  establish a card namespace in arbitrary emails.
- The authorization number is a separate field and is never a hint.
- Amount has a bare `$` and a dot separator; no unambiguous ISO Currency appears in the transaction
  content.
- Date/time uses `YYYY-MM-DD HH:mm:ss`, without an explicit body time zone.
- A greeting contains a personal name. It is not needed for interpretation or User resolution.
- External images/links and extensive template markup do not constitute hint evidence.

Expected safe hints for the fictional fixture:

```text
cardLastFour: 0034
accountLastFour: absent
instrumentLabel: rappicard
```

The label is supported by the explicit body sentence, not merely branding or sender identity.

## Product decisions agreed in the conversation

1. Complete account/card numbers must not enter **any ingestion model context**, not only a later
   Reconciliation context. An output schema or prompt instruction is insufficient to enforce this.
2. Unknown, ambiguous, unsafe, and unsupported image-only financial material goes to NeedsReview
   without a raw-email model fallback.
3. Deterministic local interpretation is approved for the three evidenced formats. No language
   model is needed to rediscover their labelled fields. Existing categorization is separate and
   still requires purpose-minimal, validated inputs.
4. For these recognized formats only: explicit unambiguous Currency wins; missing Currency or a
   bare `$` uses COP as an explicit versioned format assumption; conflicting or unsupported
   Currency evidence goes to NeedsReview. This is a deliberate exception to the former
   explicit-Currency-only extraction rule, not a bank-, User-, or ServiceMarket-wide default.
   Retain the interpretation revision and whether Currency came from explicit evidence or a
   format rule. The repository's normative policy/spec updates remain implementation work.
5. Hints remain with the owning immutable SourceAttestation, not normalized Transaction facts.
   Keep card and account suffixes distinct, sharing the same exact-four-ASCII-digit scalar.
   Normalize explicit labels using the #434 policy. Missing hints are explicit absence.
6. Statement hint extraction is deferred: the owner reports their banks supply encrypted PDF
   statements, not CSV/XLSX; encrypted PDF support is outside the agreed work. This is an observation
   about the owner's evidence, not a universal claim about banks. Existing CSV/XLSX ingestion is
   not evidence of a real institution's hint layout and is not removed by this decision.
7. Automatic linking and User questions remain out of this implementation. Do not mark all of
   original #438 complete while its statement acceptance criteria remain deferred.
8. Easy extension to many formats is required. The accepted design uses co-located format modules
   discovered at build time into a generated static catalog. There is no handwritten global format
   union/registration list, runtime filesystem loading, or generic extraction DSL.

## What these examples do not prove

- Full card/account-number layouts, prefix retention, arbitrary masked representations, multiple
  conflicting instruments in one email, or image-only extraction.
- Other templates from these institutions, international-purchase templates, or future revisions.
- How Resend presents an original versus user-forwarded message (including whether MIME decoding,
  quoted-printable decoding, and forwarding wrappers have already been handled). Verify the real
  receiving-adapter contract before adding raw MIME parsing to application code.
- Universal protection against sensitive values embedded in open-ended Counterparty/label prose.
  A recognized template is not a blanket privacy certificate for its contents.
- Definitive time-zone or event-time semantics from body text alone. Header receipt times must not
  silently replace the stated transaction time; use the applicable captured-context policy.

## Test plan supported by the evidence

At the agreed interpretation seam, use the synthetic fixtures to prove the three hint cases,
leading-zero preservation, exact field association, HTML entities/nested tags, explicit absence,
and Currency basis. Add separately labelled adversarial mutations for full numbers, malformed
suffixes, overlong labels, duplicate/conflicting fields, misleading reference/authorization
numbers, hidden text/attributes, and ambiguous recognition. Such mutations prove rejection for
those cases; they do not expand supported source formats.

At the real-PostgreSQL ingestion/API seam, prove exact prospective persistence, source-attached
retention, immutable attestations, replay safety, and explicit User isolation. Assert no raw-email
model call and no unsafe data in any downstream model request, errors, or telemetry. Keep external
provider/model substitutions at their actual seams; do not mock repositories or owner operations.
