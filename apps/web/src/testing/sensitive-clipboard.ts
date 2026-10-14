import { vi } from "vitest";
import type { SensitiveClipboard } from "@/browser/sensitive-clipboard";

export type SensitiveClipboardSpy = Readonly<{
  reveal: ReturnType<typeof vi.fn<(onExpired: () => void) => void>>;
  copy: ReturnType<typeof vi.fn<(value: string, onCopied: () => void) => void>>;
  clear: ReturnType<typeof vi.fn<(value: string) => void>>;
}>;

export const makeSensitiveClipboardSpy = (copySucceeded = true): SensitiveClipboardSpy =>
  ({
    reveal: vi.fn(),
    copy: vi.fn((_value: string, onCopied: () => void) => {
      if (copySucceeded) onCopied();
    }),
    clear: vi.fn(),
  }) satisfies SensitiveClipboard;
