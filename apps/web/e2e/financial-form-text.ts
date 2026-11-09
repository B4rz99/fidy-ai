import type { Locator } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";

const { expect } = playwright;
const wait = Effect.tryPromise;

export const expectFinancialLabels = Effect.fn(function* (form: Locator, size: string) {
  const labels = form.locator("label[for]");
  yield* wait(() => expect(labels.first()).toBeVisible());
  for (const label of yield* wait(() => labels.all())) {
    yield* wait(() => expect(label).toHaveCSS("font-size", size));
    const layout = yield* wait(() =>
      label.evaluate((element) => {
        const control = document.getElementById(element.getAttribute("for") ?? "");
        const text = document.createRange();
        text.selectNodeContents(element);
        const bounds = text.getBoundingClientRect();
        const labelBounds = element.getBoundingClientRect();
        return {
          associated: control !== null,
          inside: bounds.left >= 0 && bounds.right <= window.innerWidth,
          contained: bounds.bottom <= labelBounds.bottom + 1,
          separated: control !== null && labelBounds.bottom <= control.getBoundingClientRect().top,
        };
      })
    );
    expect(layout).toEqual({ associated: true, inside: true, contained: true, separated: true });
  }
});
