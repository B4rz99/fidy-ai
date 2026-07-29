import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ApiHarness } from "~/shell/testing/api-harness";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "public service routes",
  (it) => {
    it.effect("reports health and the running version without caller credentials", () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get("/health");

        expect(response.status).toBe(200);
        expect(yield* response.text).toBe('{"status":"ok","version":"development"}');
      })
    );

    it.effect("serves the web shell without caller credentials", () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get("/");

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(yield* response.text).toContain('id="root"');
      })
    );
  }
);
