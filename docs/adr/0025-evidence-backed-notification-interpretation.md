# Evidence-backed notification interpretation

Notification-email interpretation uses one deterministic, in-process interface over bounded email
content and captured interpretation context. Independently authored, evidence-backed format modules
are discovered at build time into a generated static catalog; callers do not supply format lists,
maintain global format unions, or dispatch by institution. This chooses authoring locality without
runtime plugin loading or a generic institution framework, over handwritten registration and an
explicit growing decision tree.

Each format owns an immutable id/revision, required structural anchors, recognition, interpretation,
and fixtures. Shared mechanics own bounded inert HTML parsing, candidate lookup, ambiguity handling,
validation, and safe result projection. Unknown, ambiguous, unsafe, over-budget, and unsupported
image-only financial material becomes NeedsReview without raw-email model fallback. Recognition
selects interpretation rules; it never authenticates a bank or establishes User authority. Neither
first-match ordering nor dropping an invalid competing format may manufacture a unique match.

The first supported formats are the DAVIbank card notification, BBVA PSE notification, and RappiCard
purchase notification documented in [the evidence note](../research/notification-email-format-evidence.md).
For those recognized revisions, missing Currency or a bare `$` means COP under an explicit format
rule; explicit unambiguous Currency takes precedence and conflicting/unsupported Currency goes to
review. This deliberately replaces explicit-Currency-only email extraction for these formats, not
for arbitrary emails or statements. Capture retains Currency basis and interpretation revision with
immutable SourceAttestation evidence, along with approved safe account hints. Transaction facts do
not acquire account identity.

Complete financial identifiers must not enter any model context, including downstream categorization;
removing the raw-email model alone is insufficient. Raw IngestSample retention remains separately
bounded and purpose-specific. No historical SourceAttestation is rewritten. Initial implementation
scope excludes statement hint capture, encrypted PDFs, automatic linking, and User questions; #438
must not be closed as fully satisfied while its original statement requirements remain deferred.

Build generation and freshness/collision checks replace manual registration. Financial extraction
remains ordinary reviewed TypeScript, not a speculative template language. New formats still require
evidence, adversarial fixtures, review, and deployment. Shared interpretation changes require a new
revision; generated discovery removes central editing, not the cost of maintaining formats.
