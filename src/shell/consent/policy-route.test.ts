import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ApiHarness } from "~/shell/testing/api-harness";
import { currentDisclosure } from "./current-disclosure";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "public policy route",
  (it) => {
    it.effect("serves the full source-controlled policy at the canonical path", () =>
      Effect.gen(function* () {
        const disclosure = yield* currentDisclosure;
        expect(disclosure.policy.publicUrl).toBe("https://fidyapp.com/politica");
        const response = yield* HttpClient.get(new URL(disclosure.policy.publicUrl).pathname);
        const body = yield* response.text;

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toContain("text/html");
        expect(body).toContain("Política de tratamiento de datos personales");
        expect(body).toContain("policy-2026-08-03");
        expect(body).toContain("obarboza@fidyapp.com");
      })
    );
  }
);
