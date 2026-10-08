# Selected stable Effect source

The application uses exact **effect@4.0.0**, coordinated platform/SQL/Atom packages at
4.0.0 and **alchemy@2.0.0-beta.80**. Topic notes cite source files and symbols in these selected
packages. Verify against the installed release before adopting an upstream example; matching
package version strings alone do not establish identical source.

The npm artifacts include upstream TypeScript source. The frozen lock records integrity;
#978 compared every new resolved identity with its registry integrity. Current primary
sources are `node_modules/effect/src`, `node_modules/@effect/atom-react/src` and
`node_modules/alchemy/src` (and its patched `lib` counterpart).

`.repos/effect` is refreshed to upstream main **43416c4142**, which declares 4.0.0 but differs from
the published 4.0.0 source. Use it for upstream tests, examples, and investigation, not as proof that
a newer behavior exists in the pinned application. `.repos/alchemy` remains an older snapshot;
the installed beta.80 source plus `patches/alchemy@2.0.0-beta.80.patch` defines the selected behavior.
For a fresh checkout, install the admitted frozen graph first. Published source is also
available at `https://unpkg.com/effect@4.0.0/src/<module>.ts` and
`https://unpkg.com/alchemy@2.0.0-beta.80/src/<module>.ts`; the latter does not contain Fidy's patch.

| Topic                    | Current public namespace / source                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| HTTP                     | `effect/http`; `src/http/{HttpClient,HttpClientRequest,HttpClientResponse,FetchHttpClient}.ts`  |
| API / OpenAPI            | `effect/http-api`; `src/http-api/{HttpApi,HttpApiClient,OpenApi}.ts`                            |
| SQL                      | `effect/sql`; `src/sql/SqlClient.ts`; installed `@effect/sql-d1` source                         |
| Atom / Reactivity        | `effect/reactivity`; `src/reactivity/{Atom,AtomRegistry,AtomHttpApi,AsyncResult,Reactivity}.ts` |
| React bindings           | `@effect/atom-react`; `src/{Hooks,RegistryContext}.ts`                                          |
| Inference                | `effect/ai`; `src/ai/{LanguageModel,Prompt,Response,Tool,Toolkit}.ts`                           |
| Model / schema compilers | `effect/schema`; `src/schema/Model.ts` and the compiler sources                                 |
| Arbitrary                | `effect/Arbitrary`; `src/Arbitrary.ts`                                                          |
| Processes                | `effect/process`; `src/process/ChildProcess.ts`                                                 |
| Encoding                 | `effect/encoding`; `src/encoding/{Hex,Base64Url,EncodingError}.ts`                              |
| Alchemy CLI              | `node_modules/alchemy/bin/alchemy.js` → public `alchemy/Cli/main`                               |

## Migration-sensitive behavior

- `Encoding` is gone. Use `Hex.encode`, `Hex.decode`, `Base64Url.encode`,
  `Base64Url.decode` and `Base64Url.decodeString`. Decoders still return Result, not throwing
  parsers. Keep byte/encoded bounds and closed failure mapping. `Hex.random` is not crypto;
  credentials still originate from Crypto/Web Crypto. Decode text only for a text protocol.
- `Schema.isStartingWith` replaces `isStartsWith`; `isBetweenLength` replaces
  `isLengthBetween`. String length checks count UTF-16 units. JSON Schema projection uses
  safe code-point bounds; compare generated contracts with actual decoding, not raw refs.
- `Schema.brand` is nominal/type-only, takes a concrete literal and adds no AST annotation.
  Preserve explicit identifiers. Never assume a brand supplies a schema identifier or check.
- `Schema.isPattern` only projects supported Unicode-mode regexes into JSON Schema.
  The ASCII-only Money, canonical-ID and PAT patterns use `u`; their public reflection test
  protects the projection. Review flags for semantic changes before applying this elsewhere.
- Money still owns plain decimal, Currency-aware bidirectional encoding. Stock BigDecimal
  formatting can use exponent notation; do not substitute it for the owner codec.
- `OptionFromOptionalKey` permits omitted query keys. Stable OpenAPI now describes that
  optionality correctly. A documentation flag must not add a runtime default or authority.
- `AtomHttpApi` still turns Schema/low-level HTTP failures into defects while retaining declared
  endpoint failures. The session registry remains the isolation boundary. React registry
  disposal remains delayed 500 ms; it is not credential revocation. Web transport/lifetime
  tests exercise these behaviors against the stable distribution.
- With Bun, beta.80's `bin/cli.js` launcher forces its package TS config globally and loses
  Fidy's `~` aliases. Invoke its `bin/alchemy.js` entrypoint directly with the pinned Bun;
  it calls the public main/runMain interfaces without a custom loader or fallback runtime.
  Real local-emulation tests exercise the actual stack and ingress-to-Core binding.
- The retained beta.80 WorkerProvider patch validates stored `output.versionId` with
  `workers.getScriptVersion` and carries the upload receipt forward. There is no beta.79
  patch or alternate provider implementation. The patch also adds explicit deferred/cleanup-only
  Apply phases through the public SDK; actual-engine fixture tests cover tracked generations,
  dependency ordering and refusal before mutation. Import success is not live deployment parity.

Stable package version does not mean every individual module is upstream marked stable.
Keep exact pins, owned boundaries, focused behavior tests and the complete release gates.
See `docs/research/effect-4-stable-integration.md` for verified outcomes and limitations.
