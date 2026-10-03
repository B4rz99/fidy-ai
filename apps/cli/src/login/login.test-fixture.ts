import { ClaimedPATPairing, StartedPATPairing } from "@fidy/server/client";
import { Effect, Schema } from "effect";
import { type Credential } from "../credential/contract";
import { type LoginDependencies } from "./contract";

const secretCharacterCount = 43;
export const privateProof = "p".repeat(secretCharacterCount);
export const rawBearer = `fin_abcd1234_${"s".repeat(secretCharacterCount)}`;
export const issued = Schema.decodeSync(Schema.toCodecJson(ClaimedPATPairing))({
  bearer: rawBearer,
  pat: {
    _tag: "PAT",
    id: "01900000-0000-4000-8000-000000000001",
    shortId: "abcd1234",
    recipientLabel: "Mi agente",
    scopes: ["read"],
    lifetimeDays: 7,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    expiresAt: "1970-01-08T00:00:00.000Z",
  },
});
export const started = Schema.decodeSync(Schema.toCodecJson(StartedPATPairing))({
  pairingId: "01900000-0000-4000-8000-000000000002",
  privateDeviceCode: privateProof,
  publicCode: "BCDF-GHJK",
  expiresAt: "1970-01-01T00:10:00.000Z",
  pollingIntervalSeconds: 5,
});
export const request = { recipientLabel: "Mi agente", scopes: ["read"], lifetimeDays: 7 };
export const makeLoginFixture = (): Readonly<{
  dependencies: LoginDependencies;
  saved: Array<Credential>;
  claims: Array<number>;
}> => {
  const saved: Array<Credential> = [];
  const claims: Array<number> = [];
  return {
    saved,
    claims,
    dependencies: {
      verifyStorage: Effect.void,
      store: {
        load: Effect.succeedNone,
        save: (credential) =>
          Effect.sync(() => {
            saved.push(credential);
          }),
        clear: Effect.void,
      },
      pairing: {
        start: () => Effect.succeed(started),
        claim: () =>
          Effect.sync(() => {
            claims.push(1);
            return issued;
          }),
      },
    },
  };
};
