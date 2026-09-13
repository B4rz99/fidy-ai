import assert from "node:assert/strict";
import { Deferred, Effect, Exit, Option, Scope } from "effect";
import { TestClock } from "effect/testing";
import { it as effectIt, expect } from "@effect/vitest";
import { it, vi } from "vitest";
import { type BrowserClipboard, ClipboardAccessFailed, writeClipboardText } from "./clipboard";
import { makeSensitiveClipboard } from "./sensitive-clipboard";

it("writes text through an available browser clipboard", async () => {
  const writeText = vi.fn(() => Promise.resolve());

  await Effect.runPromise(writeClipboardText(Option.some({ writeText }), "texto"));

  expect(writeText).toHaveBeenCalledWith("texto");
});

it("reports clipboard rejection through the typed failure channel", async () => {
  const writeText = vi.fn(() => Promise.reject(new Error("permission denied")));

  const exit = await Effect.runPromise(
    Effect.exit(writeClipboardText(Option.some({ writeText }), "texto"))
  );

  assert.deepStrictEqual(exit, Exit.fail(new ClipboardAccessFailed()));
});

it("reports an unavailable clipboard through the typed failure channel", async () => {
  const exit = await Effect.runPromise(Effect.exit(writeClipboardText(Option.none(), "texto")));

  assert.deepStrictEqual(exit, Exit.fail(new ClipboardAccessFailed()));
});

type ClipboardStub = Readonly<{
  clipboard: BrowserClipboard;
  read: () => string;
  replace: (next: string) => void;
}>;

const clipboardStub = (initial = ""): ClipboardStub => {
  let text = initial;
  return {
    clipboard: {
      readText: (): Promise<string> => Promise.resolve(text),
      writeText: (next: string): Promise<void> => {
        text = next;
        return Promise.resolve();
      },
    },
    read: (): string => text,
    replace: (next: string): void => {
      text = next;
    },
  };
};

effectIt.effect("expiry clears the matching sensitive clipboard value", () =>
  Effect.gen(function* () {
    const stub = clipboardStub();
    const copied = yield* Deferred.make<void>();
    const context = yield* Effect.context<never>();
    const command = yield* makeSensitiveClipboard(Option.some(stub.clipboard), "10 minutes");

    command.copy("sensitive-value", () =>
      Effect.runSyncWith(context)(Deferred.succeed(copied, undefined))
    );
    yield* Deferred.await(copied);
    yield* TestClock.adjust("10 minutes");

    expect(stub.read()).toBe("");
  })
);

effectIt.effect("a replacement copy owns expiry without clearing newer clipboard content", () =>
  Effect.gen(function* () {
    const stub = clipboardStub();
    const firstCopied = yield* Deferred.make<void>();
    const secondCopied = yield* Deferred.make<void>();
    const context = yield* Effect.context<never>();
    const command = yield* makeSensitiveClipboard(Option.some(stub.clipboard), "10 minutes");

    command.copy("first-secret", () =>
      Effect.runSyncWith(context)(Deferred.succeed(firstCopied, undefined))
    );
    yield* Deferred.await(firstCopied);
    yield* TestClock.adjust("5 minutes");
    command.copy("second-secret", () =>
      Effect.runSyncWith(context)(Deferred.succeed(secondCopied, undefined))
    );
    yield* Deferred.await(secondCopied);
    yield* TestClock.adjust("5 minutes");
    expect(stub.read()).toBe("second-secret");

    stub.replace("unrelated clipboard text");
    yield* TestClock.adjust("5 minutes");

    expect(stub.read()).toBe("unrelated clipboard text");
  })
);

effectIt.effect("closing its owner interrupts pending sensitive callbacks immediately", () =>
  Effect.gen(function* () {
    const stub = clipboardStub();
    const copied = yield* Deferred.make<void>();
    const owner = yield* Scope.make();
    const context = yield* Effect.context<never>();
    let expired = 0;
    const command = yield* makeSensitiveClipboard(Option.some(stub.clipboard), "10 minutes").pipe(
      Scope.provide(owner)
    );

    command.reveal(() => {
      expired += 1;
    });
    command.copy("recovery-secret", () =>
      Effect.runSyncWith(context)(Deferred.succeed(copied, undefined))
    );
    yield* Deferred.await(copied);
    yield* Scope.close(owner, Exit.void);
    yield* TestClock.adjust("10 minutes");

    expect(expired).toBe(0);
    expect(stub.read()).toBe("");
  })
);

effectIt.effect("denied clipboard access stays silent while the reveal still expires", () =>
  Effect.gen(function* () {
    let copied = 0;
    let expired = 0;
    const command = yield* makeSensitiveClipboard(Option.none(), "10 minutes");

    command.reveal(() => {
      expired += 1;
    });
    command.copy("secret", () => {
      copied += 1;
    });
    yield* Effect.yieldNow;
    yield* TestClock.adjust("10 minutes");

    expect(copied).toBe(0);
    expect(expired).toBe(1);
  })
);
