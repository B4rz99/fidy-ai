import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Apply from "alchemy/Apply";
import * as Command from "alchemy/Command";
import * as Plan from "alchemy/Plan";
import { AuthProviders } from "alchemy/Auth";
import { evalStack } from "alchemy/EvalStack";
import { InMemoryService, State } from "alchemy/State";
import { it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer } from "effect";
import { expect } from "vitest";

it.effect(
  "requires the retained build output on a fresh release runner to plan Web Build as noop",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(cwd + "/.gitignore", "dist\n");
      yield* fs.writeFileString(cwd + "/source.txt", "retained source");
      yield* fs.writeFileString(
        cwd + "/build.ts",
        'await Bun.write("dist/asset", Bun.file("source.txt"));'
      );
      const store = InMemoryService();
      const state = Layer.succeed(State, store);

      const stack = Alchemy.Stack(
        "RetainedWebBuild",
        { providers: Command.providers(), state },
        Command.Build("Build", { cwd, outdir: "dist", command: "bun build.ts" })
      );

      const inspect = Effect.fn(function* (install: boolean) {
        return yield* evalStack(
          stack,
          Effect.fn(function* (compiled) {
            const plan = yield* Plan.make(compiled);
            const [row] = Plan.describePlan(plan).resources;

            if (install) yield* Apply.apply(plan).pipe(Effect.provide(compiled.services));

            return row?.action;
          }),
          { stage: "production" }
        ).pipe(Effect.provideService(State, store));
      });

      expect(yield* inspect(true)).toBe("create");
      yield* fs.remove(cwd + "/dist", { recursive: true });
      expect(yield* inspect(false)).toBe("update");
      yield* fs.makeDirectory(cwd + "/dist");
      yield* fs.writeFileString(cwd + "/dist/asset", "retained source");
      expect(yield* inspect(false)).toBe("noop");
    }).pipe(
      Effect.provideService(AuthProviders, {}),
      Effect.provide([Alchemist.layer(), BunServices.layer]),
      Effect.scoped
    )
);
