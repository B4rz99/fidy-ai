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
        args.includes("diff")
          ? "infra/cloudflare/native-deployed-web.ts\0infra/cloudflare/native-erasure.ts\0"
          : ""
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
    yield* Effect.forEach(
      [
        "apps/web/src/app.ts",
        "infra/cloudflare/native-application.ts",
        "infra/cloudflare/native-erasure-evidence.ts",
        "bun.lock",
      ],
      Effect.fnUntraced(function* (path) {
        const result = yield* verificationRevision(trunk, installed, (args) =>
          Effect.succeed(args.includes("diff") ? path + "\0" : "")
        ).pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
      }),
      { discard: true }
    );

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

it.effect(
  "accepts only the reviewed fleet driver and refuses neighboring runtime or unreviewed metering inputs",
  () =>
    Effect.gen(function* () {
      const changed = (path: string): ReturnType<typeof verificationRevision> =>
        verificationRevision(trunk, installed, (args) =>
          Effect.succeed(args.includes("diff") ? path + "\0" : "")
        );

      yield* Effect.forEach(
        [
          "scripts/infra-performance/deployed-fleet/pilot.py",
          "scripts/infra-performance/deployed-fleet/ten.py",
          "scripts/infra-performance/deployed-fleet/ten-source.sh",
          "infra/cloudflare/native-ten-fleet.ts",
          "infra/cloudflare/native-ten-release.ts",
          "docs/adr/0041-per-user-durable-object-storage-direction.md",
        ],
        Effect.fnUntraced(function* (path) {
          expect(yield* changed(path)).toBe(installed);
        }),
        { discard: true }
      );

      yield* Effect.forEach(
        [
          "apps/server/cloudflare/maintenance/runtime.ts",
          "scripts/infra-performance/deployed-fleet/other.py",
          "infra/cloudflare/native-ten-runtime.ts",
          "docs/adr/0000-unreviewed.md",
          "apps/server/package.json",
        ],
        Effect.fnUntraced(function* (path) {
          expect(Result.isFailure(yield* Effect.result(changed(path)))).toBe(true);
        }),
        { discard: true }
      );
    })
);

it.effect("allows only the reviewed Workers declaration refresh across the exact Git blobs", () =>
  Effect.gen(function* () {
    const paths = "apps/server/package.json\0bun.lock\0infra/cloudflare/package.json\0";

    const raw = [
      ":100644 100644 bd090a37f14232d15dda4e39ec82a7958a110e8b 5d310aa462a7c4d16853e2ce49e5009cd4086047 M\tapps/server/package.json",
      ":100644 100644 761257790873b34b8a9bf8a1e07c428d6248fe3d 211379fd87e4a55a39bb498d5f65fea72e50fe6c M\tbun.lock",
      ":100644 100644 4b4d2769d45666eb66d57a071f63767a4c3a981e ade98affc69e6e3801f078d80541f4b9cf0b4847 M\tinfra/cloudflare/package.json",
    ].join("\n");

    const verify = (blobs: string): ReturnType<typeof verificationRevision> =>
      verificationRevision(trunk, installed, (args) => {
        if (args.includes("--raw")) return Effect.succeed(blobs);

        return Effect.succeed(args.includes("--name-only") ? paths : "");
      });

    expect(yield* verify(raw)).toBe(installed);
    expect(yield* Effect.isFailure(verify(raw.replace("211379fd", "ffffffff")))).toBe(true);
  })
);
