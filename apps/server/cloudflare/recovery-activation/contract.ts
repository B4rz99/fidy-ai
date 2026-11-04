import { Schema } from "effect";

const maximumIdentityLength = 128;
const activationName = Schema.String.check(Schema.isBetweenLength(1, maximumIdentityLength));
export const RecoveryTarget = Schema.Struct({
  namespaceId: activationName,
  objectId: activationName,
  manifest: activationName,
  epoch: activationName,
});
export type RecoveryTarget = typeof RecoveryTarget.Type;
export const RecoverySourceTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("D1"),
    databaseId: Schema.String.check(Schema.isUUID()),
    epoch: activationName,
  }),
  Schema.Struct({ kind: Schema.Literal("SQLite"), ...RecoveryTarget.fields }),
]);
export type RecoverySourceTarget = typeof RecoverySourceTarget.Type;
export const RecoveryStoreObservation = Schema.Struct({
  target: RecoveryTarget,
  admission: Schema.Literals(["Open", "Closed"]),
  activationId: Schema.String,
  queryLeases: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  releaseBarrier: Schema.Literals(["Unqualified", "Drained"]),
});
export type RecoveryStoreObservation = typeof RecoveryStoreObservation.Type;
export type RecoveryStoreControl = Readonly<{
  inspect: () => Promise<unknown>;
  close: (input: Readonly<{ activationId: string; epoch: string }>) => Promise<unknown>;
}>;
export type RecoveryActivationEnvironment = Readonly<{
  admission: RecoveryAdmissionBinding;
  serving: RecoveryStoreControl;
  sourceDb: D1Database;
  sourceTarget: RecoverySourceTarget;
  servingTarget: RecoveryTarget;
}>;

export const RecoveryLease = Schema.Struct({
  epoch: Schema.String,
  leaseId: Schema.String.check(Schema.isBetweenLength(1, maximumIdentityLength)),
});
export const RecoveryClose = Schema.Struct({
  epoch: Schema.String,
  activationId: Schema.String.check(Schema.isBetweenLength(1, maximumIdentityLength)),
});
export const RecoveryAdmissionState = Schema.Struct({
  objectId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  epoch: Schema.String,
  activationId: Schema.String,
  closed: Schema.Boolean,
  paused: Schema.Boolean,
  leases: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type RecoveryAdmissionState = typeof RecoveryAdmissionState.Type;
export type RecoveryAdmissionBinding = Readonly<{
  inspect: () => Promise<unknown>;
  pause: (input: typeof RecoveryClose.Type) => Promise<unknown>;
  enterContinuation: (input: typeof RecoveryLease.Type) => Promise<boolean>;
  enter: (input: typeof RecoveryLease.Type) => Promise<boolean>;
  complete: (input: typeof RecoveryLease.Type) => Promise<boolean>;
  close: (input: typeof RecoveryClose.Type) => Promise<unknown>;
}>;
export type RecoveryAdmissionEnvironment = Partial<
  Readonly<{
    RECOVERY_ADMISSION: Readonly<{ getByName: (name: string) => RecoveryAdmissionBinding }>;
    RECOVERY_SOURCE_EPOCH: string;
  }>
>;
