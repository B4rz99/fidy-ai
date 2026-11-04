import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, expect } from "vitest";
import type { CoreHttpBindings } from "../core-http/contract";
import { makeCoreHttp } from "../core-http/runtime";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { registeredConnectionInstitutionIds } from "../../src/shell/connections/contract";
import { cloudflareWorkerTelemetry } from "../runtime/telemetry/operations";
import type { RecoveryAdmissionBinding } from "../recovery-activation/contract";
import { nativeRecoveryAdmission } from "../recovery-activation/native.test-fixture";
import type { RecoveryLifecycleEnvironment } from "./contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const environment = (
  db: D1Database,
  gate: RecoveryAdmissionBinding
): CoreHttpBindings & RecoveryLifecycleEnvironment => ({
  DB: db,
  RELEASE_GIT_SHA: "0".repeat(40),
  CONTRACT_DIGEST: "0".repeat(64),
  BROWSER_ORIGIN: "https://app.fidyapp.com",
  USER_TRANSACTION_COORDINATOR: {
    getByName: () => ({ fetch: () => Promise.reject(new Error("No coordinator authority")) }),
  },
  KAPSO_API_KEY: "private-provider-key",
  KAPSO_WEBHOOK_SECRET: "private-webhook-secret",
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "private-portfolio",
  CLOUDFLARE_ACCESS_ISSUER: "https://unused.example",
  CLOUDFLARE_ACCESS_AUDIENCE: "unused",
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "",
  WOMPI_PRIVATE_KEY: "",
  WOMPI_INTEGRITY_SECRET: "",
  RECOVERY_SOURCE_EPOCH: "source-epoch",
  RECOVERY_ADMISSION: { getByName: () => gate },
});

it.effect("the actual Core fetch root rejects later requests after source admission closes", () =>
  Effect.gen(function* () {
    const gate = yield* nativeRecoveryAdmission;
    const db = yield* Effect.tryPromise(() => databases.acquire());
    const core = makeCoreHttp({
      telemetry: cloudflareWorkerTelemetry,
      institutions: registeredConnectionInstitutionIds,
    });
    const bindings = environment(db, gate);
    expect(
      (yield* Effect.tryPromise(() =>
        core(new Request("https://api.fidyapp.com/health"), bindings)
      )).status
    ).toBe(200);
    yield* Effect.tryPromise(() => gate.close({ epoch: "source-epoch", activationId: "cutover" }));
    const refused = yield* Effect.tryPromise(() =>
      core(new Request("https://api.fidyapp.com/health"), bindings)
    );
    expect(refused.status).toBe(503);
    expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({
      closed: true,
      leases: 0,
    });
  }).pipe(Effect.scoped)
);
