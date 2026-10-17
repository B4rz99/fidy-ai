# Monarch web review and ingestion UX

Recorded: 2026-10-15. Scope: public first-party documentation and product announcements;
no authenticated Monarch account or live web application was inspected. Findings describe the
documented behavior, not independently observed UI geometry or interaction timing. This is a
research snapshot, not a product decision or implementation specification.

## Transaction review on web

Monarch's Needs Review flags existing Transactions for attention, manually, by rules, or through
preferences for newly synced/uncategorized Transactions. The current help article was updated
October 15, 2026. Its web path is **Transactions → Filter → Other → Needs review by**, choosing
anyone, yourself, or a household member. A checkmark beside a row marks it reviewed. Bulk review
uses **Edit Multiple → select rows → Edit → Review Status → Save**; statuses include No change,
Needs review, and Reviewed. An existing Transaction can be flagged again in its details using
Needs review by. The documented swipe interface is explicitly mobile: Dashboard banner,
edit as needed, then Mark as reviewed or Skip for now. The latter defers review; the article does
not describe an archive or restore history. It does not establish web automatic next-item
navigation or keyboard shortcuts. [Reviewing Transactions](https://help.monarch.com/hc/en-us/articles/5528707082516-Reviewing-Transactions)

Single-Transaction detail edits save immediately. Documented editable fields include merchant,
category, date, notes, and tags; actions include splitting and attachments. The article does not
establish that all bank-supplied fields, including amount/account, are editable. Bulk edits have
a Save and review-summary step. [Editing Transactions](https://help.monarch.com/hc/en-us/articles/360048393532-Editing-Transactions)

Hiding is separate from review: a hidden Transaction still exists and can still need review;
review filters include hidden Transactions. This is not a direct model for Fidy's proposed skip,
which creates no Transaction. [Hiding or Unhiding Transactions](https://help.monarch.com/hc/en-us/articles/4405041904916-Hiding-or-Unhiding-transactions)

## Receipts: the closer ingestion comparison

On web: **Transactions → Receipts → Upload a file → open uploaded receipt**. Extracted details
can be reviewed/edited: merchant, amount, date, subtotal, tax, tip, and applicable line items.
Image uploads and forwarded emails share matching behavior. Unmatched receipts continue trying
to match newly posted Transactions; users can choose **Add transaction** or **Find match**.
Monarch warns against creating a Transaction when a bank charge is still expected to post.
Forwarded email content becomes a visual image accessible on the receipt record. Receipts and
Transactions can be deleted independently. An extraction failure produces a Receipt import error
notification and guidance to resend clearer/original material. The article does not document a
skipped-receipt archive, undo/restore semantics, or evidence expiry policy.
[Importing Receipts into Monarch](https://help.monarch.com/hc/en-us/articles/44244210547860-Importing-Receipts-into-Monarch),
also retrieved through its [public help-center API](https://help.monarch.com/api/v2/help_center/en-us/articles/44244210547860.json)
(updated October 14, 2026).

The July 29, 2026 announcement documents receipt matched/pending status, manual matching and
receipt detail/split editing. It also announces a web Transaction Activity section tracing edits
and pending-to-posted changes; this is an audit timeline, not documented rollback. Retail Sync
was moved to a web tab with linking/unlinking to Transactions.
[July product update](https://www.monarch.com/blog/july-product-update)

Monarch supports attachment uploads inside expanded Transaction details, automatically saved;
this establishes access to original material but does not prove a persistent side-by-side
document-and-form layout.
[Adding Notes and Attachments](https://help.monarch.com/hc/en-us/articles/360056422791-Adding-Notes-and-Attachments-to-a-Transaction)

## CSV validation and failures

The web CSV importer suggests column mappings for review and lets users assign accounts and
categories before a final summary. Missing/duplicate required columns prompt file repair;
specific import errors instruct users to fix the spreadsheet. This documentation does not
describe a row-level ingestion repair queue. The March 2026 article describes imports as not
undoable; July's newer announcement adds ID-based updates on CSV re-import, so older import
documentation should not be treated as complete current behavior.
[Importing Transaction History](https://help.monarch.com/hc/en-us/articles/4409682789908-Import-Transaction-Data-Manually-from-Banks-or-Other-Finance-Apps),
[July product update](https://www.monarch.com/blog/july-product-update)

## Recommendations for Fidy — not approved decisions

- Borrow the receipts pattern: extracted fields plus original material, followed by an explicit
  action. Fidy's existing agreement to create a Transaction on resolution needs a clear commit
  point; Monarch's autosaved Transaction edits are a different lifecycle.
- Keep the agreed Pending and Skipped history states distinct from Transactions. Monarch's
  ordinary Needs Review is an attention flag on an existing Transaction.
- Decide how to handle evidence that may already correspond to a Transaction. Monarch's
  separate Add transaction and Find match actions expose the duplication risk clearly. Whether
  Fidy needs matching in this view requires its own domain decision.
- Consider advancing to the next pending item after successful creation/skipping, with clear
  completion and undo feedback. This is a Fidy recommendation; current public docs did not
  verify that behavior on Monarch web.
- Preserve the agreed restoration-until-expiry behavior independently of Monarch. Public docs
  found here do not establish an equivalent expired-evidence or skipped-history experience.
