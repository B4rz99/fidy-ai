import type { Page } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { signInFirstCardThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

const documentWidth = (page: Page): Promise<number> =>
  page.locator("html").evaluate((element) => element.scrollWidth);
const observeConnectionRequests = (page: Page): ReadonlyArray<string> => {
  const requests: string[] = [];
  page.on("request", (outgoing) => {
    const url = new URL(outgoing.url());
    if (
      url.pathname.startsWith("/web/connections/") ||
      (url.pathname === "/connections" && outgoing.method() === "POST")
    ) {
      requests.push(url.pathname);
    }
  });
  return requests;
};

for (const signedIn of [false, true]) {
  for (const viewport of viewports) {
    test(`recovers from missing and malformed connection links with keyboard access at ${viewport.width}px while ${signedIn ? "signed in" : "signed out"}`, ({
      page,
      request,
    }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.tryPromise(() => page.setViewportSize(viewport));
          if (signedIn) {
            yield* Effect.tryPromise(() =>
              signInFirstCardThroughCore({ page, request, deferFreshEntry: true })
            );
          }
          const authorizationRequests = observeConnectionRequests(page);
          for (const search of [
            "",
            "?attempt=not-a-valid-request&redirect=https://foreign.example",
          ]) {
            yield* Effect.tryPromise(() => page.goto(`/connections/continue${search}`));
            yield* Effect.tryPromise(() =>
              expect(
                page.getByRole("heading", { name: "Este enlace no se puede usar" })
              ).toBeVisible()
            );
            yield* Effect.tryPromise(() =>
              expect(page.getByRole("heading", { name: "Cómo continuar" })).toBeVisible()
            );
            yield* Effect.tryPromise(() =>
              expect(
                page.getByText("Pide un nuevo enlace de conexión.", { exact: true })
              ).toBeVisible()
            );
            const recovery = page.getByRole("link", { name: "Volver a Fidy", exact: true });
            yield* Effect.tryPromise(() =>
              expect(recovery).toHaveAttribute("href", signedIn ? "/app/transactions" : "/login")
            );
            expect(yield* Effect.tryPromise(() => documentWidth(page))).toBe(viewport.width);
            yield* Effect.tryPromise(() => page.keyboard.press("Tab"));
            yield* Effect.tryPromise(() => expect(recovery).toBeFocused());
            yield* Effect.tryPromise(() => page.keyboard.press("Enter"));
            yield* Effect.tryPromise(() =>
              expect(
                page.getByRole("heading", {
                  name: signedIn ? "Transacciones" : "Entra a tu Fidy",
                  exact: true,
                })
              ).toBeVisible()
            );
            expect(authorizationRequests).toEqual([]);
          }
        })
      ));
  }
}
