import { type Page, expect, test } from "@playwright/test";
import { type Cause, Effect } from "effect";

const wait = <A>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
const settle = (page: Page): Promise<void> =>
  page.evaluate(() =>
    document.fonts.ready.then(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.timeline instanceof DocumentTimeline)
          .map((animation) => animation.finished)
      ).then(() => undefined)
    )
  );

test("captures matched public-page views without using account data", ({ page }, info) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(
        page.route("**/*", (route) => {
          const url = new URL(route.request().url());
          return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
        })
      );
      yield* wait(page.goto("/"));
      yield* wait(expect(page.locator(".hero")).toBeVisible());
      yield* wait(settle(page));
      yield* wait(page.screenshot({ path: info.outputPath("hero.png") }));
      if (info.project.name.startsWith("after")) {
        expect(
          yield* wait(
            page
              .locator(".hero .actions .btn")
              .evaluate((element) => element.getBoundingClientRect().bottom <= innerHeight)
          )
        ).toBe(true);
        expect(
          yield* wait(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        ).toBe(true);
      }
      yield* wait(page.locator(".footer").scrollIntoViewIfNeeded());
      yield* wait(settle(page));
      yield* wait(page.screenshot({ path: info.outputPath("footer.png") }));
      yield* wait(page.goto("/funciones/agentes"));
      yield* wait(expect(page.locator(".detail-hero")).toBeVisible());
      yield* wait(settle(page));
      yield* wait(page.screenshot({ path: info.outputPath("agents.png") }));
      if (info.project.name.startsWith("after")) {
        yield* wait(page.locator("#conectar").scrollIntoViewIfNeeded());
        yield* wait(settle(page));
        yield* wait(page.screenshot({ path: info.outputPath("connection-guide.png") }));
        yield* wait(page.goto("/terminos"));
        yield* wait(
          expect(
            page.getByRole("heading", { name: "Términos de servicio de Fidy", exact: true })
          ).toBeVisible()
        );
        yield* wait(page.screenshot({ path: info.outputPath("terms-draft.png"), fullPage: true }));
      }
    })
  ));
