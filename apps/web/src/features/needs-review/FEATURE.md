# Por revisar

Ingestion-only review at `/app/needs-review` uses the selected persistent inbox (Variant A).
The original is escaped text beside the form on desktop, in an expandable section above it on
phones. Media admission retains a locator/caption, not guaranteed image bytes; an unavailable
original permits explicit manual completion only before its original deadline.

Canonical query atoms own inbox, item, taxonomy and browser-only original reads.
The authentication registry owns their lifetime. Navigation polls the complete pending count and
refreshes on window focus. Each mounted panel/page has one NeedsReviewItem decision module in that
registry. It owns pending draft snapshots, debounced saves, acknowledged revisions, individual and
bulk ordering, Undo, and explicit reread recovery. Presentation owns selection and field interaction;
it receives draft/status projections and actions, never queue callbacks or revision coordination.
Bulk skip and individual decisions wait for relevant saves and use their acknowledged revisions.
Route search owns filters and pagination; exhausting a page advances to a populated page.

Item switches and retained-panel hiding preserve pending saves. Actual panel/page disposal and
authentication teardown cancel timers and unsent work immediately and ignore late completions.
Evidence expiry stops further work for that item. Disposal never initiates a final save; an
already-sent mutation may commit, so a subsequent mount reads canonical state. Item uncertainty
blocks that item; bulk uncertainty holds the panel lock until an explicit successful workspace
reread. Failed rereads do not release either lock or replay mutations.
Statement suggestions retain independently validated date, direction and Counterparty facts when
another field needs review; unsafe spreadsheet cells remain unresolved.
Unknown currency remains absent in the draft and requires an explicit selection before creation.
Server revisions prevent stale cross-device replacement. Uncertain acknowledgement stops writes
and requires an explicit canonical reread. Neither originals nor drafts use browser storage.

`ingestion.applyReviewEdit` atomically saves, skips, restores or creates under live authority and
Processing Consent. Bulk decisions are all-or-none; creation stays individual. Skip keeps the draft
and original deadline, and its receipt supplies immediate Undo. Created, skipped and expired items
remain discoverable in history. Confirmed creation shows a “Transacción creada” success toast
and advances to the next pending item without leaving Needs Review.

Statement evidence lasts 24 hours from submission, raw forwarded email 90 days, and media
locator/caption 30 days. Drafts and suggestions share the immutable evidence deadline; scheduled
retention erases them. Conversation routing cannot shorten or extend that purpose. Expired items
require resubmission. Metadata remains within the existing one-year history purpose.

Initial ingestion suggestions remain available when opening a draft. There is no manual reprocessing capability.
Reviewed captures retain the captured context and a manual SourceAttestation referencing the item.
No receipt or email is split into multiple Transactions.

The Variant A workspace exposes Pending and History navigation, with created/skipped/expired
filters inside History. The inbox presents a bounded Counterparty/amount/Currency preview from
retained drafts or suggestions; this preview is suppressed at the original evidence deadline.
The original, inbox and editor use continuous flat surfaces separated by spacing and thin
dividers. Individual actions stay in a separate footer with desktop clearance for the floating agent. The desktop workspace fits the viewport, with overflow contained inside its panels.
Row activation opens the item; only its checkbox toggles bulk selection. The shared calendar edits
the local date while preserving an existing local time; a newly completed date starts at midnight
and exposes the time for editing. Source and text filters apply to the current server page,
whose pagination remains independent of the filtered result count. The bulk toolbar only appears
for a selection, feedback, or Undo; refresh remains available in the navigation.

Pending and History retain separate mounted panels while the workspace is open. Their canonical
queries and first selected items load in parallel; switching panels does not wait for another read
or discard an in-progress pending draft. Workspace queries refresh every minute and on window
focus, and review decisions invalidate both panels. Authentication registry replacement clears
query state. Deadline-owned timers remove the editor and original subscriptions at evidence
expiry, and row previews stop displaying the expired facts. The shared time popover uses the same
button, popover and choice controls as the calendar; it edits exact hours and minutes in 24-hour
local time. Browser acceptance measures a warmed tab switch below 100 ms with delayed requests.

The approved flat v6 presentation uses Confirmar for individual Transaction creation. The manual reprocessing operation and its browser control are removed; original reads, workspace refresh and uncertain-write recovery remain explicit reads.
