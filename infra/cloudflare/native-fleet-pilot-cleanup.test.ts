import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { continueFleetCleanup } from "./native-fleet-pilot";

const hash = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

type Input = Parameters<typeof continueFleetCleanup>[0];

const fixture = (): { rows: Map<string, boolean>; stages: string[]; input: Input } => {
  const rows = new Map([
    ["prior", true],
    ["old", false],
    ["target", true],
  ]);

  const stages: string[] = [];

  const input: Input = {
    target: "target",
    targetSha256: hash("target"),
    userSha256: hash("pilot-user"),
    baselineSha256: hash("old:false\nprior:true"),
    inventory: () => Effect.sync(() => new Map(rows)),
    renewCleanup: () => Effect.void,
    budget: () => Effect.void,
    login: () =>
      Effect.succeed({
        id: "pilot-user",
        outcome: "approved",
        erase: () =>
          Effect.sync(() => {
            stages.push("posted");
            rows.set("target", false);
          }).pipe(Effect.andThen(Effect.fail(Error("lost response")))),
        denied: () =>
          Effect.sync(() => {
            stages.push("denied");
          }),
      }),
    refused: () =>
      Effect.sync(() => {
        stages.push("provider-refused");
      }),
    record: (event: Readonly<Record<string, string | number>>) =>
      Effect.sync(() => {
        stages.push(String(event["stage"]));
      }),
  };

  return { rows, stages, input };
};

it.effect("verifies the same archived User after a lost erasure reply", () =>
  Effect.gen(function* () {
    const { input, stages } = fixture();
    yield* continueFleetCleanup(input);
    expect(stages).toContain("posted");
    expect(stages).toContain("erasure-reply-unconfirmed");
    expect(stages).toContain("denied");
    expect(stages).toContain("provider-refused");
    expect(stages.at(-1)).toBe("physical-rechecked");
  })
);

it.effect(
  "requires the original logical User, physical object and full baseline before erasure",
  () =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        [
          { userSha256: hash("other") },
          { target: "prior" },
          { baselineSha256: hash("prior:true") },
        ],
        Effect.fnUntraced(function* (changes) {
          const { input, stages } = fixture();
          const verdict = yield* continueFleetCleanup({ ...input, ...changes }).pipe(Effect.result);
          expect(verdict._tag).toBe("Failure");
          expect(stages).not.toContain("posted");
        }),
        { discard: true }
      );

      const { input, rows, stages } = fixture();
      rows.set("old", true);
      expect((yield* continueFleetCleanup(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(stages).not.toContain("posted");
    })
);

it.effect("verifies an already-disposed target without another erasure or work lease", () =>
  Effect.gen(function* () {
    const { input, rows, stages } = fixture();
    rows.delete("target");
    yield* continueFleetCleanup({
      ...input,
      login: () => Effect.die("unexpected login to erase"),
      renewCleanup: () => Effect.die("unexpected lease"),
    });
    expect(stages).toContain("provider-refused");
    expect(stages.at(-1)).toBe("physical-rechecked");
  })
);

it.effect("rejects storage that reappears while verifying the erased provider pairing", () =>
  Effect.gen(function* () {
    const { input, rows, stages } = fixture();
    rows.set("target", false);

    const verdict = yield* continueFleetCleanup({
      ...input,
      refused: () =>
        Effect.sync(() => {
          rows.set("target", true);
        }),
    }).pipe(Effect.result);

    expect(verdict._tag).toBe("Failure");
    expect(stages).not.toContain("physical-rechecked");
  })
);

it.effect("stops before submitting erasure when the fresh meter refuses", () =>
  Effect.gen(function* () {
    const { input, stages } = fixture();

    const verdict = yield* continueFleetCleanup({
      ...input,
      budget: () => Effect.fail(Error("cleanup reserve exceeded")),
    }).pipe(Effect.result);

    expect(verdict._tag).toBe("Failure");
    expect(stages).not.toContain("posted");
  })
);
