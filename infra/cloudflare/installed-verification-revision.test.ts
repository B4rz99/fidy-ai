import { it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { expect } from "vitest";
import { verificationRevision } from "./installed-verification-revision";

const trunk = "1".repeat(40);
const installed = "2".repeat(40);

it.effect("uses the deployed ancestor only after confirming the unchanged runtime tree", () =>
  Effect.gen(function* () {
    const calls: Array<ReadonlyArray<string>> = [];
    const result = yield* verificationRevision(trunk, installed, (args) => {
      calls.push(args);
      return Effect.succeed(
        args.includes("diff") ? "infra/cloudflare/native-deployed-web.ts\0" : ""
      );
    });
    expect(result).toBe(installed);
    expect(calls).toEqual([
      ["merge-base", "--is-ancestor", installed, trunk],
      ["diff", "--name-only", "--no-renames", "-z", installed, trunk, "--"],
    ]);
    expect(yield* verificationRevision(trunk, "", () => Effect.die("Unexpected git read"))).toBe(
      trunk
    );
  })
);

it.effect("refuses changed build inputs, unrelated commits and non-commit arguments", () =>
  Effect.gen(function* () {
    for (const path of [
      "apps/web/src/app.ts",
      "infra/cloudflare/native-application.ts",
      "bun.lock",
    ]) {
      const result = yield* verificationRevision(trunk, installed, (args) =>
        Effect.succeed(args.includes("diff") ? path + "\0" : "")
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }
    expect(
      Result.isFailure(
        yield* Effect.result(
          verificationRevision(trunk, installed, () => Effect.fail(Error("unrelated")))
        )
      )
    ).toBe(true);
    expect(
      Result.isFailure(
        yield* Effect.result(
          verificationRevision("HEAD", "", () => Effect.die("Unexpected git read"))
        )
      )
    ).toBe(true);
    expect(
      Result.isFailure(
        yield* Effect.result(
          verificationRevision(trunk, "HEAD~1", () => Effect.die("Unexpected git read"))
        )
      )
    ).toBe(true);
  })
);

it.effect("accepts only the reviewed fleet driver and refuses neighboring runtime or unreviewed metering inputs", () =>
  Effect.gen(function* () {
    const changed = (path: string): ReturnType<typeof verificationRevision> => verificationRevision(trunk, installed, (args) =>
      Effect.succeed(args.includes("diff") ? path + "\0" : "")
    );
    expect(yield* changed("scripts/infra-performance/deployed-fleet/pilot.py")).toBe(installed);
    for (const path of ["apps/server/cloudflare/maintenance/runtime.ts", "scripts/infra-performance/deployed-fleet/other.py"]) {
      expect(Result.isFailure(yield* Effect.result(changed(path)))).toBe(true);
    }
  })
);
