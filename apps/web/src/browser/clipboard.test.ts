// @vitest-environment jsdom

import { Deferred, Effect, Exit, Option, Scope } from "effect";
import { TestClock } from "effect/testing";
import { it as effectIt, expect } from "@effect/vitest";
import { vi } from "vitest";
import { type BrowserClipboard, ClipboardAccessFailed, writeClipboardText } from "./clipboard";
import { makeSensitiveClipboard } from "./sensitive-clipboard";

effectIt.effect("writes text through an available browser clipboard", () =>
  Effect.gen(function* () {
    const writeText = vi.fn(() => Promise.resolve());

    yield* writeClipboardText(Option.some({ writeText }), "texto");

    expect(writeText).toHaveBeenCalledWith("texto");
  })
);

effectIt.effect("reports clipboard rejection through the typed failure channel", () =>
  Effect.gen(function* () {
    const writeText = vi.fn(() => Promise.reject(new Error("permission denied")));

    const exit = yield* Effect.exit(writeClipboardText(Option.some({ writeText }), "texto"));

    expect(exit).toEqual(Exit.fail(new ClipboardAccessFailed()));
  })
);

effectIt.effect("reports an unavailable clipboard through the typed failure channel", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(writeClipboardText(Option.none(), "texto"));

    expect(exit).toEqual(Exit.fail(new ClipboardAccessFailed()));
  })
);

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
    const owner = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
      Scope.close(scope, exit)
    );
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

effectIt.effect("late clipboard completion after disposal preserves unrelated newer text", () =>
  Effect.gen(function* () {
    const pending = Promise.withResolvers<void>();
    const started = yield* Deferred.make<void>();
    const context = yield* Effect.context<never>();
    const stub = clipboardStub();
    let copied = 0;
    const owner = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
      Scope.close(scope, exit)
    );
    const clipboard: BrowserClipboard = {
      readText: stub.clipboard.readText,
      writeText: (value) => {
        stub.replace(value);
        if (value !== "old-recovery-code") return Promise.resolve();
        Effect.runSyncWith(context)(Deferred.succeed(started, undefined));
        return pending.promise;
      },
    };
    const command = yield* makeSensitiveClipboard(Option.some(clipboard), "10 minutes").pipe(
      Scope.provide(owner)
    );
    command.copy("old-recovery-code", () => {
      copied += 1;
    });
    yield* Deferred.await(started);
    yield* Scope.close(owner, Exit.void);
    stub.replace("new clipboard text");
    pending.resolve();
    yield* Effect.tryPromise(() => pending.promise);
    yield* Effect.yieldNow;
    expect(copied).toBe(0);
    expect(stub.read()).toBe("new clipboard text");
  })
);

effectIt.effect("an exact release cannot erase a newer identical copy", () =>
  Effect.gen(function* () {
    const stub = clipboardStub();
    const command = yield* makeSensitiveClipboard(Option.some(stub.clipboard), "10 minutes");
    const first = command.copy("same-secret");
    yield* Effect.yieldNow;
    const second = command.copy("same-secret");
    yield* Effect.yieldNow;
    first.release();
    yield* Effect.yieldNow;
    expect(stub.read()).toBe("same-secret");
    second.release();
    yield* Effect.yieldNow;
    expect(stub.read()).toBe("");
  })
);

effectIt.effect("a released copy's delayed read cannot clear a newer identical copy", () =>
  Effect.gen(function* () {
    const stub = clipboardStub();
    const read = Promise.withResolvers<string>();
    const reading = yield* Deferred.make<void>();
    const context = yield* Effect.context<never>();
    const command = yield* makeSensitiveClipboard(
      Option.some({
        writeText: stub.clipboard.writeText,
        readText: () => {
          Effect.runSyncWith(context)(Deferred.succeed(reading, undefined));
          return read.promise;
        },
      }),
      "10 minutes"
    );
    const first = command.copy("same-secret");
    yield* Effect.yieldNow;
    first.release();
    yield* Deferred.await(reading);
    command.copy("same-secret");
    yield* Effect.yieldNow;
    read.resolve("same-secret");
    yield* Effect.yieldNow;
    expect(stub.read()).toBe("same-secret");
  })
);

effectIt.effect(
  "reversed native completions repair to the live copy without renewing its deadline",
  () =>
    Effect.gen(function* () {
      const stub = clipboardStub();
      const pending = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const callbacks = [vi.fn(), vi.fn(), vi.fn()];
      let writes = 0;
      const clipboard: BrowserClipboard = {
        readText: stub.clipboard.readText,
        writeText: (text) => {
          const index = writes++;
          if (index < 2) {
            return (pending[index]?.promise ?? Promise.resolve()).then(() => stub.replace(text));
          }
          stub.replace(text);
          return Promise.resolve();
        },
      };
      const command = yield* makeSensitiveClipboard(Option.some(clipboard), "10 minutes");
      command.copy("oldest", callbacks[0]);
      yield* Effect.yieldNow;
      command.copy("middle", callbacks[1]);
      yield* Effect.yieldNow;
      command.copy("latest", callbacks[2]);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("9 minutes");
      pending[1]?.resolve();
      yield* Effect.yieldNow;
      pending[0]?.resolve();
      yield* Effect.yieldNow;
      expect(stub.read()).toBe("latest");
      expect(callbacks.map((callback) => callback.mock.calls.length)).toEqual([0, 0, 1]);
      yield* TestClock.adjust("1 minute");
      expect(stub.read()).toBe("");
      expect(callbacks[2]).toHaveBeenCalledTimes(1);
    })
);

effectIt.effect(
  "release before native settlement suppresses Copied and cleans the late write",
  () =>
    Effect.gen(function* () {
      const stub = clipboardStub();
      const pending = Promise.withResolvers<void>();
      const copied = vi.fn();
      const command = yield* makeSensitiveClipboard(
        Option.some({
          readText: stub.clipboard.readText,
          writeText: (text) =>
            text === "late-secret"
              ? pending.promise.then(() => stub.replace(text))
              : stub.clipboard.writeText(text),
        }),
        "10 minutes"
      );
      const release = command.copy("late-secret", copied);
      yield* Effect.yieldNow;
      release.release();
      pending.resolve();
      yield* Effect.yieldNow;
      expect(copied).not.toHaveBeenCalled();
      expect(stub.read()).toBe("");
    })
);

effectIt.effect("copying does not extend the independent reveal deadline", () =>
  Effect.gen(function* () {
    const stub = clipboardStub();
    const expired = vi.fn();
    const command = yield* makeSensitiveClipboard(Option.some(stub.clipboard), "10 minutes");
    command.reveal(expired);
    yield* TestClock.adjust("9 minutes");
    command.copy("secret");
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 minute");
    expect(expired).toHaveBeenCalledTimes(1);
    expect(stub.read()).toBe("");
  })
);

effectIt.effect("a rejected write never acknowledges Copied and later copy remains usable", () =>
  Effect.gen(function* () {
    const stub = clipboardStub();
    const copied = vi.fn();
    const command = yield* makeSensitiveClipboard(
      Option.some({
        readText: stub.clipboard.readText,
        writeText: (text) =>
          text === "rejected"
            ? Promise.reject(new Error("denied"))
            : stub.clipboard.writeText(text),
      }),
      "10 minutes"
    );
    command.copy("rejected", copied);
    yield* Effect.yieldNow;
    expect(copied).not.toHaveBeenCalled();
    command.copy("accepted", copied);
    yield* Effect.yieldNow;
    expect(copied).toHaveBeenCalledTimes(1);
    expect(stub.read()).toBe("accepted");
  })
);

for (const denied of ["read", "clear"] as const) {
  effectIt.effect(`denied ${denied} drops cleanup authority without a second release attempt`, () =>
    Effect.gen(function* () {
      const stub = clipboardStub();
      const readText = vi.fn(() =>
        denied === "read" ? Promise.reject(new Error("denied")) : stub.clipboard.readText()
      );
      const writeText = vi.fn((text: string) =>
        text === "" && denied === "clear"
          ? Promise.reject(new Error("denied"))
          : stub.clipboard.writeText(text)
      );
      const command = yield* makeSensitiveClipboard(
        Option.some({ readText, writeText }),
        "10 minutes"
      );
      const copy = command.copy("secret");
      yield* Effect.yieldNow;
      copy.release();
      yield* Effect.yieldNow;
      copy.release();
      yield* TestClock.adjust("10 minutes");
      expect(stub.read()).toBe("secret");
      expect(readText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledTimes(denied === "clear" ? 2 : 1);
    })
  );
}

effectIt.effect("commands after scope closure admit no native writes or callbacks", () =>
  Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (owner, exit) =>
      Scope.close(owner, exit)
    );
    const writeText = vi.fn(() => Promise.resolve());
    const callback = vi.fn();
    const command = yield* makeSensitiveClipboard(
      Option.some({
        readText: () => Promise.resolve(""),
        writeText,
      }),
      "10 minutes"
    ).pipe(Scope.provide(scope));
    yield* Scope.close(scope, Exit.void);
    command.copy("secret", callback).release();
    command.reveal(callback);
    yield* TestClock.adjust("20 minutes");
    expect(writeText).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  })
);

effectIt.effect("a failed replacement does not strand the prior successful copy", () =>
  Effect.gen(function* () {
    const stub = clipboardStub();
    const copied = vi.fn();
    const command = yield* makeSensitiveClipboard(
      Option.some({
        readText: stub.clipboard.readText,
        writeText: (text) =>
          text === "rejected-replacement"
            ? Promise.reject(new Error("denied"))
            : stub.clipboard.writeText(text),
      }),
      "10 minutes"
    );
    command.copy("prior-secret", copied);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("5 minutes");
    command.copy("rejected-replacement", copied);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("20 minutes");
    expect(copied).toHaveBeenCalledTimes(1);
    expect(stub.read()).toBe("");
  })
);

effectIt.effect("a replacement's deferred cleanup read cannot erase a later identical copy", () =>
  Effect.gen(function* () {
    const stub = clipboardStub();
    const pending = Promise.withResolvers<string>();
    let reads = 0;
    const command = yield* makeSensitiveClipboard(
      Option.some({
        readText: () => (++reads === 1 ? pending.promise : stub.clipboard.readText()),
        writeText: stub.clipboard.writeText,
      }),
      "10 minutes"
    );
    const copied = vi.fn();
    command.copy("same", copied);
    yield* Effect.yieldNow;
    command.copy("middle", copied);
    yield* Effect.yieldNow;
    command.copy("same", copied);
    yield* Effect.yieldNow;
    pending.resolve("same");
    yield* Effect.yieldNow;
    expect(stub.read()).toBe("same");
    expect(copied).toHaveBeenCalledTimes(2);
  })
);

effectIt.effect("a delayed replacement cleanup write repairs to the latest original deadline", () =>
  Effect.gen(function* () {
    const stub = clipboardStub();
    const pending = Promise.withResolvers<void>();
    let clears = 0;
    const command = yield* makeSensitiveClipboard(
      Option.some({
        readText: stub.clipboard.readText,
        writeText: (value) =>
          value === "" && ++clears === 1
            ? pending.promise.then(() => stub.replace(value))
            : stub.clipboard.writeText(value),
      }),
      "10 minutes"
    );
    const copied = vi.fn();
    command.copy("first", copied);
    yield* Effect.yieldNow;
    command.copy("middle", copied);
    yield* Effect.yieldNow;
    command.copy("latest", copied);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("9 minutes");
    pending.resolve();
    yield* Effect.yieldNow;
    expect(stub.read()).toBe("latest");
    expect(copied).toHaveBeenCalledTimes(2);
    yield* TestClock.adjust("1 minute");
    expect(stub.read()).toBe("");
    expect(copied).toHaveBeenCalledTimes(2);
  })
);
