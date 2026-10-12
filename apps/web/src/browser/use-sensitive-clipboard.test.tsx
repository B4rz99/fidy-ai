import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type Cause, Effect, Option } from "effect";
import { it as effectIt } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import { SessionRegistryProvider } from "@/session/session";
import { useSession } from "@/session/session-context";
import { SensitiveClipboardBoundary } from "./use-sensitive-clipboard";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");

afterEach(() => {
  cleanup();
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

const ClipboardHarness = ({
  onCopied,
  value,
}: Readonly<{ onCopied: () => void; value: string }>): React.JSX.Element => (
  <SensitiveClipboardBoundary className={Option.none()} lifetime="10 minutes">
    {(clipboard) => (
      <button onClick={() => clipboard.copy(value, onCopied)} type="button">
        copy
      </button>
    )}
  </SensitiveClipboardBoundary>
);

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
    render(<ClipboardHarness onCopied={onCopied} value="secret" />);

    fireEvent.click(screen.getByRole("button", { name: "copy" }));
    yield* expectEventually(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "copy" }));
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
    const mounted = render(<ClipboardHarness onCopied={onCopied} value="first" />);

    fireEvent.click(screen.getByRole("button", { name: "copy" }));
    yield* expectEventually(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));
    mounted.rerender(<ClipboardHarness onCopied={onCopied} value="second" />);
    fireEvent.click(screen.getByRole("button", { name: "copy" }));
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
    const mounted = render(<ClipboardHarness onCopied={onCopied} value="secret" />);

    fireEvent.click(screen.getByRole("button", { name: "copy" }));
    yield* expectEventually(() => expect(clipboard.writeText).toHaveBeenCalledWith("secret"));
    mounted.unmount();
    clipboard.settleWrite();
    yield* expectEventually(() => expect(clipboard.read()).toBe(""));

    expect(onCopied).not.toHaveBeenCalled();
  })
);

const SessionHarness = ({ onCopied }: Readonly<{ onCopied: () => void }>): React.JSX.Element => {
  const { replaceAuthenticationLifetime } = useSession();
  return (
    <SensitiveClipboardBoundary className={Option.none()} lifetime="10 minutes">
      {(clipboard) => (
        <>
          <button onClick={() => clipboard.copy("secret", onCopied)} type="button">
            copy
          </button>
          <button onClick={replaceAuthenticationLifetime} type="button">
            replace principal
          </button>
        </>
      )}
    </SensitiveClipboardBoundary>
  );
};

effectIt.effect(
  "clears a late write and suppresses callbacks after authentication replacement",
  () =>
    Effect.gen(function* () {
      const clipboard = installDelayedClipboard();
      const onCopied = vi.fn();
      render(
        <SessionRegistryProvider>
          <SessionHarness onCopied={onCopied} />
        </SessionRegistryProvider>
      );

      fireEvent.click(screen.getByRole("button", { name: "copy" }));
      yield* expectEventually(() => expect(clipboard.writeText).toHaveBeenCalledWith("secret"));
      fireEvent.click(screen.getByRole("button", { name: "replace principal" }));
      clipboard.settleWrite();
      yield* expectEventually(() => expect(clipboard.read()).toBe(""));

      expect(onCopied).not.toHaveBeenCalled();
    })
);
