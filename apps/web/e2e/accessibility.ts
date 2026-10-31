import type { Page } from "@playwright/test";

const { AxeBuilder } = await import("@axe-core/playwright");
type AccessibilityResult = Awaited<ReturnType<InstanceType<typeof AxeBuilder>["analyze"]>>;

const hasFrames = (page: Page): Promise<boolean> =>
  page
    .locator("iframe, frame")
    .count()
    .then((count) => count > 0 || page.frames().length > 1);
const analyzeFrames = (page: Page): Promise<AccessibilityResult> =>
  new AxeBuilder({ page }).analyze();
const analyzeDocument = (page: Page): Promise<AccessibilityResult> =>
  new AxeBuilder({ page })
    .setLegacyMode()
    .analyze()
    .then((result) => hasFrames(page).then((frames) => (frames ? analyzeFrames(page) : result)));

/** Avoid the extra result-aggregation page only when the complete document has no frames. */
export const analyzeAccessibility = (page: Page): Promise<AccessibilityResult> =>
  hasFrames(page).then((frames) => (frames ? analyzeFrames(page) : analyzeDocument(page)));
