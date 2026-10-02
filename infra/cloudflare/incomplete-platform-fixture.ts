import type { SmokeEnvironment } from "../../apps/server/cloudflare/runtime/release-smoke/contract";

const proofLength = 64;
const unavailable = (): never => {
  throw new Error("Unexpected synthetic binding access");
};

/** Complete, fail-closed Cloudflare bindings; a test may proxy only the operations it exercises. */
export const unavailableDatabase: D1Database = {
  batch: unavailable,
  dump: unavailable,
  exec: unavailable,
  prepare: unavailable,
  withSession: unavailable,
};
export const unavailableBucket: R2Bucket = {
  head: unavailable,
  get: unavailable,
  put: unavailable,
  delete: unavailable,
  list: unavailable,
  createMultipartUpload: unavailable,
  resumeMultipartUpload: unavailable,
};
export const unavailableQueue: Queue = {
  send: unavailable,
  sendBatch: unavailable,
  metrics: unavailable,
};
export const unavailableWorkflow: Workflow = {
  create: unavailable,
  get: unavailable,
  createBatch: unavailable,
  deleteBatch: unavailable,
};

export class SyntheticBindings {
  static withMethods<Binding extends object>(
    this: void,
    binding: Binding,
    methods: Readonly<Record<string, unknown>>
  ): Binding {
    return new Proxy(binding, {
      get: (target, key, receiver): unknown =>
        typeof key === "string" && Object.hasOwn(methods, key)
          ? methods[key]
          : Reflect.get(target, key, receiver),
    });
  }
}

export const smokeEnvironment = (overrides: Partial<SmokeEnvironment> = {}): SmokeEnvironment => ({
  DB: unavailableDatabase,
  SMOKE_BUCKET: unavailableBucket,
  SMOKE_QUEUE: unavailableQueue,
  SMOKE_WORKFLOW: unavailableWorkflow,
  SMOKE_QUEUE_NAME: "reserved-smoke",
  USER_TRANSACTION_COORDINATOR: { getByName: unavailable },
  SMOKE_PROOF: "a".repeat(proofLength),
  CF_VERSION_METADATA: { id: "dc8dcd28-271b-4367-9840-6c244f84cb40" },
  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  CONTRACT_DIGEST: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  KAPSO_API_KEY: "configured",
  KAPSO_WEBHOOK_SECRET: "configured",
  RESEND_API_KEY: "configured",
  WOMPI_PRIVATE_KEY: "configured",
  WOMPI_INTEGRITY_SECRET: "configured",
  WOMPI_EVENT_SECRET: "configured",
  ...overrides,
});
