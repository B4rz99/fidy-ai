import { Effect } from "effect";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;

test("offers document reload after invalid route input without exposing its diagnostic value", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const privateValue = "private-request-credential-sentinel";
      yield* Effect.tryPromise(() =>
        page.goto(`/connect/cli?cliCode=${encodeURIComponent(privateValue)}`)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText(
          "No pudimos cargar esta página. Recarga para volver a intentarlo."
        )
      );
      yield* Effect.tryPromise(() => expect(page.locator("body")).not.toContainText(privateValue));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: /show error/i })).toHaveCount(0)
      );
      const reload = page.waitForRequest(
        (request) => request.isNavigationRequest() && request.frame() === page.mainFrame()
      );
      const reloadedDocument = page.waitForEvent("domcontentloaded");
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Recargar página" }).click());
      yield* Effect.tryPromise(() => reload);
      yield* Effect.tryPromise(() => reloadedDocument);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos cargar esta página")
      );
      yield* Effect.tryPromise(() => expect(page.locator("body")).not.toContainText(privateValue));
    })
  ));
