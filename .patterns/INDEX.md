# Source-backed implementation references

Read the pattern for the area you are changing, then use its cited source in the matching checkout to verify API behavior and idiomatic usage. Add an entry when researching an area not yet covered.

For Effect/Alchemy, first read [the selected stable source map](effect-4-stable.md). Current
API authority is the integrity-locked published TypeScript source in the installed 4.0.1 / beta.80
packages, including Fidy's Alchemy patch. `.repos/effect` is a refreshed upstream-main reference;
it is not byte-identical to the pinned release. `.repos/alchemy` remains an older snapshot.
React's application contract is 19.3.0; `.repos/react` remains a historical 19.2.8 snapshot.
Use installed public exports/types and official React documentation for application APIs. The
[source manifest](sources.json) records all four snapshots, selected versions, provenance, patch
digests and verification dates. A matching version alone does not prove byte-identical source.

| Area                                                               | Pattern                                    |
| ------------------------------------------------------------------ | ------------------------------------------ |
| Effect v4 core, generators, Promise interop, scopes, cancellation  | [effect-core.md](effect-core.md)           |
| Outbound HTTP clients, retries, redirects, bounded responses       | [http-client.md](http-client.md)           |
| HttpApi operations, typed clients, OpenAPI, middleware, testing    | [http-api.md](http-api.md)                 |
| Schema, JSON codecs, brands, models, Money                         | [schema.md](schema.md)                     |
| SQL, D1 batches, and atomic mutation units                         | [sql.md](sql.md)                           |
| Native Cloudflare Workflows and Effect step boundaries             | [workflows.md](workflows.md)               |
| Crypto, encoding, redacted secrets                                 | [crypto-encoding.md](crypto-encoding.md)   |
| AI model, tools, toolkit, Workers AI boundary                      | [ai.md](ai.md)                             |
| MCP transport, protocol negotiation, canonical tools, confirmation | [mcp.md](mcp.md)                           |
| CLI child processes, bounded output, scoped termination            | [processes.md](processes.md)               |
| Layers, services, config, Workers runtime assembly                 | [layers-runtime.md](layers-runtime.md)     |
| Typed errors, Cause, Result                                        | [errors.md](errors.md)                     |
| Fibers, queues, schedules, rate limits, clocks                     | [concurrency-time.md](concurrency-time.md) |
| Streams, incremental encoding, backpressure                        | [streams.md](streams.md)                   |
| Tracing, logging, metrics                                          | [observability.md](observability.md)       |
| Effect Vitest, TestClock, test layers                              | [testing.md](testing.md)                   |
| Effect Atom, React atoms, auth-lifetime isolation                  | [effect-atom.md](effect-atom.md)           |
| Alchemy resources, bindings, Cloudflare deployment topology        | [alchemy.md](alchemy.md)                   |
| dnd-kit drag and drop                                              | [dnd-kit.md](dnd-kit.md)                   |
| Astro static documents, metadata and React islands                 | [astro.md](astro.md)                       |
| React component behavior and runtime                               | [react.md](react.md)                       |

## Maintaining a pattern

Use a short, source-backed shape: when to use; public imports and selected source symbols; one
minimal recipe or a linked existing owner implementation; failure, lifetime and size behavior;
and the test seam. Keep library mechanics beside their caveats and distinguish them from Fidy's
ownership policy. New pages get an index entry in the same change. Add APIs when a real decision or
dangerous default needs guidance; optional APIs need selection criteria, not a new implementation.

Run `bun run check:pattern-sources` after editing the catalog or changing its package pins. The
static verification group checks declared snapshot/application versions, retained patch digests,
listed source paths, local Markdown file links and index coverage. It does not prove API semantics,
validate line/heading anchors, or fetch upstream. Recheck named symbols against the selected release
and patch before updating `sources.json` and its verification date. Preserve a historical snapshot's
version and provenance until its actual source changes; record missing upstream provenance honestly.
