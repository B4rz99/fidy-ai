import { Data, Option, Schema } from "effect";

export const acceptanceApiHeader = "x-fidy-acceptance-api";

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
    ACCEPTANCE_PROVIDER_REVISION: string;
    NATIVE_FIXTURE_MEMBER: string;
  }>
>;

export const acceptanceProviderRevision = (settings: NativeAcceptanceSettings): string =>
  settings.ACCEPTANCE_PROVIDER_REVISION ?? settings.RELEASE_GIT_SHA ?? "";

export type AcceptanceWindowBindings = NativeAcceptanceSettings &
  Partial<Readonly<{ SMOKE_BUCKET: Pick<R2Bucket, "get" | "put"> }>>;

export const acceptanceWindowQuery = "?acceptance=work";

export const acceptanceReceiptKind = "charge-receipt";

export const performanceReceiptPaths = {
  "performance-1":
    "/internal/release-smoke?acceptance=transaction-fixture&cohort=performance&ordinal=1",
  "performance-2":
    "/internal/release-smoke?acceptance=transaction-fixture&cohort=performance&ordinal=2",
} as const;

export type PerformanceMember = keyof typeof performanceReceiptPaths;

export const performanceReceiptPath = performanceReceiptPaths["performance-1"];

const performanceAccountingPaths = {
  "performance-1":
    "/internal/release-smoke?acceptance=transaction-accounting&cohort=performance&ordinal=1",
  "performance-2":
    "/internal/release-smoke?acceptance=transaction-accounting&cohort=performance&ordinal=2",
} as const;

const performanceMember = (
  request: Request,
  paths: Readonly<Record<PerformanceMember, string>>
): Option.Option<PerformanceMember> => {
  if (request.method !== "POST") return Option.none();
  const url = new URL(request.url);
  const path = url.pathname + url.search;

  if (path === paths["performance-1"]) return Option.some("performance-1");

  if (path === paths["performance-2"]) return Option.some("performance-2");

  return Option.none();
};

export const performanceReceiptMember = (request: Request): Option.Option<PerformanceMember> =>
  performanceMember(request, performanceReceiptPaths);

export const performanceAccountingMember = (request: Request): Option.Option<PerformanceMember> =>
  performanceMember(request, performanceAccountingPaths);

export const performanceReceiptMarker = ({
  nativeRevision,
  member,
}: Readonly<{ nativeRevision: string; member: PerformanceMember }>): string =>
  "_release-smoke/" + nativeRevision + "/acceptance/transactions/" + member;

const sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

export const ReceiptRequest = Schema.Struct({
  resourcePrefix: Schema.String.check(Schema.isPattern(/^fidy-2259-[a-f0-9]{12}$/u)),
  nativeManifestDigest: sha,
});

const coordinates = Schema.Struct({
  ...ReceiptRequest.fields,
  nativeRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  member: Schema.Literals(["performance-1", "performance-2"]),
  sessionBindingSha256: sha,
});

export type Coordinates = typeof coordinates.Type;

export const SealedTransactionReceipt = Schema.Struct({
  ...coordinates.fields,
  iv: Schema.String.check(Schema.isPattern(/^[a-f0-9]{24}$/u)),
  sealed: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{2}){16,24000}$/u)),
  signature: Schema.String.check(Schema.isPattern(/^[a-f0-9]{128}$/u)),
});

export const PerformanceAccountingRequest = Schema.Struct({
  phase: Schema.Literals(["before", "after"]),
  capture: SealedTransactionReceipt,
});
