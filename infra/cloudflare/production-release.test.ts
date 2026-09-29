import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeCaptureWorkerReceipts,
  decodeWorkerReceipts,
  isInspectedResumePair,
  isInterruptedAlchemyReceipt,
  isInterruptedStableSnapshot,
  isPreSmokeBaseline,
  matchesRecoveryVersion,
  releaseFailureMessage,
  verifyInspectedStaging,
} from "./production-release";

it("refuses a removed public candidate before diagnostic smoke and never changes traffic", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let writes = 0;
      const exit = yield* Effect.exit(
        verifyInspectedStaging(
          {
            trunk: () => Effect.succeed("a".repeat(40)),
            current: () =>
              Effect.succeed({
                id: "e6a6fcdc-a14e-4560-b360-3cdb6d3b6421",
                versions: [{ id: "90b1cd6a-4796-41bf-ae33-fb3333a3fff0", percentage: 100 }],
              }),
            deploy: () => {
              writes++;
              return Effect.fail(Error("unexpected traffic write"));
            },
          },
          {
            public: {
              workerName: "fidy-ingress",
              versionId: Option.some("18489858-358b-4986-9d60-98a686052c85"),
              hasRolloutBaseline: true,
            },
            core: {
              workerName: "fidy-core",
              versionId: Option.some("2216c932-4dc6-4195-baad-8944aa28bf07"),
              hasRolloutBaseline: true,
            },
          }
        )
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(releaseFailureMessage(exit.cause)).toContain("staged");
      expect(writes).toBe(0);
    })
  ));

it("keeps foreign failures and defects out of release CLI diagnostics", () => {
  const foreign = Error("secret-provider-body-and-token");
  for (const cause of [Cause.fail(foreign), Cause.die(foreign)]) {
    expect(releaseFailureMessage(cause)).toBe(
      "Production release routing failed; inspect Worker deployment state before recovery."
    );
  }
});

it("permits interrupted-upload reconciliation only for the inspected stable pair and Alchemy receipts", () => {
  const snapshot = {
    revision: "a".repeat(40),
    stableRevision: "2d65bde42f81b5c4af377e433100a7500bec0a5b",
    stableContractDigest: "f33c9633df9fdfe0dbb730156fe9083dc4d0f676648a27d102f73bc98262fd4f",
    public: {
      name: "fidy-ingress",
      deploymentId: "e6a6fcdc-a14e-4560-b360-3cdb6d3b6421",
      stableVersionId: "90b1cd6a-4796-41bf-ae33-fb3333a3fff0",
    },
    core: {
      name: "fidy-core",
      deploymentId: "86d18c08-2219-4321-ae98-76428713c188",
      stableVersionId: "28ffd738-508a-4d00-a3e1-31911f86ce01",
    },
  };
  const workers = {
    public: {
      workerName: snapshot.public.name,
      versionId: Option.some("18489858-358b-4986-9d60-98a686052c85"),
      hasRolloutBaseline: true,
    },
    core: {
      workerName: snapshot.core.name,
      versionId: Option.some("2216c932-4dc6-4195-baad-8944aa28bf07"),
      hasRolloutBaseline: true,
    },
  };
  expect(isInterruptedStableSnapshot(snapshot)).toBe(true);
  expect(isInterruptedAlchemyReceipt({ workers, snapshot })).toBe(true);
  expect(
    isInterruptedStableSnapshot({
      ...snapshot,
      core: { ...snapshot.core, deploymentId: "different" },
    })
  ).toBe(false);
  expect(isInterruptedStableSnapshot({ ...snapshot, stableRevision: "b".repeat(40) })).toBe(false);
  expect(
    isInterruptedAlchemyReceipt({
      workers: {
        ...workers,
        core: { ...workers.core, versionId: Option.some(snapshot.core.stableVersionId) },
      },
      snapshot,
    })
  ).toBe(false);
  expect(
    isInterruptedAlchemyReceipt({
      workers: { ...workers, public: { ...workers.public, hasRolloutBaseline: false } },
      snapshot,
    })
  ).toBe(false);
});

it("allows reconciliation only for the inspected sole-stable Worker pair after cleanup committed", () => {
  const pair = {
    publicDeployment: {
      id: "e6a6fcdc-a14e-4560-b360-3cdb6d3b6421",
      versions: [{ id: "90b1cd6a-4796-41bf-ae33-fb3333a3fff0", percentage: 100 }],
    },
    coreDeployment: {
      id: "86d18c08-2219-4321-ae98-76428713c188",
      versions: [{ id: "28ffd738-508a-4d00-a3e1-31911f86ce01", percentage: 100 }],
    },
  };
  expect(isInspectedResumePair(pair)).toBe(true);
  expect(
    isInspectedResumePair({ ...pair, coreDeployment: { ...pair.coreDeployment, id: "changed" } })
  ).toBe(false);
  expect(
    isInspectedResumePair({
      ...pair,
      coreDeployment: {
        ...pair.coreDeployment,
        versions: [
          ...pair.coreDeployment.versions,
          { id: "2216c932-4dc6-4195-baad-8944aa28bf07", percentage: 0 },
        ],
      },
    })
  ).toBe(false);
  expect(
    isInspectedResumePair({
      ...pair,
      coreDeployment: {
        ...pair.coreDeployment,
        versions: [
          { id: "28ffd738-508a-4d00-a3e1-31911f86ce01", percentage: 99 },
          { id: "2216c932-4dc6-4195-baad-8944aa28bf07", percentage: 1 },
        ],
      },
    })
  ).toBe(false);
  expect(
    isInspectedResumePair({
      ...pair,
      publicDeployment: {
        ...pair.publicDeployment,
        versions: [{ id: "18489858-358b-4986-9d60-98a686052c85", percentage: 100 }],
      },
    })
  ).toBe(false);
});

it("permits Core recovery only with an exact sole 100% deployment identity", () => {
  const version = "22222222-2222-4222-8222-222222222222";
  const deployment = {
    id: "11111111-1111-4111-8111-111111111111",
    versions: [{ id: version, percentage: 100 }],
  };
  const input = { deployment, id: deployment.id, version };
  expect(matchesRecoveryVersion(input)).toBe(true);
  expect(matchesRecoveryVersion({ ...input, deployment: { ...deployment, id: "different" } })).toBe(
    false
  );
  expect(
    matchesRecoveryVersion({
      ...input,
      deployment: { ...deployment, versions: [{ id: version, percentage: 0 }] },
    })
  ).toBe(false);
  expect(
    matchesRecoveryVersion({
      ...input,
      deployment: { ...deployment, versions: [...deployment.versions, ...deployment.versions] },
    })
  ).toBe(false);
});

it("allows a direct smoke bootstrap only from the exact pre-smoke Production identity", () => {
  const baseline = {
    gitRevision: "b71c2248e4667ffa042fd00c286a2c2240436475",
    contractDigest: "f33c9633df9fdfe0dbb730156fe9083dc4d0f676648a27d102f73bc98262fd4f",
  };
  expect(isPreSmokeBaseline(baseline)).toBe(true);
  expect(isPreSmokeBaseline({ ...baseline, gitRevision: "a".repeat(40) })).toBe(false);
  expect(isPreSmokeBaseline({ ...baseline, contractDigest: "a".repeat(64) })).toBe(false);
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
