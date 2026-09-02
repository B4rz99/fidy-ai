# Reversible Reconciliation prototype decision

Decision date: 2026-08-31

Scope: issue [#433](https://github.com/B4rz99/fidy-ai/issues/433), refining [#431](https://github.com/B4rz99/fidy-ai/issues/431). The interactive primary source is preserved in prototype commit `cdce821db7` at `apps/server/src/core/transactions/reconciliation-prototype.html`; the throwaway HTML is intentionally absent from the retained tree. This artifact decides presentation, reversibility, User fact authority, and remembered User decisions. It does not implement production Reconciliation.

## Plain-language decision

Reconciliation puts a reversible link between two original Transactions that describe one real-world purchase. It does not combine, rewrite, or delete either original. While linked, ordinary history and calculations show one effective purchase. Removing the link restores both current originals.

The product uses two decision paths:

1. Automatically link one deterministically obvious pair.
2. Leave every unclear pair visible until the User decides.

There is no model-judgment rung. A model does not choose, rank, or assign confidence to a pair.

## Concrete scenario

Fidy first captures notification Transaction `tx-email-100`, then captures statement Transaction `tx-statement-200` for the same COP 45,000 outflow.

### Before linking

Ordinary history returns both originals:

| visible id         | source             | Money      | date      |
| ------------------ | ------------------ | ---------- | --------- |
| `tx-email-100`     | notification email | COP 45,000 | 12 August |
| `tx-statement-200` | statement row      | COP 45,000 | 13 August |

Each contributes independently to Dashboard and Budget calculations.

### While linked

Ordinary history returns one effective purchase:

| visible id     | identity authority        | Money/date authority                                        |
| -------------- | ------------------------- | ----------------------------------------------------------- |
| `tx-email-100` | earliest-created original | statement original, unless the User later corrects the fact |

Both originals remain stored. The link suppresses the later-created member from ordinary history and calculations; it does not alter that Transaction.

### After unlinking

Ordinary history again returns both original ids. Each original contains its current independently retained facts. The implementation does not reconstruct either one from a snapshot.

Unlinking is also an explicit User decision that the pair must remain separate. It therefore supersedes the link with a keep-separate decision, preventing automatic relinking or another question for the same pair.

## Visible identity and reads

The **anchor** is the earliest-created Transaction. It remains the visible identity while linked. If creation instants are equal, ascending TransactionId is the deterministic tie-breaker.

Ordinary list operations return only the effective Transaction under the anchor id. Dashboard and Budget Transaction reads use the same effective projection and count it once.

A get using either member id succeeds:

- getting the anchor returns a `visible-member` result whose Transaction id is the visible id;
- getting the other member returns a `suppressed-member` result containing the requested id and the same effective Transaction under the anchor's visible id.

The public result must explain the relationship rather than silently returning a Transaction whose id differs from the requested id. Before and after a link, either id returns its independent Transaction normally.

Conceptual get result:

```text
independent
  transaction

or

visible-member
  transaction

or

suppressed-member
  requestedId
  transaction (whose id is the visible id)
```

This is a presentation result, not a new domain entity. The link itself remains state over the exact unordered Transaction pair and has no standalone identity.

## Provenance

Every SourceAttestation remains immutable and attached to its original TransactionId.

While linked, asking for provenance through either member id returns the retained SourceAttestations discoverable for the whole effective purchase. Each returned SourceAttestation still carries its original `transactionId`; none is copied, moved, or rewritten.

After unlinking, provenance through each id again returns only the SourceAttestations attached to that original Transaction.

Evidence retention, suppression, anonymisation, and deletion continue to follow their own existing purpose and policy. Reconciliation never overrides them.

## Effective field authority

Field authority is independent of visible identity. Making the earliest Transaction the anchor does not make all of its fields authoritative.

Use this order:

| effective fact | selected value                                                                       |
| -------------- | ------------------------------------------------------------------------------------ |
| Money          | statement value; a later explicit User correction wins                               |
| posting date   | statement value; a later explicit User correction wins                               |
| Category       | latest explicit User selection or correction; otherwise the existing automatic value |
| Counterparty   | latest explicit User selection or correction; otherwise the existing automatic value |
| notes          | latest explicit User value or correction                                             |
| direction      | compatible before linking; a later explicit User correction wins                     |

Production persistence needs only enough private field-authority facts to distinguish explicit User work from automatic extraction or categorization. Those facts do not enter public Transaction responses, logs, AuditLogEntries, or model context.

Field authority is not a Category keyword rule. Linking, correcting, or unlinking a Transaction never silently creates a rule for future Transactions.

## Deterministically obvious versus unclear

The timing and candidate exclusions from [#432](../research/reconciliation-statement-timing.md) and [#434](../research/reconciliation-account-hints.md) remain hard gates. Different Currency, different exact Money, different direction, disallowed timing, conflicting safe hints, a different User, ineligible link state, or a keep-separate decision means the pair cannot automatically link.

A pair is deterministically obvious only when:

1. its statement date is the notification date or the following civil date;
2. exactly one eligible opposite-source candidate remains; and
3. there is no account-hint conflict.

Counterparty text may help the User understand a question, but it is not fuzzy-matched or treated as a hard identity check. There is no alias inference, substring matching, or model judgment.

An otherwise eligible pair is unclear when it has multiple possible candidates, falls in the two-through-thirty-day User-review window, or exceeds the bounded candidate set. Both Transactions remain visible and a bounded pending question waits for the User.

## User decision memory

One pair has one current decision:

```text
undecided -> linked
undecided -> pending User decision
pending User decision -> linked
pending User decision -> keep separate
linked -> keep separate       (manual unlink)
keep separate -> linked       (explicit User link only)
```

`keep separate` stores only the ordered pair of Transaction ids and metadata needed for lifecycle and accountability. It stores no model prose, prompt, confidence, raw evidence, Money, Counterparty, notes, or User answer text.

A keep-separate decision has no timer. Capture retries, another matching pass, time passing, automatic categorization, and explicit corrections to either Transaction do not invalidate it. A correction changes facts; it does not mean the User changed their decision that these are two real-world purchases.

Only an explicit User-authorized link supersedes keep-separate state. Removing either Transaction makes the pair inapplicable under that Transaction's existing lifecycle, without rewriting historical SourceAttestations or accountability evidence.

## User questions

An unclear pair creates at most one pending question for that pair. Both Transactions remain independently visible and counted while it is unanswered.

Questions are never sent proactively. At most three appear in the next User-initiated WhatsApp Turn, and authorized User-owned agents can list and answer the same questions through canonical operations.

The answer choices are:

- `same purchase`: create the reversible link;
- `different purchases`: retain both and remember keep-separate;
- no answer: change nothing and leave the question available without conversationally repeating it in every Turn.

## Interface owned by the future deep module

One Transaction-owned effective-reading module must hide link suppression, visible-id resolution, provenance traversal, and field selection. Its conceptual interface provides these behaviors:

```text
list effective Transactions
get a Transaction presentation by either original id
list discoverable SourceAttestations by either original id
read effective facts for Dashboard and Budget calculations
```

Callers do not select anchors, suppress linked members, combine provenance, or reproduce field-authority rules themselves.

Canonical mutations operate on an exact same-User pair:

```text
link first Transaction id + second Transaction id
unlink first Transaction id + second Transaction id
```

Link validates current eligibility. Explicit User link may supersede keep-separate. Unlink removes the link and records keep-separate atomically so background work cannot immediately recreate it.

## Rejected alternatives

### Always expose the statement Transaction id

Rejected because a reference exposed before statement capture would unexpectedly stop being the visible identity. Field authority does not require identity authority.

### Return not-found for the non-anchor member

Rejected because callers may have retained that id before linking. The id remains owned and valid; get explains its visible anchor instead of breaking the reference.

### Move SourceAttestations to the anchor

Rejected because that rewrites provenance. Discoverability is a read behavior, not evidence reassignment.

### Let corrections clear keep-separate

Rejected because changing Category, notes, Money, date, or another fact does not withdraw the User's decision that the pair represents two purchases. Re-asking would nag the User.

### Model judgment at 0.90 confidence

Rejected for the MVP. It adds cost, confidence policy, provider failure, stale model result, prompt minimization, and explanation complexity to a decision that can hide a real Transaction. Deterministic evidence may link; otherwise the User decides.

### Unlink without keep-separate

Rejected because unchanged automatic matching could recreate the link the User just removed.

## Consequences for the issue sequence

The model-free decision requires coordinated issue updates:

- #431 and originating #23 must remove the model rung and confidence threshold.
- #434's safe hints, comparison, candidate bounds, and work bounds remain useful; its model projection and model-dependent outcomes are superseded.
- #435 must own the explanatory get result and provenance traversal in addition to list/calculation centralization, without changing the public contract until link behavior is introduced.
- #436 remains valid and should use the field-authority order above.
- #437 must make unlink atomically record keep-separate and must expose the selected get presentation when link behavior becomes public.
- #438 remains valid except model-related test wording must be removed.
- #439 must route every unclear pair to pending User review and remove model-call assertions.
- #440 is obsolete and should close as not planned.
- #441 should depend on #439 rather than #440, remove model references, retain keep-separate across corrections, and let explicit linking supersede it.
