import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Result } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { IanaTimeZone } from "~/core/_shared/context";
import { defaultUserId } from "~/shell/db/development-seed";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { ApiHarness, ApiHarnessClient, headersFor } from "~/shell/testing/api-harness";
import { defaultAgentBearer } from "~/shell/testing/identity-fixtures";
import { updateUserPreferences } from "./mutations";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "User preferences",
  (it) => {
    it.effect("returns independently persisted Colombian context", () =>
      Effect.gen(function* () {
        const client = yield* ApiHarnessClient;

        const current = yield* client.identity.getCurrentUser();

        expect(current.data).toMatchObject({
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/Bogota",
          paidTier: "pro",
          trialPeriod: {
            startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
            endsAt: DateTime.makeUnsafe("2026-01-08T00:00:00Z"),
          },
        });
      })
    );

    it.effect("updates locale and named time zone but never ServiceMarket", () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.patch("/user/preferences", {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe({
            locale: "es-CO",
            timeZone: "America/New_York",
            serviceMarket: "US",
          }),
        });
        const body = yield* response.json;

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          data: {
            serviceMarket: "CO",
            locale: "es-CO",
            timeZone: "America/New_York",
          },
        });
      })
    );

    it.effect("rolls a preference update back with its caller-owned transaction", () =>
      Effect.gen(function* () {
        const client = yield* ApiHarnessClient;
        const before = yield* client.identity.getCurrentUser();
        const rollbackTimeZone =
          before.data.timeZone === "America/Lima" ? "America/Bogota" : "America/Lima";

        const rollback = yield* Effect.result(
          withUserTransaction(
            defaultUserId,
            updateUserPreferences({
              userId: defaultUserId,
              payload: {
                locale: "es-CO",
                timeZone: IanaTimeZone.make(rollbackTimeZone),
              },
            }).pipe(Effect.andThen(Effect.fail("rollback requested")))
          )
        );
        const after = yield* client.identity.getCurrentUser();

        expect(rollback).toEqual(Result.fail("rollback requested"));
        expect(after.data).toEqual(before.data);
      })
    );

    it.effect("rejects a fixed offset without changing the User's preferences", () =>
      Effect.gen(function* () {
        const client = yield* ApiHarnessClient;
        const before = yield* client.identity.getCurrentUser();
        const response = yield* HttpClient.patch("/user/preferences", {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe({ locale: "es-CO", timeZone: "-05:00" }),
        });
        const after = yield* client.identity.getCurrentUser();

        expect(response.status).toBe(400);
        expect(after.data).toEqual(before.data);
      })
    );

    it.effect("rejects an unsupported locale without changing the User's preferences", () =>
      Effect.gen(function* () {
        const client = yield* ApiHarnessClient;
        const before = yield* client.identity.getCurrentUser();
        const response = yield* HttpClient.patch("/user/preferences", {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe({
            locale: "en-US",
            timeZone: "America/Bogota",
          }),
        });
        const after = yield* client.identity.getCurrentUser();

        expect(response.status).toBe(400);
        expect(after.data).toEqual(before.data);
      })
    );
  }
);
