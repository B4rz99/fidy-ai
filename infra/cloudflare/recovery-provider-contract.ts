import { Schema } from "effect";

const maximumNames = 128;
const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/u));
const Version = Schema.String.check(Schema.isUUID());
const NamespaceId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
export const RecoveryProviderTarget = Schema.Struct({
  owner: Name,
  className: Name,
  version: Version,
  namespaceId: NamespaceId,
  objectId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  manifest: Schema.String.check(Schema.isBetweenLength(1, maximumNames)),
  epoch: Schema.String.check(Schema.isBetweenLength(1, maximumNames)),
});
export type RecoveryProviderTarget = typeof RecoveryProviderTarget.Type;
