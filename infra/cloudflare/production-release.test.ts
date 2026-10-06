import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import {
  decodeCaptureWorkerReceipts,
  decodeWorkerReceipts,
  releaseFailureMessage,
  releasePort,
} from "./production-release";
import { type ReleasePort, releaseController } from "./release-controller";

const revision = "a".repeat(40);
const publicVersion = "11111111-1111-4111-8111-111111111111";
const coreVersion = "22222222-2222-4222-8222-222222222222";
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
  reference: unknown = trunkReference
): { port: ReleasePort; requests: ReadonlyArray<string> } => {
  const requests: string[] = [];
  const client = HttpClient.make((request) => {
    requests.push(`${request.method} ${request.url}`);
    let body: unknown;
    if (request.url === "https://api.github.com/repos/test/fidy/git/ref/heads/trunk") {
      body = reference;
    } else if (request.url === "https://api.github.com/repos/test/fidy/commits/trunk") {
      // The commit is valid but its patches exceed the release response budget.
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
      revision,
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
      for (const reference of rejected) {
        const { port, requests } = referenceHarness(reference);
        const result = yield* Effect.exit(releaseController.captureRelease(port, captureInput));
        expect(Exit.isFailure(result)).toBe(true);
        expect(requests).toEqual([
          "GET https://api.github.com/repos/test/fidy/git/ref/heads/trunk",
        ]);
      }
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

describe("Production release Worker receipts", () => {
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
