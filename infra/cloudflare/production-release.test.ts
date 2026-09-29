import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { decodeCaptureWorkerReceipts, decodeWorkerReceipts } from "./production-release";

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
