import { waitFor } from "@testing-library/dom";
import { type Cause, Effect } from "effect";
import { it as effectIt } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import { makeApplicationOwner } from "@/app/native-lifetime";
import { makeAuthenticationLifetime } from "@/session/lifetime";
import { makeMountedClipboard } from "./mounted-clipboard";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");

afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers.clear();
  vi.restoreAllMocks();
  if (clipboardDescriptor === undefined) {
    Reflect.deleteProperty(globalThis.navigator, "clipboard");
  } else {
    Object.defineProperty(globalThis.navigator, "clipboard", clipboardDescriptor);
  }
});

const installClipboard = (
  readText: () => Promise<string>,
  writeText: (text: string) => Promise<void>
): void => {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { readText, writeText },
  });
};

const disposers = new Set<() => void>();
const mountedClipboard = (): ReturnType<typeof makeMountedClipboard> => {
  const mounted = makeMountedClipboard("10 minutes");
  disposers.add(mounted.dispose);
  return mounted;
};

type DelayedClipboard = Readonly<{
  read: () => string;
  settleWrite: () => void;
  settleWriteAt: (index: number) => void;
  writeText: ReturnType<typeof vi.fn<(value: string) => Promise<void>>>;
}>;

const installDelayedClipboard = (denyReads = false): DelayedClipboard => {
  let text = "";
  const pendingWrites: Array<() => void> = [];
  const writeText = vi.fn((value: string): Promise<void> => {
    if (value === "") {
      text = value;
      return Promise.resolve();
    }
    const pending = Promise.withResolvers<void>();
    pendingWrites.push(() => {
      text = value;
      pending.resolve();
    });
    return pending.promise;
  });
  installClipboard(
    () => (denyReads ? Promise.reject(new Error("clipboard read denied")) : Promise.resolve(text)),
    writeText
  );
  return {
    read: () => text,
    settleWrite: () => pendingWrites.at(-1)?.(),
    settleWriteAt: (index) => pendingWrites[index]?.(),
    writeText,
  };
};

const expectEventually = (assertion: () => void): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => waitFor(assertion));

effectIt.effect("does not let a replaced same-value write clear the newer copy", () =>
  Effect.gen(function* () {
    const clipboard = installDelayedClipboard();
    const onCopied = vi.fn();
    const mounted = mountedClipboard();

    mounted.clipboard.copy("secret", onCopied);
    yield* expectEventually(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));
    mounted.clipboard.copy("secret", onCopied);
    yield* expectEventually(() => expect(clipboard.writeText).toHaveBeenCalledTimes(2));

    clipboard.settleWriteAt(1);
    yield* expectEventually(() => expect(onCopied).toHaveBeenCalledTimes(1));
    clipboard.settleWriteAt(0);
    yield* expectEventually(() => expect(clipboard.read()).toBe("secret"));
  })
);

effectIt.effect("reasserts a newer different value when a replaced write finishes late", () =>
  Effect.gen(function* () {
    const clipboard = installDelayedClipboard();
    const onCopied = vi.fn();
    const mounted = mountedClipboard();

    mounted.clipboard.copy("first", onCopied);
    yield* expectEventually(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));
    mounted.clipboard.copy("second", onCopied);
    yield* expectEventually(() => expect(clipboard.writeText).toHaveBeenCalledTimes(2));

    clipboard.settleWriteAt(1);
    yield* expectEventually(() => expect(clipboard.read()).toBe("second"));
    clipboard.settleWriteAt(0);
    yield* expectEventually(() => expect(clipboard.writeText).toHaveBeenCalledTimes(3));
    clipboard.settleWriteAt(2);
    yield* expectEventually(() => expect(clipboard.read()).toBe("second"));
  })
);

effectIt.effect("clears a late write after unmount even when clipboard reads are denied", () =>
  Effect.gen(function* () {
    const clipboard = installDelayedClipboard(true);
    const onCopied = vi.fn();
    const mounted = mountedClipboard();

    mounted.clipboard.copy("secret", onCopied);
    yield* expectEventually(() => expect(clipboard.writeText).toHaveBeenCalledWith("secret"));
    mounted.dispose();
    clipboard.settleWrite();
    yield* expectEventually(() => expect(clipboard.read()).toBe(""));

    expect(onCopied).not.toHaveBeenCalled();
  })
);

effectIt.effect(
  "clears a late write and suppresses callbacks after authentication replacement",
  () =>
    Effect.gen(function* () {
      const clipboard = installDelayedClipboard();
      const onCopied = vi.fn();
      const owner = makeApplicationOwner({
        createLifetime: (onExpired) =>
          makeAuthenticationLifetime({ apiOrigin: "https://api.test.fidyapp.com", onExpired }),
        dispatch: () => undefined,
      });
      disposers.add(owner.dispose);
      const mounted = mountedClipboard();
      owner.retain({ epoch: 0, mount: () => mounted.dispose });

      mounted.clipboard.copy("secret", onCopied);
      yield* expectEventually(() => expect(clipboard.writeText).toHaveBeenCalledWith("secret"));
      owner.transition("signed-in");
      clipboard.settleWrite();
      yield* expectEventually(() => expect(clipboard.read()).toBe(""));

      expect(onCopied).not.toHaveBeenCalled();
    })
);
