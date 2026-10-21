# Feature storage cutovers preserve authority and historical meaning

The feature designs indexed in [#1394](https://github.com/B4rz99/fidy-ai/issues/1394) separate stable
Identity from feature-owned state. Coupled records and their production callers move together on
`refactor/schema-low-medium`, with [#1494](https://github.com/B4rz99/fidy-ai/issues/1494) blocking the
final release. A smaller table or column count cannot justify inferred authority, lost evidence,
or an intermediate extraction release. The [implementation contracts](../operations/database-cutover-1428.md)
record the owners, typed keys, cyclic relationships and preservation gates.

For account deletion, accepted #1425 supersedes selective retention and content archives. Ordinary
feature retention remains unchanged. Existing archive content can be removed only through the
explicit conversion after independent minimal deletion markers and restore enforcement are proven;
SQL rollback cannot reverse external object deletion. Cloudflare Workflows can pace execution,
but cannot replace same-User database guards, provider outcome evidence or restore protection.

The missing current WhatsApp route destination is a documented proposal for review, not an accepted
new table. Its approval gates route extraction and completion of #1428; it does not authorize
changing the already accepted service-window or delivery lifecycles.
