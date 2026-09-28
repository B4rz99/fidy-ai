/// <reference types="bun-types" />

import { Effect, Option, Schema } from "effect";
import {
  SmokeIdentity,
  SmokeResponse,
  smokePath,
  verifySmokeIdentity,
} from "../../apps/server/cloudflare/runtime/smoke";
import { verifyEdgeSmoke } from "./verify-edge-smoke";

const RunnerConfig = Schema.Struct({
  RELEASE_GIT_SHA: SmokeIdentity.fields.gitRevision,
  CONTRACT_DIGEST: SmokeIdentity.fields.contractDigest,
  PUBLIC_VERSION_ID: SmokeIdentity.fields.workerVersionId,
  CORE_VERSION_ID: SmokeIdentity.fields.workerVersionId,
  PUBLIC_WORKER_NAME: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)),
  CORE_WORKER_NAME: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)),
  SMOKE_PROOF: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
type RunnerConfig = typeof RunnerConfig.Type;
const apiOrigin = "https://api.fidyapp.com";
const maxAttempts = 20;
const pollDelayMs = 1500;
const timeoutMs = 8000;

const candidateHeaders = (config: RunnerConfig): Readonly<Record<string, string>> => ({
  "cloudflare-workers-version-overrides": `${config.PUBLIC_WORKER_NAME}="${config.PUBLIC_VERSION_ID}", ${config.CORE_WORKER_NAME}="${config.CORE_VERSION_ID}"`,
  "x-fidy-smoke-proof": config.SMOKE_PROOF,
});

const call = (
  path: string,
  headers: Readonly<Record<string, string>>,
  body: Option.Option<string>
): Promise<Response> =>
  fetch(`${apiOrigin}${path}`, {
    method: Option.isSome(body) ? "POST" : "GET",
    headers: { ...headers, "content-type": "application/json" },
    ...(Option.isSome(body) ? { body: body.value } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

const check = async (response: Response, config: RunnerConfig): Promise<"pending" | "passed"> => {
  if (
    !response.ok ||
    response.headers.get("cache-control") !== "no-store" ||
    response.headers.get("x-fidy-smoke-worker-version") !== config.PUBLIC_VERSION_ID
  ) {
    throw new Error("Candidate smoke request did not reach the expected public Worker");
  }
  const result = Schema.decodeUnknownOption(
    Schema.Struct({ ...SmokeResponse.fields, public: SmokeIdentity })
  )(await response.json());
  const expected = { gitRevision: config.RELEASE_GIT_SHA, contractDigest: config.CONTRACT_DIGEST };
  if (
    Option.isNone(result) ||
    !verifySmokeIdentity(
      { ...expected, workerVersionId: config.PUBLIC_VERSION_ID },
      result.value.public
    ) ||
    !verifySmokeIdentity(
      { ...expected, workerVersionId: config.CORE_VERSION_ID },
      result.value.core
    )
  ) {
    throw new Error("Candidate smoke did not prove the compatible public and Core release");
  }
  return result.value.status;
};

const awaitSyntheticWork = async (
  config: RunnerConfig,
  headers: Readonly<Record<string, string>>
): Promise<void> => {
  const probeId = crypto.randomUUID().replaceAll("-", "");
  const request = JSON.stringify({
    protocolVersion: 1,
    probeId,
    expectedPublicVersionId: config.PUBLIC_VERSION_ID,
    expectedCoreVersionId: config.CORE_VERSION_ID,
    expectedGitRevision: config.RELEASE_GIT_SHA,
    expectedContractDigest: config.CONTRACT_DIGEST,
  });
  let status = await check(await call(smokePath, headers, Option.some(request)), config);
  const poll = async (attempt: number): Promise<void> => {
    if (status === "passed") return;
    if (attempt >= maxAttempts) {
      throw new Error("Synthetic Queue and Workflow probe did not complete");
    }
    await Bun.sleep(pollDelayMs);
    status = await check(
      await call(`${smokePath}?probeId=${probeId}`, headers, Option.none()),
      config
    );
    return poll(attempt + 1);
  };
  await poll(0);
};

const checkEdge = async (
  config: RunnerConfig,
  headers: Readonly<Record<string, string>>
): Promise<void> => {
  const edge = await Effect.runPromiseExit(
    verifyEdgeSmoke(
      ({ method, path, headers: probeHeaders }) =>
        Effect.tryPromise({
          try: async () => {
            const response = await call(
              path,
              { ...headers, ...probeHeaders },
              method === "POST" ? Option.some("{}") : Option.none()
            );
            return { status: response.status, headers: response.headers };
          },
          catch: () => undefined,
        }),
      {
        proof: config.SMOKE_PROOF,
        override: headers["cloudflare-workers-version-overrides"] ?? "",
        publicVersionId: config.PUBLIC_VERSION_ID,
      }
    )
  );
  if (edge._tag === "Failure") {
    throw new Error("Candidate edge rejections or headers were not verified");
  }
};

/** Explicitly pinned HTTP invocations; a fallback to stable always fails identity comparison. */
export const verifyProductionSmoke = async (env: unknown): Promise<void> => {
  const decoded = Schema.decodeUnknownOption(RunnerConfig)(env);
  if (Option.isNone(decoded)) throw new Error("Incomplete production smoke configuration");
  const config = decoded.value;
  const headers = candidateHeaders(config);
  await awaitSyntheticWork(config, headers);
  await checkEdge(config, headers);
};

if (import.meta.main) {
  try {
    await verifyProductionSmoke(process.env);
    await Bun.write(Bun.stdout, "Exact-version production smoke passed.\n");
  } catch {
    await Bun.write(Bun.stderr, "Exact-version production smoke failed; do not promote.\n");
    process.exitCode = 1;
  }
}
