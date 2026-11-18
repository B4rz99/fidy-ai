export type AcceptanceProviderEnvironment = Readonly<{
  RELEASE_GIT_SHA: string;
  SMOKE_BUCKET: Pick<R2Bucket, "get" | "put">;
}> &
  Partial<
    Readonly<{
      NATIVE_STORAGE_ADMISSION: string;
      ACCEPTANCE_CODE_KEY: string;
      ACCEPTANCE_GOOGLE_SECRET: string;
      ACCEPTANCE_MICROSOFT_SECRET: string;
      ACCEPTANCE_API_ORIGIN: string;
    }>
  >;
