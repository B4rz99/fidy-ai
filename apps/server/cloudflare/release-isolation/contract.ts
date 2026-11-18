import { Data } from "effect";

export const acceptanceProofHeader = "x-fidy-acceptance-proof";
export const acceptanceLifetimeMs = 60_000;
export type AcceptanceBoundary = "ingress" | "core";
export type AcceptanceEnvironment = Readonly<{ RELEASE_GIT_SHA: string; BROWSER_ORIGIN: string }> &
  Partial<
    Readonly<{
      NATIVE_STORAGE_ADMISSION: string;
      RECOVERY_ISOLATION: string;
      SMOKE_PROOF: string;
      SQLITE_STORAGE_RELEASE: string;
    }>
  >;
export class AcceptanceProofUnavailable extends Data.TaggedError(
  "AcceptanceProofUnavailable"
)<{}> {}

export type NativeAcceptanceSettings = Partial<
  Readonly<{
    NATIVE_STORAGE_ADMISSION: string;
    RECOVERY_ISOLATION: string;
    RELEASE_GIT_SHA: string;
  }>
>;

export type AcceptanceWindowBindings = NativeAcceptanceSettings &
  Partial<Readonly<{ SMOKE_BUCKET: Pick<R2Bucket, "get" | "put"> }>>;
export const acceptanceWindowQuery = "?acceptance=work";

export const acceptanceReceiptKind = "charge-receipt";
