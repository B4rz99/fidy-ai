import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { ApiHarness, ApiHarnessClient, headersFor } from "~/shell/testing/api-harness";
import { defaultAgentBearer } from "~/shell/testing/identity-fixtures";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "User preferences",
  (it) => {
    it.effect("returns independently persisted Colombian launch context", () =>
      Effect.gen(function* () {
        const client = yield* ApiHarnessClient;

        const current = yield* client.identity.getCurrentUser();

        expect(current.data).toMatchObject({
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/Bogota",
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
