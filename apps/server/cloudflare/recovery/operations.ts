import {
  recoverRotations as nativeRecoverRotations,
  repairRecoveryAlarm as nativeRepairRecoveryAlarm,
  rotateLocalRecovery as nativeRotateLocalRecovery,
} from "./internal/local-rotation";
import {
  expireSupportCases as nativeExpireSupportCases,
  localSupportApproval as nativeLocalSupportApproval,
  repairSupportRetention as nativeRepairSupportRetention,
} from "./internal/local-support";

import { Hex } from "effect/encoding";
import {
  type UserStoreBindings,
  directoryName,
  supportAdmissionUrl,
  supportApprovalUrl,
} from "../directory/contract";
import { Effect, Option } from "effect";
import { HttpClient } from "effect/http";
import { type OwnedStatement } from "../../src/shell/owner-write/contract";
import { type BackupRecoveryCode } from "../../src/core/recovery/contract";
import {
  type InitialRecoveryEnrollment,
  type RecoveryRequest,
  type SupportAccessConfiguration,
  type SupportRecoveryRequest,
} from "./contract";
import { makeAccessSigningKeysOutboundHttp } from "../../src/shell/outbound-http/operations";
import { rotateBackupRecoveryCode as rotate } from "./internal/rotation";
import {
  handleSupportRecovery as handleSupport,
  handleSupportProof,
} from "./internal/support-recovery";
import {
  recoveryCodeDigest as nativeRecoveryCodeDigest,
  sampleRecoveryCode as nativeSampleRecoveryCode,
} from "./internal/material";

export const issueInitialBackupRecoveryCode = ({
  db,
  userId,
  createdAtMs,
  commit,
}: InitialRecoveryEnrollment): Promise<BackupRecoveryCode> => {
  const code = sampleRecoveryCode();
  return recoveryCodeDigest(code)
    .then((digest) =>
      commit(
        db
          .prepare(
            `INSERT INTO backup_recovery_credentials(user_id,code_digest,created_at_ms,revision) VALUES(?1,?2,?3,1)`
          )
          .bind(userId, digest, createdAtMs)
      )
    )
    .then(() => code);
};

export const rotateBackupRecoveryCode = (input: RecoveryRequest): Promise<Response> =>
  rotate(input);

export const handleSupportRecovery = (
  input: SupportRecoveryRequest
): Effect.Effect<Response, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = makeAccessSigningKeysOutboundHttp({
      issuer: input.config.CLOUDFLARE_ACCESS_ISSUER,
      httpClient: yield* HttpClient.HttpClient,
    });
    return yield* handleSupport({ ...input, http });
  });

export const retainedRecoveryPairingsQuery = (): OwnedStatement => ({
  sql: "SELECT pairing_id AS pairingId FROM support_recovery_cases",
  params: [],
});

export const recoveryCodeDigest: typeof nativeRecoveryCodeDigest = (...args) =>
  nativeRecoveryCodeDigest(...args);
export const sampleRecoveryCode: typeof nativeSampleRecoveryCode = (...args) =>
  nativeSampleRecoveryCode(...args);

const limitedStatus = 429;

export const nativeSupportRecovery = Effect.fn(function* (input: {
  request: Request;
  config: SupportAccessConfiguration;
  directory: Option.Option<UserStoreBindings["DIRECTORY"]>;
}) {
  const directory = Option.map(input.directory, (value) => value.getByName(directoryName));
  const post = (url: string, body: object): Promise<Response> =>
    Option.isNone(directory)
      ? Promise.resolve(new Response(null, { status: 503 }))
      : directory.value.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
  return yield* handleSupportProof({
    ...input,
    http: makeAccessSigningKeysOutboundHttp({
      issuer: input.config.CLOUDFLARE_ACCESS_ISSUER,
      httpClient: yield* HttpClient.HttpClient,
    }),
    admit: (operator) =>
      post(supportAdmissionUrl, operator).then((response) => {
        if (response.ok) return "allowed";
        return response.status === limitedStatus ? "limited" : "unavailable";
      }),
    approve: (decision) =>
      post(supportApprovalUrl, {
        operator: decision.operator,
        publicCode: decision.publicCode,
        digest: Hex.encode(decision.codeDigest),
      }),
  });
});

export const repairRecoveryAlarm: typeof nativeRepairRecoveryAlarm = (...args) =>
  nativeRepairRecoveryAlarm(...args);

export const rotateLocalRecovery: typeof nativeRotateLocalRecovery = (...args) =>
  nativeRotateLocalRecovery(...args);

export const recoverRotations: typeof nativeRecoverRotations = (...args) =>
  nativeRecoverRotations(...args);

export const localSupportApproval: typeof nativeLocalSupportApproval = (...args) =>
  nativeLocalSupportApproval(...args);

export const repairSupportRetention: typeof nativeRepairSupportRetention = (...args) =>
  nativeRepairSupportRetention(...args);
export const expireSupportCases: typeof nativeExpireSupportCases = (...args) =>
  nativeExpireSupportCases(...args);
