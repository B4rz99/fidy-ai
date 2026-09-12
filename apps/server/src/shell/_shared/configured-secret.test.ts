import { expect, it } from "@effect/vitest";
import { type Config, ConfigProvider, Effect, Redacted, Schema } from "effect";
import {
  exitFailure,
  expectNotInspected,
  renderedFailure,
} from "~/shell/testing/credential-failure";
import { configuredSecret } from "./configured-secret";

const variableName = "CANARY_CONFIG_SECRET";
const TestSecret = Schema.String.check(Schema.isPattern(/^secret_[a-z0-9_]{8,}$/u));
const validCandidate = `secret_test_${"f1d7c0de".repeat(3)}`;

const readSecret = (
  schema: Schema.Constraint,
  candidate?: string
): Effect.Effect<Redacted.Redacted<string>, Config.ConfigError> =>
  configuredSecret({ name: variableName, schema, requirement: "must be a test secret" }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(candidate === undefined ? {} : { [variableName]: candidate })
    )
  );

const readSecretFailure = (
  schema: Schema.Constraint,
  candidate?: string
): Effect.Effect<Config.ConfigError> =>
  Effect.exit(readSecret(schema, candidate)).pipe(Effect.flatMap(exitFailure));

it.effect("keeps a valid configured Secret wrapped and readable only through Redacted", () =>
  Effect.gen(function* () {
    const secret = yield* readSecret(TestSecret, validCandidate);

    expect(Redacted.value(secret)).toBe(validCandidate);
    expectNotInspected(secret, validCandidate);
  })
);

it.effect("fails a malformed configured Secret without echoing the candidate", () =>
  Effect.gen(function* () {
    for (const candidate of [`CANARY-configured-secret-${"f1d7c0de".repeat(2)}`, "secret_short"]) {
      const rendered = yield* renderedFailure(yield* readSecretFailure(TestSecret, candidate));

      expect(rendered).not.toContain(candidate);
      expect(rendered).toContain(variableName);
    }
  })
);

it.effect("fails an environment-mismatched configured Secret without echoing the candidate", () =>
  Effect.gen(function* () {
    const candidate = `secret_prod_${"f1d7c0de".repeat(3)}`;
    const rendered = yield* renderedFailure(
      yield* readSecretFailure(TestSecret.check(Schema.isStartsWith("secret_test_")), candidate)
    );

    expect(rendered).not.toContain(candidate);
    expect(rendered).toContain(variableName);
  })
);

it.effect("fails a missing configured Secret with a value-safe diagnostic", () =>
  Effect.gen(function* () {
    const rendered = yield* renderedFailure(yield* readSecretFailure(TestSecret));

    expect(rendered).toContain(variableName);
  })
);
