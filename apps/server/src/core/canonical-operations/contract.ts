import { Schema } from "effect";

export const CanonicalOperationId = Schema.String.check(
  Schema.isPattern(/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/u)
)
  .pipe(Schema.brand("CanonicalOperationId"))
  .annotate({ identifier: "CanonicalOperationId" });

export type CanonicalOperationId = typeof CanonicalOperationId.Type;

export const CanonicalCapability = Schema.Literals(["read", "write", "dashboard"]).annotate({
  identifier: "CanonicalCapability",
});

export type CanonicalCapability = typeof CanonicalCapability.Type;

export const CanonicalCapabilities = Schema.UniqueArray(CanonicalCapability)
  .check(Schema.isNonEmpty())
  .annotate({ identifier: "CanonicalCapabilities" });

export type CanonicalCapabilities = typeof CanonicalCapabilities.Type;

export const allCanonicalCapabilities: CanonicalCapabilities = CanonicalCapabilities.make([
  "read",
  "write",
  "dashboard",
]);

export const canonicalCapabilitiesFromPATScopes = (
  scopes: ReadonlyArray<CanonicalCapability>
): CanonicalCapabilities => CanonicalCapabilities.make([...scopes]);
