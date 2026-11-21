import { Effect, Result, Schema } from "effect";
import { assert, expect, it } from "vitest";
import { platform } from "./internal/platform";

it("reports only the closed failing stage for unavailable native smoke resources", () =>
  Effect.runPromise(
    Effect.forEach(
      ["schema", "storage", "publication"] as const,
      Effect.fnUntraced(function* (stage) {
        const observed = yield* platform({
          stage,
          tryWork: () => Promise.reject(new Error("private provider diagnostics")),
        }).pipe(Effect.result);

        expect(Result.isFailure(observed)).toBe(true);

        assert(Result.isFailure(observed));
        expect(observed.failure.stage).toBe(stage);
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(observed)
        ).not.toContain("private provider diagnostics");
      }),
      { discard: true }
    )
  ));
