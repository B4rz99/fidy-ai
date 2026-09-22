import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import coreWorker from "./core-worker";
import publicWorker from "./public-worker";
import { productionTopology } from "./topology";

const gitRevision = "0123456789abcdef0123456789abcdef01234567";
const contractDigest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const coreEnvironment = { CONTRACT_DIGEST: contractDigest, RELEASE_GIT_SHA: gitRevision };

describe("Production topology contract", () => {
  it("assigns only the agreed public hostnames and apex redirect", () => {
    expect(productionTopology.web).toEqual({
      hostname: "app.fidyapp.com",
      redirects: ["fidyapp.com"],
      workersDev: false,
    });
    expect(productionTopology.ingress.hostname).toBe("api.fidyapp.com");
    expect(productionTopology.core).toEqual({ workersDev: false });
  });

  it("exposes Core only as the ingress service binding", () => {
    expect(productionTopology.ingress.coreBinding).toBe("CORE");
    expect(productionTopology.ingress).not.toHaveProperty("d1Binding");
    expect(productionTopology.core).not.toHaveProperty("hostname");
  });
});

describe("Cloudflare Worker topology", () => {
  it.effect("returns only bounded release and health metadata from Core", () =>
    Effect.gen(function* () {
      const response = coreWorker.fetch(
        new Request("https://core.internal/health"),
        coreEnvironment
      );
      const body = yield* Effect.promise(() => response.json());

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toEqual({
        contractDigest,
        gitRevision,
        status: "available",
      });
    })
  );

  it.effect("fails closed without disclosing malformed release configuration", () =>
    Effect.gen(function* () {
      const response = coreWorker.fetch(new Request("https://core.internal/health"), {
        CONTRACT_DIGEST: "secret configuration",
        RELEASE_GIT_SHA: "wrong",
      });
      const body = response.clone();
      const json = yield* Effect.promise(() => response.json());
      const text = yield* Effect.promise(() => body.text());

      expect(response.status).toBe(503);
      expect(json).toEqual({ status: "unavailable" });
      expect(text).not.toContain("secret configuration");
    })
  );

  it.effect("reaches health through the Core service binding", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const response = yield* Effect.promise(() =>
        publicWorker.fetch(new Request("https://api.fidyapp.com/health"), {
          CORE: {
            fetch: (request) => {
              const coreRequest = new Request(request);
              requests.push(coreRequest);
              return Promise.resolve(coreWorker.fetch(coreRequest, coreEnvironment));
            },
          },
        })
      );
      const body = yield* Effect.promise(() => response.json());

      expect(requests).toHaveLength(1);
      const coreRequest = requests.at(0);
      expect(coreRequest).toBeDefined();
      expect(new URL(coreRequest?.url ?? "https://invalid.example").pathname).toBe("/health");
      expect(response.status).toBe(200);
      expect(body).toEqual({
        contractDigest,
        gitRevision,
        status: "available",
      });
    })
  );

  it.effect("rejects other public routes before invoking Core", () =>
    Effect.gen(function* () {
      let delegated = false;
      const response = yield* Effect.promise(() =>
        publicWorker.fetch(new Request("https://api.fidyapp.com/internal"), {
          CORE: {
            fetch: () => {
              delegated = true;
              return Promise.resolve(Response.json({}));
            },
          },
        })
      );

      expect(response.status).toBe(404);
      expect(delegated).toBe(false);
    })
  );
});
