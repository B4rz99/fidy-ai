import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Redacted } from "effect";
import { RecoveryFailure, type RecoveryOperator } from "./contract";
import { runSupportRecovery } from "./operations";

it.effect("rejects secret-bearing arguments before authentication or a recovery decision", () =>
  Effect.gen(function* () {
    let contacted = false;
    const output: Array<string> = [];
    const result = yield* runSupportRecovery(["support-recovery", "--code", "secret"], {
      interactive: true,
      authenticate: Effect.sync(() => {
        contacted = true;
        return Redacted.make("access");
      }),
      readPairing: Effect.succeed("BCDF-GHJK"),
      readCode: Effect.succeed(Redacted.make("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2")),
      submit: () => Effect.succeed("approved"),
      write: (text) =>
        Effect.sync(() => {
          output.push(text);
        }),
    });
    expect(result).toBe(true);
    expect(contacted).toBe(false);
    expect(output.join("")).toContain("sin argumentos");
    expect(output.join("")).not.toContain("secret");
  })
);

const fixture = (
  overrides: Partial<RecoveryOperator> = {}
): Readonly<{
  operator: RecoveryOperator;
  output: Array<string>;
  submitted: Array<string>;
}> => {
  const output: Array<string> = [];
  const submitted: Array<string> = [];
  return {
    output,
    submitted,
    operator: {
      interactive: true,
      authenticate: Effect.sync(() => Redacted.make("access")),
      readPairing: Effect.succeed("BCDF-GHJK"),
      readCode: Effect.sync(() => Redacted.make("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2")),
      submit: (input) =>
        Effect.sync(() => {
          submitted.push(input.pairingCode);
          return "approved";
        }),
      write: (text) =>
        Effect.sync(() => {
          output.push(text);
        }),
      ...overrides,
    },
  };
};

it.effect("refuses piped input before reading a claimant proof or authenticating", () =>
  Effect.gen(function* () {
    const test = fixture({
      interactive: false,
      authenticate: Effect.die("must not authenticate"),
      readCode: Effect.die("must not read"),
    });
    expect(yield* runSupportRecovery(["support-recovery"], test.operator)).toBe(true);
    expect(test.submitted).toEqual([]);
  })
);

it.effect("returns the same browser to completion without exposing the claimant proof", () =>
  Effect.gen(function* () {
    const test = fixture();
    expect(yield* runSupportRecovery(["support-recovery"], test.operator)).toBe(false);
    expect(test.submitted).toEqual(["BCDF-GHJK"]);
    expect(test.output.join("")).toContain("Vuelve de inmediato al mismo navegador");
    expect(test.output.join("")).not.toContain("ABCDE");
    expect(test.output.join("")).not.toContain("BCDF-GHJK");
  })
);

it.effect("invalid proof and cancelled entry never submit a recovery decision", () =>
  Effect.gen(function* () {
    for (const readCode of [
      Effect.succeed(Redacted.make("invalid")),
      Effect.fail(new RecoveryFailure({ reason: "Cancelled" })),
    ]) {
      const test = fixture({ readCode });
      expect(yield* runSupportRecovery(["support-recovery"], test.operator)).toBe(true);
      expect(test.submitted).toEqual([]);
    }
  })
);

it.effect("interruption after submission reports uncertainty without replay", () =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>();
    const test = fixture({
      submit: () => Deferred.succeed(sent, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const fiber = yield* runSupportRecovery(["support-recovery"], test.operator).pipe(
      Effect.forkChild
    );
    yield* Deferred.await(sent);
    yield* Fiber.interrupt(fiber);
    expect(test.output.join("")).toContain("servidor puede haber aprobado");
    expect(test.output.join("")).not.toContain("No se envió");
    expect(test.output.join("")).toContain("No repitas");
  })
);
