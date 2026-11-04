import type { RecoveryLifecycleEnvironment } from "../contract";
import { bucket } from "./objects";
import { database } from "./database";

type NativeEnvironment = RecoveryLifecycleEnvironment &
  Readonly<{
    DB: D1Database;
  }> &
  Partial<
    Readonly<{
      ERASURE_BUCKET: object;
      STATEMENT_STAGING_BUCKET: object;
      EMAIL_BUCKET: object;
      SMOKE_BUCKET: object;
    }>
  >;

/** Capture native capabilities after target selection and before any recovery wrapper. */
export const objects = <Environment extends NativeEnvironment>(
  input: Environment
): Environment => ({
  ...input,
  ...(input.ERASURE_BUCKET === undefined
    ? {}
    : { ERASURE_BUCKET: bucket({ binding: input.ERASURE_BUCKET, environment: input }) }),
  ...(input.STATEMENT_STAGING_BUCKET === undefined
    ? {}
    : {
        STATEMENT_STAGING_BUCKET: bucket({
          binding: input.STATEMENT_STAGING_BUCKET,
          environment: input,
        }),
      }),
  ...(input.EMAIL_BUCKET === undefined
    ? {}
    : { EMAIL_BUCKET: bucket({ binding: input.EMAIL_BUCKET, environment: input }) }),
  ...(input.SMOKE_BUCKET === undefined
    ? {}
    : { SMOKE_BUCKET: bucket({ binding: input.SMOKE_BUCKET, environment: input }) }),
});

export const environment = <Environment extends NativeEnvironment>(
  input: Environment
): Environment => ({
  ...objects(input),
  DB: database({ binding: input.DB, environment: input }),
});
