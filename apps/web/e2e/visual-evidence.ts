import type { Locator, Page } from "@playwright/test";

/** Export review images on request; regression assertions run independently of image export. */
export const captureVisualEvidence = ({
  target,
  options,
}: Readonly<{
  target: Page | Locator;
  options: NonNullable<Parameters<Page["screenshot"]>[0]>;
}>): Promise<void> =>
  Bun.env.BROWSER_VISUAL_EVIDENCE === "true"
    ? target.screenshot(options).then(() => undefined)
    : Promise.resolve();
