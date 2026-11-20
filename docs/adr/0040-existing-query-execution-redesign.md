# Existing queries select and commit the facts they need together

**Status** Accepted query-design direction. The shared D1 implementation is historical.

Improve existing canonical queries by selecting complete, bounded facts at their owning boundary.
Group exact aggregate ranges and read repeated selections once per request. Keep request-local
work within its owning read, with no change to the authority or lifetime of a retained response.
When a financial view relies on multiple owner facts, verify the exact authority, calendar and
revision before disclosure and commit the required Audit with the protected result.

Original-material reads cross a storage boundary. Select and authorize the owned locator in a
protected snapshot. Retrieve bytes under the bounded lease and recheck authority, eligibility and
retention before final accounting and disclosure. The separate browser-cookie binding check still
protects adoption of a prefetched startup response.

[ADR 0039](0039-fresh-read-performance-contract.md) owns performance acceptance.
[ADR 0041](0041-per-user-durable-object-storage-direction.md) owns the current runtime boundary.
The old round-trip counts, R2 generation checks and placement experiments remain in the
[historical D1 design](https://github.com/B4rz99/fidy-ai/blob/f04053571f9f6b4e0ca2d3f891f518880cc6551a/docs/adr/0040-existing-query-execution-redesign.md).
