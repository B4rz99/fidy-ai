import { expect, it } from "@effect/vitest";
import { Effect, Exit, Redacted } from "effect";
import { acquireCloudflareAccessToken } from "./cloudflare-access";

type StubCloudflaredProcess = Readonly<{
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
}>;

const withCloudflaredOutput = <A, E, R>(
  outputs: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => {
  const originalSpawn = Object.getOwnPropertyDescriptor(Bun, "spawn");
  let invocation = 0;
  const spawn = (): StubCloudflaredProcess => {
    const output = outputs[invocation] ?? "";
    invocation += 1;
    return {
      stdout: new ReadableStream<Uint8Array>({
        start: (controller): void => {
          controller.enqueue(new TextEncoder().encode(output));
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: (): void => undefined,
    };
  };
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      Object.defineProperty(Bun, "spawn", { ...originalSpawn, value: spawn });
    }),
    () => effect.pipe(Effect.tap(() => Effect.sync(() => expect(invocation).toBe(outputs.length)))),
    () =>
      Effect.sync(() => {
        if (originalSpawn !== undefined) Object.defineProperty(Bun, "spawn", originalSpawn);
      })
  );
};

it.effect("acquires a trimmed Cloudflare Access token", () =>
  withCloudflaredOutput(
    ["login complete\n", " access-token \n"],
    Effect.gen(function* () {
      const token = yield* acquireCloudflareAccessToken();
      expect(Redacted.value(token)).toBe("access-token");
    })
  )
);

it.effect("rejects an empty Cloudflare Access token", () =>
  withCloudflaredOutput(
    ["login complete\n", "\n"],
    Effect.gen(function* () {
      const exit = yield* acquireCloudflareAccessToken().pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    })
  )
);
