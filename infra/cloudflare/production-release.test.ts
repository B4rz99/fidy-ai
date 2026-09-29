import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { decodeWorkerReceipts } from "./production-release";

describe("Production release Worker receipts", () => {
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
