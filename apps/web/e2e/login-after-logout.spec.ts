import type { Page, Route } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { signInThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const pendingProvider = (route: Route): Promise<void> =>
  route.fulfill({ contentType: "text/html", body: "<p>Pending provider decision</p>" });
const openProvider = (page: Page, label: string): Promise<Page> =>
  Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: `Continuar con ${label}` }).click(),
  ]).then(([opened]) => opened);
for (const provider of [
  {
    name: "google",
    label: "Google",
    authorization: "https://accounts.google.com/o/oauth2/v2/auth**",
  },
  { name: "microsoft", label: "Microsoft", authorization: "https://login.microsoftonline.com/**" },
]) {
  test(`keeps ${provider.label} login open after logging out of an authenticated document`, ({
    page,
    context,
    request,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => signInThroughCore({ page, request }));
        yield* Effect.tryPromise(() => page.clock.resume());
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Cerrar sesión", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" }).click()
        );
        yield* Effect.tryPromise(() => context.route(provider.authorization, pendingProvider));
        const popup = yield* Effect.tryPromise(() => openProvider(page, provider.label));
        yield* Effect.tryPromise(() =>
          expect(popup.getByText("Pending provider decision")).toBeVisible()
        );
        for (const _ of [0, 1]) {
          yield* Effect.tryPromise(() =>
            page.waitForResponse(`**/web/providers/${provider.name}/status`)
          );
        }
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Cancelaste el acceso.")).toHaveCount(0)
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Esperando confirmación…")).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Cancelar", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Cancelaste el acceso.")).toBeVisible()
        );
      })
    ));
}
