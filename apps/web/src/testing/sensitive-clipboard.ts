import { vi } from "vitest";
import type { SensitiveClipboard } from "@/browser/sensitive-clipboard";

/** Substitute sensitive clipboard command with inspectable callbacks for rendered feature tests. */
export type SensitiveClipboardSpy = Readonly<{
  reveal: ReturnType<typeof vi.fn<(onExpired: () => void) => void>>;
  copy: ReturnType<typeof vi.fn<(value: string, onCopied: () => void) => void>>;
  clear: ReturnType<typeof vi.fn<(value: string) => void>>;
}>;

/** Creates a fresh clipboard substitute whose successful writes invoke only the copied callback. */
export const makeSensitiveClipboardSpy = (copySucceeded = true): SensitiveClipboardSpy =>
  ({
    reveal: vi.fn(),
    copy: vi.fn((_value: string, onCopied: () => void) => {
      if (copySucceeded) onCopied();
    }),
    clear: vi.fn(),
  }) satisfies SensitiveClipboard;
