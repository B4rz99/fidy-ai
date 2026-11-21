import uploadedPair from "./native-pairing-upload.json" with { type: "json" };
import fixtureUpload from "./native-fixture-upload.json" with { type: "json" };
import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vitest";
import { archivedDormant } from "./native-fallback-recovery";
import {
  canonicalRestorePort,
  configureReleaseObservability,
  decodeCaptureWorkerReceipts,
  decodePairingUploadReceipts,
  decodeWorkerReceipts,
  releaseCommand,
  releaseFailureMessage,
  releasePort,
  verifyCoreDefaultPlacement,
} from "./production-release";
import { type ReleasePort, releaseController } from "./release-controller";

const revision = "a".repeat(40);

const publicVersion = "11111111-1111-4111-8111-111111111111";

const coreVersion = "22222222-2222-4222-8222-222222222222";

it.effect("requires native default placement on the exact staged Core version", () =>
  Effect.gen(function* () {
    for (const observation of [
      { id: coreVersion, placement: undefined, legacy: undefined, accepted: true },
      { id: publicVersion, placement: undefined, legacy: undefined, accepted: false },
      { id: coreVersion, placement: undefined, legacy: "smart", accepted: false },
      { id: coreVersion, placement: { mode: "smart" }, accepted: false },
      {
        id: coreVersion,
        placement: { mode: "smart", status: "INSUFFICIENT_INVOCATIONS" },
        accepted: false,
      },
      { id: publicVersion, placement: { mode: "smart" }, accepted: false },
      { id: coreVersion, placement: {}, accepted: false },
      { id: coreVersion, placement: { mode: "off" }, accepted: false },
      { id: coreVersion, placement: { region: "aws:us-east-1" }, accepted: false },
      { id: coreVersion, placement: { hostname: "example.com" }, accepted: false },
    ]) {
      const requests: Array<string> = [];

      const client = HttpClient.make((request) => {
        requests.push(`${request.method} ${new URL(request.url).pathname}`);

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              success: true,
              result: {
                id: observation.id,
                resources: {
                  script: { placement: observation.placement, placement_mode: observation.legacy },
                },
              },
            })
          )
        );
      });

      const result = yield* Effect.exit(
        verifyCoreDefaultPlacement(
          { account: "test-account", token: "test-only" },
          { name: "core", version: coreVersion },
          client
        )
      );

      expect(Exit.isSuccess(result)).toBe(observation.accepted);
      expect(requests).toEqual([
        `GET /client/v4/accounts/test-account/workers/scripts/core/versions/${coreVersion}`,
      ]);
    }
  })
);

it.effect(
  "redacts gradual-release request queries without deploying code or changing bindings",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];

      const client = HttpClient.make((request) => {
        requests.push(`${request.method} ${new URL(request.url).pathname}`);

        if (request.method === "PATCH") {
          expect(request.body._tag).toBe("Uint8Array");

          if (request.body._tag === "Uint8Array") {
            expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
              observability: {
                enabled: true,
                head_sampling_rate: 1,
                redact_query_string: true,
                issues: { enabled: true },
                logs: {
                  enabled: true,
                  head_sampling_rate: 1,
                  invocation_logs: false,
                  persist: true,
                },
                traces: { enabled: false },
              },
            });
          }
        }

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              success: true,
              result: {
                observability: {
                  enabled: true,
                  redact_query_string: true,
                  issues: { enabled: true },
                  logs: { enabled: true, invocation_logs: false, persist: true },
                },
              },
            })
          )
        );
      });

      yield* configureReleaseObservability(
        { account: "test-account", token: "test-only" },
        ["ingress", "core"],
        client
      );
      expect(requests).toEqual([
        "PATCH /client/v4/accounts/test-account/workers/scripts/ingress/script-settings",
        "GET /client/v4/accounts/test-account/workers/scripts/ingress/settings",
        "PATCH /client/v4/accounts/test-account/workers/scripts/core/script-settings",
        "GET /client/v4/accounts/test-account/workers/scripts/core/settings",
      ]);
    })
);

it.effect("refuses staging when query privacy or native issue detection is not persisted", () =>
  Effect.forEach(
    [
      { redact_query_string: false, issues: { enabled: true } },
      { redact_query_string: true, issues: { enabled: false } },
    ],
    Effect.fnUntraced(function* (settings) {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              success: true,
              result: {
                observability: {
                  enabled: true,
                  logs: { enabled: true, invocation_logs: false, persist: true },
                  ...settings,
                },
              },
            })
          )
        )
      );

      const result = yield* Effect.exit(
        configureReleaseObservability(
          { account: "test-account", token: "test-only" },
          ["ingress", "core"],
          client
        )
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
    { discard: true }
  )
);

it.live(
  "classifies a queue-related native refusal without publishing resource names or secrets",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        releaseCommand({
          args: [
            process.execPath,
            "-e",
            "console.error('Queue private-resource-name does not exist. [code: 10210] private-token'); process.exit(1)",
          ],
          lifetime: "read-only",
        })
      );

      expect(result._tag).toBe("Failure");

      if (result._tag === "Failure") {
        expect(releaseFailureMessage(result.cause)).toBe(
          "Release tooling failed (Cloudflare API code 10210; resource=queue); inspect traffic state"
        );
      }
    })
);

it.live(
  "recognizes Wrangler's rewritten inconsistent-export rejection without disclosing its body",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        releaseCommand({
          args: [
            process.execPath,
            "-e",
            "console.error('private-export-body\\nAll versions in a percentage-split deployment must declare identical Durable Object `exports`. Cloudflare requires this so traffic on one branch cannot route to code referencing unprovisioned namespaces.'); process.exit(1)",
          ],
          lifetime: "read-only",
        })
      );

      expect(result._tag).toBe("Failure");

      if (result._tag === "Failure") {
        expect(releaseFailureMessage(result.cause)).toBe(
          "Release tooling failed (Cloudflare API code 100405); inspect traffic state"
        );
      }
    })
);

it.live("preserves a safe native rejection after routing reconciliation fails", () =>
  Effect.gen(function* () {
    let writes = 0;

    const port: ReleasePort = {
      trunk: () => Effect.succeed(revision),
      current: () =>
        Effect.succeed({
          id: publicVersion,
          versions: [{ id: publicVersion, percentage: 100 }],
        }),
      deploy: () =>
        Effect.gen(function* () {
          writes += 1;
          yield* releaseCommand({
            args: [
              process.execPath,
              "-e",
              "console.error('private-token [code: 100405]'); process.exit(1)",
            ],
            lifetime: "started-write",
          });

          return { id: coreVersion, versions: [{ id: coreVersion, percentage: 100 }] };
        }),
    };

    const result = yield* Effect.exit(
      releaseController.deployExact(port, "prod-core", [{ id: coreVersion, percentage: 100 }])
    );

    expect(result._tag).toBe("Failure");

    if (result._tag === "Failure") {
      expect(releaseFailureMessage(result.cause)).toBe(
        "Release tooling failed (Cloudflare API code 100405); inspect traffic state"
      );
    }

    expect(writes).toBe(1);
  })
);

it.live("reports only a Cloudflare API code when native release tooling refuses a request", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      releaseCommand({
        args: [
          process.execPath,
          "-e",
          "console.error('private-provider-body [code: 100405] private-token'); process.exit(1)",
        ],
        lifetime: "read-only",
      })
    );

    expect(result._tag).toBe("Failure");

    if (result._tag === "Failure") {
      expect(releaseFailureMessage(result.cause)).toBe(
        "Release tooling failed (Cloudflare API code 100405); inspect traffic state"
      );
    }
  })
);

const trunkReference = {
  ref: "refs/heads/trunk",
  object: { type: "commit", sha: revision },
};

const captureInput = {
  revision,
  stableRevision: "b".repeat(40),
  stableContractDigest: "c".repeat(64),
  publicName: "prod-ingress",
  coreName: "prod-core",
};

const referenceHarness = (
  reference: unknown = trunkReference,
  applicationRevision = revision
): { port: ReleasePort; requests: ReadonlyArray<string> } => {
  const requests: string[] = [];

  const client = HttpClient.make((request) => {
    requests.push(`${request.method} ${request.url}`);
    let body: unknown;

    if (request.url === "https://api.github.com/repos/test/fidy/git/ref/heads/trunk") {
      body = reference;
    } else if (request.url === "https://api.github.com/repos/test/fidy/commits/trunk") {
      body = { sha: revision, files: [{ patch: "x".repeat(200_000) }] };
    } else {
      const isPublic = request.url.endsWith("/prod-ingress/deployments");
      body = {
        success: true,
        result: {
          deployments: [
            {
              id: isPublic ? publicVersion : coreVersion,
              versions: [{ version_id: isPublic ? publicVersion : coreVersion, percentage: 100 }],
            },
          ],
        },
      };
    }

    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
  });

  const port = releasePort({
    env: {
      account: "0".repeat(32),
      token: "test-only-cloudflare",
      revision: applicationRevision,
      repository: "test/fidy",
      githubToken: "test-only-github",
      file: "/unused-snapshot",
      smokeProof: "0".repeat(64),
      smokeAttestationFile: "/unused-attestation",
    },
    client,
  });

  return { port, requests };
};

it.effect(
  "binds a staged application to the freshly read protected verifier at every trunk check",
  () =>
    Effect.gen(function* () {
      const verifier = "e".repeat(40);

      for (const [name, value] of Object.entries({
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/trunk",
        GITHUB_REF_PROTECTED: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REPOSITORY: "B4rz99/fidy-ai",
        GITHUB_SHA: verifier,
        FIXTURE_STAGED_VERIFIER_SHA: verifier,
        RELEASE_GIT_SHA: archivedDormant.revision,
        FIXTURE_RELEASE_OPERATION: "reseal-fixture-fallback",
        NATIVE_STORAGE_HOSTS: "acceptance",
        NATIVE_STORAGE_ADMISSION: "closed",
      })) {
        vi.stubEnv(name, value);
      }

      const port = (head: string, application: string = archivedDormant.revision): ReleasePort =>
        referenceHarness({ ...trunkReference, object: { type: "commit", sha: head } }, application)
          .port;

      yield* Effect.forEach(
        ["reseal-fixture-fallback", "diagnose-fixture-pairing"],
        Effect.fnUntraced(function* (operation) {
          vi.stubEnv("FIXTURE_RELEASE_OPERATION", operation);
          expect(yield* port(verifier).trunk()).toBe(archivedDormant.revision);
        }),
        { discard: true }
      );

      expect(yield* port(revision).trunk().pipe(Effect.isFailure)).toBe(true);
      vi.stubEnv("FIXTURE_PAIRING_APPLICATION", revision);
      vi.stubEnv("RELEASE_GIT_SHA", revision);
      vi.stubEnv("FIXTURE_RELEASE_OPERATION", "rollout");
      const replacement = port(verifier, revision);
      expect(yield* replacement.trunk()).toBe(revision);
      expect(yield* port(verifier).trunk().pipe(Effect.isFailure)).toBe(true);
      vi.stubEnv("FIXTURE_STAGED_VERIFIER_SHA", revision);
      expect(yield* port(verifier).trunk().pipe(Effect.exit)).toHaveProperty("_tag", "Failure");
    }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())))
);

it.effect("accepts only the exact interrupted successor under its current protected verifier", () =>
  Effect.gen(function* () {
    const application = "de04a192c3836be0efb488b170a7b93b9f98f28f";
    const verifier = "e".repeat(40);

    const workflow =
      "B4rz99/fidy-ai/.github/workflows/native-fixture-successor-plan.yml@refs/heads/trunk";

    for (const [name, value] of Object.entries({
      FIXTURE_SUCCESSOR_RESUME: "true",
      FIXTURE_STAGED_VERIFIER_SHA: verifier,
      FIXTURE_RELEASE_OPERATION: "stage-fixture-successor",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/trunk",
      GITHUB_REF_PROTECTED: "true",
      GITHUB_REPOSITORY: "B4rz99/fidy-ai",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: verifier,
      GITHUB_WORKFLOW_REF: workflow,
      NATIVE_STORAGE_ADMISSION: "closed",
      NATIVE_STORAGE_HOSTS: "acceptance",
      RELEASE_GIT_SHA: application,
    })) {
      vi.stubEnv(name, value);
    }

    const { port } = referenceHarness(
      { ...trunkReference, object: { type: "commit", sha: verifier } },
      application
    );

    yield* Effect.forEach(
      ["stage-fixture-successor", "recover-fixture-successor", "rollout-fixture-successor"],
      Effect.fnUntraced(function* (operation) {
        vi.stubEnv("FIXTURE_RELEASE_OPERATION", operation);
        expect(yield* port.trunk()).toBe(application);
      }),
      { discard: true }
    );

    vi.stubEnv("RELEASE_GIT_SHA", revision);
    expect(yield* port.trunk().pipe(Effect.exit)).toHaveProperty("_tag", "Failure");
    vi.stubEnv("RELEASE_GIT_SHA", application);
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
    expect(yield* port.trunk().pipe(Effect.exit)).toHaveProperty("_tag", "Failure");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    vi.stubEnv("GITHUB_WORKFLOW_REF", workflow.replace("successor-plan", "workflow-recovery-plan"));
    expect(yield* port.trunk().pipe(Effect.exit)).toHaveProperty("_tag", "Failure");
  }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())))
);

it.effect(
  "aborts rejected status and declared oversized native responses before returning release failure",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(FetchHttpClient.layer);

      for (const options of [
        { status: 503, headers: new Headers() },
        { status: 200, headers: new Headers({ "content-length": "100001" }) },
      ]) {
        let aborted = false;
        let pulled = 0;

        const fetch: typeof globalThis.fetch = Object.assign(
          (
            _input: Parameters<typeof globalThis.fetch>[0],
            init?: Parameters<typeof globalThis.fetch>[1]
          ): Promise<Response> => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
            });

            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>(
                  {
                    pull() {
                      pulled += 1;
                    },
                  },
                  { highWaterMark: 0 }
                ),
                options
              )
            );
          },
          { preconnect: globalThis.fetch.preconnect }
        );

        const port = releasePort({
          client: Context.get(services, HttpClient.HttpClient),
          env: {
            account: "0".repeat(32),
            token: "test-only-cloudflare",
            revision,
            repository: "test/fidy",
            githubToken: "test-only-github",
            file: "/unused-snapshot",
            smokeProof: "0".repeat(64),
            smokeAttestationFile: "/unused-attestation",
          },
        });

        const outcome = yield* port
          .current("prod-ingress")
          .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.exit);

        expect(Exit.isFailure(outcome)).toBe(true);
        expect(aborted).toBe(true);
        expect(pulled).toBe(0);
      }
    }).pipe(Effect.scoped)
);

describe("Production release trunk guard", () => {
  it.effect(
    "captures a stable snapshot for a commit whose patches exceed the response budget",
    Effect.fn(function* () {
      const { port } = referenceHarness();
      const snapshot = yield* releaseController.captureRelease(port, captureInput);
      expect(snapshot).toEqual({
        revision,
        stableRevision: captureInput.stableRevision,
        stableContractDigest: captureInput.stableContractDigest,
        public: {
          name: "prod-ingress",
          deploymentId: publicVersion,
          stableVersionId: publicVersion,
        },
        core: { name: "prod-core", deploymentId: coreVersion, stableVersionId: coreVersion },
      });
    })
  );

  it.effect(
    "rejects malformed, wrong-branch, and superseding references before touching Workers",
    Effect.fn(function* () {
      const rejected = [
        { ref: "refs/heads/trunk", object: { type: "commit", sha: "invalid" } },
        { ref: "refs/heads/trunk" },
        { ...trunkReference, ref: "refs/heads/other" },
        { ...trunkReference, object: { type: "tag", sha: revision } },
        { ...trunkReference, object: { type: "commit", sha: "d".repeat(40) } },
      ];

      yield* Effect.forEach(
        rejected,
        Effect.fnUntraced(function* (reference) {
          const { port, requests } = referenceHarness(reference);
          const result = yield* Effect.exit(releaseController.captureRelease(port, captureInput));
          expect(Exit.isFailure(result)).toBe(true);
          expect(requests).toEqual([
            "GET https://api.github.com/repos/test/fidy/git/ref/heads/trunk",
          ]);
        }),
        { discard: true }
      );
    })
  );

  it.effect(
    "still rejects an oversized reference response before touching Workers",
    Effect.fn(function* () {
      const { port, requests } = referenceHarness({
        ...trunkReference,
        extra: "x".repeat(100_001),
      });

      const result = yield* Effect.exit(releaseController.captureRelease(port, captureInput));
      expect(Exit.isFailure(result)).toBe(true);
      expect(requests).toEqual(["GET https://api.github.com/repos/test/fidy/git/ref/heads/trunk"]);
    })
  );
});

it("keeps foreign failures and defects out of release CLI diagnostics", () => {
  const foreign = Error("secret-provider-body-and-token");

  for (const cause of [Cause.fail(foreign), Cause.die(foreign)]) {
    expect(releaseFailureMessage(cause)).toBe(
      "Production release routing failed; inspect Worker deployment state before recovery."
    );
  }
});

it.effect.each([
  { code: 10220, diagnostic: "Cloudflare deployment rejected (HTTP 400; code 10220)" },
  { code: 10097, diagnostic: "Cloudflare deployment rejected (HTTP 400; code 10097)" },
  { code: "private-provider-code", diagnostic: "Cloudflare deployment rejected (HTTP 400)" },
  { code: -1, diagnostic: "Cloudflare deployment rejected (HTTP 400)" },
])("reports only bounded deployment refusal metadata for code $code", ({ code, diagnostic }) =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            {
              success: false,
              errors: [{ code, message: "private-provider-body-and-token" }],
            },
            { status: 400 }
          )
        )
      )
    );

    const port = releasePort({
      env: {
        account: "0".repeat(32),
        token: "private-provider-token",
        revision,
        repository: "test/fidy",
        githubToken: "private-github-token",
        file: "/unused-snapshot",
        smokeProof: "0".repeat(64),
        smokeAttestationFile: "/unused-attestation",
      },
      client,
    });

    const outcome = yield* Effect.exit(
      port.deploy("prod-core", [{ id: coreVersion, percentage: 100 }])
    );

    expect(Exit.isFailure(outcome)).toBe(true);

    if (Exit.isFailure(outcome)) {
      expect(releaseFailureMessage(outcome.cause)).toBe(diagnostic);
    }
  })
);

it.effect.each([
  "single refusal",
  "ordinary success",
  "different status",
  "multiple codes",
  "foreign target",
  "closed proof failed",
  "not deployable",
  "live pair changed",
  "history changed",
  "trunk changed",
] as const)("limits canonical compensation to the captured closed Worker after %s", (scenario) =>
  Effect.gen(function* () {
    const env = {
      account: "0".repeat(32),
      token: "private-provider-token",
      revision,
      repository: "test/fidy",
      githubToken: "private-github-token",
      file: "/unused-snapshot",
      smokeProof: "0".repeat(64),
      smokeAttestationFile: "/unused-attestation",
    };

    const restored = "aa0aa000-0000-4000-8000-00000000000a";
    const candidate = "bb0bb000-0000-4000-8000-00000000000b";

    const publicWorker = {
      name: "prod-ingress",
      deploymentId: publicVersion,
      stableVersionId: publicVersion,
    };

    const coreWorker = {
      name: "prod-core",
      deploymentId: coreVersion,
      stableVersionId: coreVersion,
    };

    const publicBefore = { id: publicVersion, versions: [{ id: candidate, percentage: 100 }] };
    const coreBefore = { id: coreVersion, versions: [{ id: candidate, percentage: 100 }] };
    const requests: Array<string> = [];

    const response = {
      success: true,
      result: { id: restored, versions: [{ version_id: coreVersion, percentage: 100 }] },
    };

    const client = HttpClient.make((request) => {
      const url = new URL(request.url);
      requests.push(request.method + " " + url.pathname + url.search);

      const body =
        url.searchParams.has("force") || scenario === "ordinary success"
          ? Response.json(response)
          : Response.json(
              {
                success: false,
                errors: [
                  { code: 10220, message: "private-provider-body-and-token" },
                  ...(scenario === "multiple codes" ? [{ code: 10097 }] : []),
                ],
              },
              { status: scenario === "different status" ? 409 : 400 }
            );

      return Effect.succeed(HttpClientResponse.fromWeb(request, body));
    });

    const port = canonicalRestorePort({
      port: {
        ...releasePort({ env, client }),
        trunk: () =>
          Effect.sync(() =>
            requests.length > 0 && scenario === "trunk changed" ? "b".repeat(40) : revision
          ),
        recentDeployments: (name) =>
          Effect.sync(() => {
            const current = name === publicWorker.name ? publicBefore : coreBefore;
            const past = { id: restored, versions: [{ id: coreVersion, percentage: 100 }] };

            if (requests.length === 0 || name !== publicWorker.name) return [current, past];

            if (scenario === "live pair changed") return [{ ...current, id: restored }, past];

            if (scenario === "history changed") return [current];

            return [current, past];
          }),
        deployable: () => Effect.succeed(scenario !== "not deployable"),
      },
      env,
      client,
      snapshot: {
        revision,
        stableRevision: "c".repeat(40),
        stableContractDigest: "0".repeat(64),
        public: publicWorker,
        core: coreWorker,
      },
      verifyClosedPair:
        scenario === "closed proof failed"
          ? Effect.fail(Error("Closed proof failed"))
          : Effect.void,
    });

    const restoreStable = port.restoreStable;

    if (restoreStable === undefined) {
      return yield* Effect.fail(Error("Canonical restoration missing"));
    }

    const outcome = yield* Effect.exit(
      restoreStable({
        target: {
          name: coreWorker.name,
          stableVersionId: scenario === "foreign target" ? publicVersion : coreVersion,
          previous: coreBefore,
        },
        companion: { name: publicWorker.name, previous: publicBefore },
      })
    );

    expect(Exit.isSuccess(outcome)).toBe(
      scenario === "single refusal" || scenario === "ordinary success"
    );

    const post =
      "POST /client/v4/accounts/" + env.account + "/workers/scripts/prod-core/deployments";

    const expected = scenario === "foreign target" ? [] : [post];

    if (scenario === "single refusal") expected.push(post + "?force=true");
    expect(requests).toEqual(expected);
  })
);

describe("Production release Worker receipts", () => {
  it("authenticates the two gradual uploads and the completed non-versioned technical Smoke Worker", () => {
    const worker = (
      logicalId: string,
      workerName: string,
      versionId: string
    ): Record<string, unknown> => ({
      logicalId,
      status: "updated",
      attr: { workerName, versionId, hash: { main: "state-hash" } },
    });

    const smoke = {
      logicalId: "ReleaseSmoke-" + fixtureUpload.revision,
      status: "updated",
      attr: { workerName: "fidy-native-smoke-" + fixtureUpload.revision },
    };

    const state = {
      public: worker("Ingress", "fidy-native-storage-ingress", uploadedPair.publicVersionId),
      core: worker("Core", "fidy-native-storage-core", uploadedPair.coreVersionId),
      smoke,
    };

    expect(decodePairingUploadReceipts(JSON.stringify(state)).core.versionId).toEqual(
      Option.some(uploadedPair.coreVersionId)
    );

    for (const changed of [
      { ...smoke, status: "updating" },
      { ...smoke, attr: { ...smoke.attr, versionId: coreVersion } },
      { ...smoke, logicalId: "Smoke" },
    ]) {
      expect(() =>
        decodePairingUploadReceipts(JSON.stringify({ ...state, smoke: changed }))
      ).toThrow();
    }

    expect(() =>
      decodePairingUploadReceipts(
        JSON.stringify({ ...state, core: worker("Core", "fidy-native-storage-core", coreVersion) })
      )
    ).toThrow();
  });
  it("reports a missing Worker receipt without echoing state values", () => {
    expect(() => decodeWorkerReceipts('{"secret":"not-for-logs"}')).toThrowError(
      new Error("Alchemy Ingress Worker resource is missing")
    );
  });

  it("refuses an in-progress Worker replacement as an unstable release baseline", () => {
    const state = {
      ingress: { logicalId: "Ingress", status: "replacing", attr: { workerName: "prod-ingress" } },
      core: { logicalId: "Core", status: "updated", attr: { workerName: "prod-core" } },
    };

    expect(() => decodeWorkerReceipts(JSON.stringify(state))).toThrowError(
      new Error("Alchemy Ingress Worker lifecycle is unstable")
    );
  });

  it("accepts the current output of a replaced Worker resource", () => {
    const ingressVersion = "11111111-1111-4111-8111-111111111111";
    const coreVersion = "22222222-2222-4222-8222-222222222222";

    const state = {
      ingress: {
        logicalId: "Ingress",
        status: "replaced",
        attr: {
          workerName: "prod-ingress",
          versionId: ingressVersion,
          hash: { main: "ingress-digest" },
        },
      },
      core: {
        logicalId: "Core",
        status: "updated",
        attr: { workerName: "prod-core", versionId: coreVersion, hash: { main: "core-digest" } },
      },
    };

    expect(decodeWorkerReceipts(JSON.stringify(state))).toEqual({
      public: {
        workerName: "prod-ingress",
        versionId: Option.some(ingressVersion),
        hasRolloutBaseline: true,
      },
      core: {
        workerName: "prod-core",
        versionId: Option.some(coreVersion),
        hasRolloutBaseline: true,
      },
    });
  });

  it("does not infer a rollout baseline from a replaced receipt without its hash", () => {
    const state = {
      ingress: {
        logicalId: "Ingress",
        status: "replaced",
        attr: { workerName: "prod-ingress", versionId: "11111111-1111-4111-8111-111111111111" },
      },
      core: {
        logicalId: "Core",
        status: "updated",
        attr: {
          workerName: "prod-core",
          versionId: "22222222-2222-4222-8222-222222222222",
          hash: { main: "core-digest" },
        },
      },
    };

    expect(decodeWorkerReceipts(JSON.stringify(state)).public).toEqual({
      workerName: "prod-ingress",
      versionId: Option.some("11111111-1111-4111-8111-111111111111"),
      hasRolloutBaseline: false,
    });
  });

  it("uses an interrupted update receipt only for baseline capture", () => {
    const ingressVersion = "11111111-1111-4111-8111-111111111111";
    const coreVersion = "22222222-2222-4222-8222-222222222222";

    const attributes = {
      workerName: "prod-ingress",
      versionId: ingressVersion,
      hash: { main: "ingress-digest" },
    };

    const state = {
      ingress: {
        logicalId: "Ingress",
        status: "updating",
        attr: attributes,
        old: { attr: attributes },
      },
      core: {
        logicalId: "Core",
        status: "updated",
        attr: { workerName: "prod-core", versionId: coreVersion, hash: { main: "core-digest" } },
      },
    };

    expect(() => decodeWorkerReceipts(JSON.stringify(state))).toThrowError(
      new Error("Alchemy Ingress Worker lifecycle is unstable")
    );
    expect(decodeCaptureWorkerReceipts(JSON.stringify(state))).toEqual({
      public: {
        workerName: "prod-ingress",
        versionId: Option.some(ingressVersion),
        hasRolloutBaseline: true,
      },
      core: {
        workerName: "prod-core",
        versionId: Option.some(coreVersion),
        hasRolloutBaseline: true,
      },
    });
  });

  it("rejects an interrupted update when the previous Worker identity disagrees", () => {
    const state = {
      ingress: {
        logicalId: "Ingress",
        status: "updating",
        attr: { workerName: "prod-ingress", hash: { main: "digest" } },
        old: { attr: { workerName: "different-ingress", hash: { main: "digest" } } },
      },
      core: { logicalId: "Core", status: "updated", attr: { workerName: "prod-core" } },
    };

    expect(() => decodeCaptureWorkerReceipts(JSON.stringify(state))).toThrowError(
      new Error("Alchemy Ingress Worker receipt is incomplete")
    );
  });

  it("does not infer an interrupted-update baseline without the current output hash", () => {
    const state = {
      ingress: {
        logicalId: "Ingress",
        status: "updating",
        attr: { workerName: "prod-ingress", versionId: "11111111-1111-4111-8111-111111111111" },
        old: {
          attr: {
            workerName: "prod-ingress",
            versionId: "11111111-1111-4111-8111-111111111111",
            hash: { main: "previous-digest" },
          },
        },
      },
      core: {
        logicalId: "Core",
        status: "updated",
        attr: {
          workerName: "prod-core",
          versionId: "22222222-2222-4222-8222-222222222222",
          hash: { main: "core-digest" },
        },
      },
    };

    expect(decodeCaptureWorkerReceipts(JSON.stringify(state)).public).toEqual({
      workerName: "prod-ingress",
      versionId: Option.some("11111111-1111-4111-8111-111111111111"),
      hasRolloutBaseline: false,
    });
  });

  it("classifies a replaced Worker without current-generation attributes as incomplete", () => {
    const state = {
      ingress: {
        logicalId: "Ingress",
        status: "replaced",
        attr: { secret: "not-for-logs" },
      },
      core: { logicalId: "Core", status: "updated", attr: { workerName: "prod-core" } },
    };

    expect(() => decodeWorkerReceipts(JSON.stringify(state))).toThrowError(
      new Error("Alchemy Ingress Worker receipt is incomplete")
    );
  });

  it("identifies the Core Worker when its lifecycle is unstable", () => {
    const state = {
      ingress: { logicalId: "Ingress", status: "updated", attr: { workerName: "prod-ingress" } },
      core: { logicalId: "Core", status: "replacing", attr: { workerName: "prod-core" } },
    };

    expect(() => decodeWorkerReceipts(JSON.stringify(state))).toThrowError(
      new Error("Alchemy Core Worker lifecycle is unstable")
    );
  });

  it("classifies an incomplete Worker receipt without echoing persisted values", () => {
    const state = {
      ingress: {
        logicalId: "Ingress",
        status: "updated",
        attr: { secret: "not-for-logs" },
      },
      core: {
        logicalId: "Core",
        status: "updated",
        attr: { workerName: "prod-core" },
      },
    };

    expect(() => decodeWorkerReceipts(JSON.stringify(state))).toThrowError(
      new Error("Alchemy Ingress Worker receipt is incomplete")
    );
  });

  it("refuses ambiguous Worker identities", () => {
    const state = {
      ingress: { logicalId: "Ingress", status: "updated", attr: { workerName: "prod-ingress" } },
      duplicateIngress: {
        logicalId: "Ingress",
        status: "updated",
        attr: { workerName: "other-ingress" },
      },
      core: { logicalId: "Core", status: "updated", attr: { workerName: "prod-core" } },
    };

    expect(() => decodeWorkerReceipts(JSON.stringify(state))).toThrowError(
      new Error("Alchemy Ingress Worker receipt is ambiguous")
    );
  });

  it("decodes the Worker receipts when Alchemy progress precedes the state JSON", () => {
    const publicVersion = "11111111-1111-4111-8111-111111111111";
    const coreVersion = "22222222-2222-4222-8222-222222222222";

    const state = {
      publicResource: {
        logicalId: "Ingress",
        status: "updated",
        attr: { workerName: "prod-ingress", versionId: publicVersion, hash: { main: "digest" } },
      },
      coreResource: {
        logicalId: "Core",
        status: "updated",
        attr: { workerName: "prod-core", versionId: coreVersion, hash: { main: "digest" } },
      },
    };

    expect(
      decodeWorkerReceipts(
        `[00:00:00.000] INFO: Cloudflare state read progress ${JSON.stringify(state, null, 2)}`
      )
    ).toEqual({
      public: {
        workerName: "prod-ingress",
        versionId: Option.some(publicVersion),
        hasRolloutBaseline: true,
      },
      core: {
        workerName: "prod-core",
        versionId: Option.some(coreVersion),
        hasRolloutBaseline: true,
      },
    });
  });
});
