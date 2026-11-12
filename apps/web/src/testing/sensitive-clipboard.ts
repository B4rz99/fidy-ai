import { vi } from "vitest";
import type { CopyRelease, SensitiveClipboard } from "@/browser/sensitive-clipboard";

export type SensitiveClipboardSpy = Readonly<{
  reveal: ReturnType<typeof vi.fn<(onExpired: () => void) => void>>;
  copy: ReturnType<typeof vi.fn<(value: string, onCopied?: () => void) => CopyRelease>>;
  release: ReturnType<typeof vi.fn<() => void>>;
}>;

export const makeSensitiveClipboardSpy = (copySucceeded = true): SensitiveClipboardSpy => {
  const release = vi.fn();
  return {
    reveal: vi.fn(),
    copy: vi.fn((_value: string, onCopied?: () => void) => {
      if (copySucceeded) onCopied?.();
      return { release };
    }),
    release,
  } satisfies SensitiveClipboard & { release: () => void };
};
