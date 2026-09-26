# Source-backed implementation references

Read the pattern for the area you are changing, then use its cited source in the matching checkout to verify API behavior and idiomatic usage. Add an entry when researching an area not yet covered.

Full upstream checkouts: Effect → `.repos/effect`; Alchemy → `.repos/alchemy`; React 19.2.8 → `.repos/react`. For React application code, treat the installed public API and official React documentation as the application-facing contract.

| Area                                                              | Pattern                                    |
| ----------------------------------------------------------------- | ------------------------------------------ |
| Effect v4 core, generators, Promise interop, scopes, cancellation | [effect-core.md](effect-core.md)           |
| Outbound HTTP clients, retries, redirects, bounded responses      | [http-client.md](http-client.md)           |
| HttpApi operations, typed clients, OpenAPI, middleware, testing   | [http-api.md](http-api.md)                 |
| Schema, JSON codecs, brands, models, Money                        | [schema.md](schema.md)                     |
| SQL and a future D1 adapter                                       | [sql.md](sql.md)                           |
| Durable workflows, activities, compensation                       | [workflows.md](workflows.md)               |
| Crypto, encoding, redacted secrets                                | [crypto-encoding.md](crypto-encoding.md)   |
| AI model, tools, toolkit, Workers AI boundary                     | [ai.md](ai.md)                             |
| Layers, services, config, Workers runtime assembly                | [layers-runtime.md](layers-runtime.md)     |
| Typed errors, Cause, Result                                       | [errors.md](errors.md)                     |
| Fibers, queues, schedules, rate limits, clocks                    | [concurrency-time.md](concurrency-time.md) |
| Streams, incremental encoding, backpressure                       | [streams.md](streams.md)                   |
| Tracing, logging, metrics                                         | [observability.md](observability.md)       |
| Effect Vitest, TestClock, test layers                             | [testing.md](testing.md)                   |
| Effect Atom, React atoms, auth-lifetime isolation                 | [effect-atom.md](effect-atom.md)           |
| Alchemy and Cloudflare deployment topology                        | [alchemy.md](alchemy.md)                   |
| dnd-kit drag and drop                                             | [dnd-kit.md](dnd-kit.md)                   |
| React component behavior and runtime                              | [react.md](react.md)                       |
