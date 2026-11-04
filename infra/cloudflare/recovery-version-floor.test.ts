import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";
import { retireRecoveryVersions } from "./production-release";

const current = "18500000-0000-4000-8000-000000000001";
const old = "18500000-0000-4000-8000-000000000002";
const target = {
  name: "recovery-floor",
  workerId: "18500000000040008000000000000003",
  version: current,
};

it.effect("retires only inactive provider versions and verifies the remaining rollback floor", () =>
  Effect.gen(function* () {
    for (const fault of ["None", "WrongWorker", "Split", "DeleteUnknown"] as const) {
      let retired = false;
      let deleteCalls = 0;
      const client = HttpClient.make((request) => {
        const path = new URL(request.url).pathname;
        let result: unknown;
        let status = 200;
        if (request.method === "DELETE") {
          expect(path.endsWith(`/versions/${old}`)).toBe(true);
          retired = true;
          deleteCalls += 1;
          if (fault === "DeleteUnknown") status = 503;
          result = {};
        } else if (path.endsWith(`/workers/${target.workerId}`)) {
          result = { id: target.workerId, name: fault === "WrongWorker" ? "other" : target.name };
        } else if (path.endsWith("/deployments")) {
          result = {
            deployments: [
              {
                id: current,
                versions:
                  fault === "Split"
                    ? [
                        { version_id: current, percentage: 50 },
                        { version_id: old, percentage: 50 },
                      ]
                    : [{ version_id: current, percentage: 100 }],
              },
            ],
          };
        } else {
          expect(new URL(request.url).search).toBe("?deployable=true");
          result = { items: (retired ? [current] : [current, old]).map((id) => ({ id })) };
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ success: status === 200, result }, { status })
          )
        );
      });
      const result = yield* Effect.exit(
        retireRecoveryVersions({ account: "test-account", token: "test-only" }, target, client)
      );
      expect(Exit.isSuccess(result)).toBe(fault === "None");
      if (fault === "WrongWorker" || fault === "Split") expect(retired).toBe(false);
      if (fault === "DeleteUnknown") {
        const resumed = yield* retireRecoveryVersions(
          { account: "test-account", token: "test-only" },
          target,
          client
        );
        expect(resumed.state).toBe("EligibleVersionsRetired");
        expect(deleteCalls).toBe(1);
      }
      if (Exit.isSuccess(result)) {
        expect(result.value).toMatchObject({
          worker: target,
          state: "EligibleVersionsRetired",
          eligible: [current],
        });
      }
    }
  })
);
