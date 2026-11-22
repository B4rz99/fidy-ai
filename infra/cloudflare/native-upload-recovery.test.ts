import { expect, it } from "vitest";
import upload from "./native-fixture-upload.json" with { type: "json" };
import { requireInterruptedUpload } from "./native-upload-recovery";

type VersionMetadata = {
  success: boolean;
  result: {
    id: string;
    annotations: Record<string, string>;
    resources: { script: object; bindings: object[] };
  };
};

const metadata = (id: string, ingress: boolean): VersionMetadata => ({
  success: true,
  result: {
    id,
    annotations: { "workers/tag": "release-44680185091-1", "workers/message": "isolated" },
    resources: {
      script: ingress
        ? { handlers: ["fetch"] }
        : {
            handlers: ["fetch"],
            named_handlers: [{ name: "UserStore", handlers: ["durable_object"] }],
          },
      bindings: [{ name: "RELEASE_GIT_SHA", type: "plain_text", text: upload.revision }],
    },
  },
});

it("authenticates both immutable receipts of the interrupted upload before replacing either Worker", () => {
  const core = metadata(upload.coreVersion, false);
  const ingress = metadata(upload.ingressVersion, true);
  expect(() => requireInterruptedUpload({ core, ingress })).not.toThrow();
  expect(() => requireInterruptedUpload({ core: ingress, ingress: core })).toThrow();

  for (const different of [
    {
      ...ingress.result,
      annotations: { "workers/tag": "release-44680185091-2", "workers/message": "isolated" },
    },
    { ...ingress.result, resources: { ...ingress.result.resources, bindings: [] } },
    {
      ...ingress.result,
      resources: {
        ...ingress.result.resources,
        script: { handlers: ["fetch"], named_handlers: null },
      },
    },
  ]) {
    expect(() =>
      requireInterruptedUpload({ core, ingress: { success: true, result: different } })
    ).toThrow();
  }
});
