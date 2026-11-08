import { Effect, Schema } from "effect";
import { retainedSecretCount } from "./browser-storage-fixture";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const writeScrollCache = (value: string): void => {
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem("tsr-scroll-restoration-v1_3", value);
};
const writeSecret = (): void => {
  sessionStorage.clear();
  localStorage.setItem("bearer", "fixture-secret");
};
test("browser secret checks exempt only numeric scroll metadata", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.goto("/login"));
      const cases = [
        { cache: { "none:entry": { window: { scrollX: 0, scrollY: 100 } } }, expected: 0 },
        { cache: { "fixture-secret": { window: { scrollX: 0, scrollY: 100 } } }, expected: 1 },
        {
          cache: { "none:entry": { window: { scrollX: 0, scrollY: "fixture-secret" } } },
          expected: 1,
        },
        {
          cache: {
            "none:entry": { window: { scrollX: 0, scrollY: 100, bearer: "fixture-secret" } },
          },
          expected: 1,
        },
      ];
      for (const { cache, expected } of cases) {
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(cache);
        yield* Effect.tryPromise(() => page.evaluate(writeScrollCache, encoded));
        expect(yield* Effect.tryPromise(() => page.evaluate(retainedSecretCount))).toBe(expected);
      }
      yield* Effect.tryPromise(() => page.evaluate(writeSecret));
      expect(yield* Effect.tryPromise(() => page.evaluate(retainedSecretCount))).toBe(1);
    })
  ));
