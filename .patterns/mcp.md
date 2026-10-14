# Effect MCP transport and canonical tools

Use when changing MCP ingress, tool registration, protocol negotiation or native confirmation.
Import `McpServer`, `McpSchema` and `McpProtocol` from `effect/ai`; HTTP assembly uses
`HttpRouter` from `effect/http`. Selected Effect 4.0.2 sources:
`node_modules/effect/src/ai/{McpServer,McpSchema,McpProtocol}.ts`. Verify `layerHttp`,
`McpServer.addTool`, `McpRequestContext`, `InputRequired` and the selected protocol adapters.

## Existing assembly recipe

Follow `createOwner`, `residentRegistration` and `executeAdmittedTool` in the
[MCP runtime](../apps/server/cloudflare/mcp/runtime.ts):

1. Authenticate OAuth at ingress, cap and decode the request, and transfer admitted work into the
   existing User execution boundary. MCP tool annotations are hints, not authorization.
2. Derive tool names, schemas and availability from the canonical operation catalog. Register each
   through `McpServer.McpServer.addTool`; dispatch into the canonical operation owner rather than a
   second repository or provider path. Recheck caller authority on invocation.
3. Build `McpServer.layerHttp` with an explicit path, origin policy and `protocols` list. The current
   owner selects `McpProtocol.v2026_07_28` and `v2025_11_25`; these have different transport and
   confirmation semantics. Negotiation does not permit assuming one protocol's request shape.
4. Compose registration and the server Layer into `HttpRouter.toWebHandler`. Retain the returned
   handler and disposer under the resident owner, with bounded owner count and expiry. A Response
   header is not completion: streaming bodies retain a lease until completion or cancellation.

## Confirmation and failures

Read `McpSchema.McpRequestContext` inside the invocation, not when caching tool metadata. It supplies
negotiated protocol, client capabilities and continuation metadata. Follow
[readNativeConfirmation/requestNativeConfirmation](../apps/server/cloudflare/mcp/native-confirmation.ts):
modern `InputRequired` carries keyed continuation state; the legacy path uses the reverse client's
`elicit`. Both paths return evidence to the existing confirmation authority. Neither a client's
claimed capability nor an accepted form grants caller scope or bypasses confirmation expiry/binding.

Decode bounded operation results into their declared success/failure schemas before constructing
`McpSchema.CallToolResult`, including `structuredContent`. Project failure to safe declared tool
content or `McpSchema.InternalError`; never return raw causes, provider bodies or bearer material.

## Lifetime and tests

Carry request interruption into canonical work, bound execution and transport separately, and dispose
resident protocol handlers when retired. Cancellation must settle readers and release leases; it
cannot undo an already-committed operation. Keep protocol state scoped to the admitted caller binding,
not a global authenticated-tool cache.

Exercise the runtime through its HTTP handler with canonical dispatch substituted: cover both
negotiated protocols, unsupported negotiation, malformed/big bodies, unavailable tools, revoked caller,
confirmation decline/expiry/replay, client disconnect during streaming and disposal while leased.
Assert safe protocol failures and no additional operation execution. Source-backed assembly describes
library mechanics; OAuth authority, canonical admission and residency limits are Fidy policy.
