import type { Page } from "@playwright/test";
import { readAccessibilityResult } from "./accessibility-result";

const { AxeBuilder } = await import("@axe-core/playwright");
const axeSource = await Bun.file(new URL(import.meta.resolve("axe-core/axe.min.js"))).text();
type AccessibilityResult = Awaited<ReturnType<InstanceType<typeof AxeBuilder>["analyze"]>>;
const auditExpression =
  'axe.configure({allowedOrigins:["<same_origin>"],branding:{application:"playwright"}}),axe.run(document)';

const hasFrames = (page: Page): Promise<boolean> =>
  page
    .locator("iframe, frame")
    .count()
    .then((count) => count > 0 || page.frames().length > 1);
const analyzeFrames = (page: Page): Promise<AccessibilityResult> =>
  new AxeBuilder({ page, axeSource }).analyze();
const analyzeWithNativeTimers = (page: Page): Promise<AccessibilityResult> =>
  page
    .context()
    .newCDPSession(page)
    .then((session) =>
      session
        .send("Page.getFrameTree")
        .then(({ frameTree }) =>
          session.send("Page.createIsolatedWorld", {
            frameId: frameTree.frame.id,
            worldName: "fidy-accessibility",
          })
        )
        // Playwright installs its application clock in the main world. Axe needs native timers.
        .then(({ executionContextId }) =>
          session
            .send("Runtime.evaluate", {
              contextId: executionContextId,
              expression: `typeof axe === "undefined" ? undefined : (${auditExpression})`,
              awaitPromise: true,
              returnByValue: true,
            })
            .then((evaluated) => {
              if (evaluated.exceptionDetails !== undefined) {
                throw new Error("Accessibility evaluation failed");
              }
              if (evaluated.result.type !== "undefined") return evaluated;
              return session.send("Runtime.evaluate", {
                contextId: executionContextId,
                expression: `${axeSource};${auditExpression}`,
                awaitPromise: true,
                returnByValue: true,
              });
            })
        )
        .then((evaluated) => {
          if (evaluated.exceptionDetails !== undefined) {
            throw new Error("Accessibility evaluation failed");
          }
          return readAccessibilityResult(evaluated.result.value);
        })
        .then(
          (result) => session.detach().then(() => result),
          (cause: unknown) =>
            session.detach().then(() => {
              throw cause;
            })
        )
    );
const analyzeDocument = (page: Page): Promise<AccessibilityResult> =>
  analyzeWithNativeTimers(page).then((result) =>
    hasFrames(page).then((frames) => (frames ? analyzeFrames(page) : result))
  );

/** Avoid the extra result-aggregation page only when the complete document has no frames. */
export const analyzeAccessibility = (page: Page): Promise<AccessibilityResult> =>
  hasFrames(page).then((frames) =>
    frames || page.context().browser()?.browserType().name() !== "chromium"
      ? analyzeFrames(page)
      : analyzeDocument(page)
  );
