import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect } from "vitest";
import { makeEnrollmentCommand } from "./enrollment-command";

const registryResource = Effect.acquireRelease(
  Effect.sync(() => AtomRegistry.make()),
  (registry) => Effect.sync(() => registry.dispose())
);

it.effect("consumes transient enrollment work once without replaying it on an empty command", () =>
  Effect.gen(function* () {
    const registry = yield* registryResource;
    const command = makeEnrollmentCommand<string, never>();
    yield* AtomRegistry.mount(registry, command.atom);
    let calls = 0;
    command.offer(
      Effect.sync(() => {
        calls += 1;
        return "prepared";
      })
    );
    registry.set(command.atom, undefined);
    expect(yield* AtomRegistry.getResult(registry, command.atom, { suspendOnWaiting: true })).toBe(
      "prepared"
    );
    registry.set(command.atom, undefined);
    const result = yield* Effect.exit(
      AtomRegistry.getResult(registry, command.atom, { suspendOnWaiting: true })
    );
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
    expect(calls).toBe(1);
  })
);

it.effect(
  "command interruption closes pending enrollment work before a replacement can finish",
  () =>
    Effect.gen(function* () {
      const registry = yield* registryResource;
      const command = makeEnrollmentCommand<string, never>();
      yield* AtomRegistry.mount(registry, command.atom);
      const started = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      command.offer(
        Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
          Deferred.succeed(closed, undefined)
        ).pipe(Effect.andThen(Effect.never), Effect.scoped)
      );
      registry.set(command.atom, undefined);
      yield* Deferred.await(started);
      command.clear();
      registry.set(command.atom, Atom.Interrupt);
      yield* Deferred.await(closed);
      command.offer(Effect.succeed("replacement"));
      registry.set(command.atom, undefined);
      expect(
        yield* AtomRegistry.getResult(registry, command.atom, { suspendOnWaiting: true })
      ).toBe("replacement");
    })
);
