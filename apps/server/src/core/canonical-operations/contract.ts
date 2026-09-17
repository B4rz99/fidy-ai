import { Schema } from "effect";

/** The canonical operation identity recorded as `<group>.<operation>`. */
export const CanonicalOperationId = Schema.String.check(
  Schema.isPattern(/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/)
)
  .pipe(Schema.brand("CanonicalOperationId"))
  .annotate({ identifier: "CanonicalOperationId" });
export type CanonicalOperationId = typeof CanonicalOperationId.Type;

/** One credential-neutral capability enforced by canonical operation policy. */
export const CanonicalCapability = Schema.Literals(["read", "write", "dashboard"]).annotate({
  identifier: "CanonicalCapability",
});
export type CanonicalCapability = typeof CanonicalCapability.Type;

/** A non-empty capability set with no repeated authority. */
export const CanonicalCapabilities = Schema.UniqueArray(CanonicalCapability)
  .check(Schema.isNonEmpty())
  .annotate({ identifier: "CanonicalCapabilities" });
export type CanonicalCapabilities = typeof CanonicalCapabilities.Type;

/** The complete fixed authority of every hosted Turn. */
export const allCanonicalCapabilities: CanonicalCapabilities = CanonicalCapabilities.make([
  "read",
  "write",
  "dashboard",
]);

/** Translates the public PAT scope vocabulary at the authentication edge. */
export const canonicalCapabilitiesFromPATScopes = (
  scopes: ReadonlyArray<CanonicalCapability>
): CanonicalCapabilities => CanonicalCapabilities.make([...scopes]);
