import type { APIRequestContext, Locator, Page, Route } from "@playwright/test";
import { Effect, Option } from "effect";
import { playwright } from "./playwright-runtime";
import { signInDashboardThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
const successStatus = 200;
const resourceLimitedStatus = 429;
const noContentStatus = 204;
const widgetCountWithAddition = 5;
const mobileViewport = { width: 390, height: 844 };

const openDashboard = Effect.fnUntraced(function* ({
  page,
  request,
}: Readonly<{ page: Page; request: APIRequestContext }>) {
  const reset = yield* Effect.tryPromise(() =>
    request.post("http://127.0.0.1:4175/dashboard/reset?dashboard=true")
  );
  expect(reset.status()).toBe(noContentStatus);
  yield* Effect.tryPromise(() => signInDashboardThroughCore({ page, request }));
  yield* Effect.tryPromise(() => page.clock.resume());
  yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
});

const loseAcknowledgment = Effect.fnUntraced(function* (
  route: Route,
  committedWrites: Array<string>
) {
  const committed = yield* Effect.tryPromise(() => route.fetch({ maxRetries: 0 }));
  if (committed.status() === resourceLimitedStatus) {
    return yield* Effect.tryPromise(() => route.fulfill({ response: committed }));
  }
  expect(committed.status()).toBe(successStatus);
  committedWrites.push(route.request().method());
  yield* Effect.tryPromise(() => route.abort("failed"));
});

const readDimensions = (): Readonly<{ viewport: number; content: number }> => ({
  viewport: document.documentElement.clientWidth,
  content: document.documentElement.scrollWidth,
});

const loseEditResponse = Effect.fnUntraced(function* (page: Page, committedWrites: Array<string>) {
  const runWithServices = Effect.runPromiseWith(yield* Effect.context<never>());
  yield* Effect.tryPromise(() =>
    page.route("**/dashboard/edits", (route) =>
      runWithServices(loseAcknowledgment(route, committedWrites))
    )
  );
});

test("Dashboard mobile view stacks all Widgets without horizontal overflow", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.setViewportSize(mobileViewport));
      yield* openDashboard({ page, request });
      const titles = [
        "Gastos por categoría",
        "Presupuesto de restaurantes",
        "Transacciones recientes",
        "Salidas del mes",
      ];
      let previousBottom = 0;
      for (const title of titles) {
        const heading = page.getByRole("heading", { name: title, exact: true });
        yield* Effect.tryPromise(() => expect(heading).toBeVisible());
        const bounds = yield* Effect.fromOption(
          Option.fromNullOr(yield* Effect.tryPromise(() => heading.boundingBox()))
        );
        expect(bounds.y).toBeGreaterThanOrEqual(previousBottom);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(mobileViewport.width);
        previousBottom = bounds.y + bounds.height;
      }
      const dimensions = yield* Effect.tryPromise(() => page.evaluate(readDimensions));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
    })
  ));

test("Dashboard refresh resolves a committed edit with a lost acknowledgment without replay", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* openDashboard({ page, request });
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Personalizar" }).click());
      const committedWrites: Array<string> = [];
      yield* loseEditResponse(page, committedWrites);
      yield* Effect.tryPromise(() =>
        page
          .getByRole("button", { name: /^Renombrar /u })
          .first()
          .click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Nuevo nombre del Widget").fill("Cambio confirmado al leer")
      );
      yield* Effect.tryPromise(() => page.getByLabel("Guardar nombre del Widget").click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar el cambio")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar tablero", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Cambio confirmado al leer" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Cambio confirmado al leer" })).toBeVisible()
      );
      expect(committedWrites).toEqual(["POST"]);
    })
  ));

const dragWidget = Effect.fnUntraced(function* ({
  page,
  source,
  destination,
  announcement,
}: Readonly<{ page: Page; source: Locator; destination: Locator; announcement: string }>) {
  yield* Effect.tryPromise(() => source.scrollIntoViewIfNeeded());
  const sourceBox = yield* Effect.fromOption(
    Option.fromNullOr(yield* Effect.tryPromise(() => source.boundingBox()))
  );
  yield* Effect.tryPromise(() =>
    page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  );
  yield* Effect.tryPromise(() => page.mouse.down());
  yield* Effect.tryPromise(() => expect(source).toHaveAttribute("aria-pressed", "true"));
  yield* Effect.tryPromise(() => destination.scrollIntoViewIfNeeded());
  const destinationBox = yield* Effect.fromOption(
    Option.fromNullOr(yield* Effect.tryPromise(() => destination.boundingBox()))
  );
  yield* Effect.tryPromise(() =>
    page.mouse.move(
      destinationBox.x + destinationBox.width / 2,
      destinationBox.y + destinationBox.height / 2,
      { steps: 10 }
    )
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("status").filter({ hasText: announcement })).toBeVisible()
  );
  const preview = page.getByLabel("Vista previa de la distribución", { exact: true });
  yield* Effect.tryPromise(() => expect(preview).toBeVisible());
  const expectedGeometry = yield* Effect.tryPromise(() => preview.evaluate(widgetGeometry));
  yield* Effect.tryPromise(() => page.mouse.up());
  yield* Effect.tryPromise(() => expect(preview).toHaveCount(0));
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: /^Arrastrar /u }).last()).toBeEnabled()
  );
  const canvas = page.getByLabel("Diseño responsivo del tablero", { exact: true });
  const actualGeometry = yield* Effect.tryPromise(() => canvas.evaluate(widgetGeometry));
  expect(actualGeometry.map(({ title }) => title)).toEqual(
    expectedGeometry.map(({ title }) => title)
  );
  for (const [index, actual] of actualGeometry.entries()) {
    const expected = expectedGeometry[index];
    if (expected === undefined) throw new Error("Missing preview Widget");
    expect(actual.x).toBeCloseTo(expected.x, 0);
    expect(actual.y).toBeCloseTo(expected.y, 0);
    expect(actual.width).toBeCloseTo(expected.width, 0);
    expect(actual.height).toBeCloseTo(expected.height, 0);
  }
});

const widgetGeometry = (
  element: Element
): ReadonlyArray<
  Readonly<{ title: string; x: number; y: number; width: number; height: number }>
> => {
  const origin = element.getBoundingClientRect();
  return Array.from(element.querySelectorAll("h2"), (heading) => {
    const bounds = heading.getBoundingClientRect();
    return {
      title: heading.textContent,
      x: bounds.x - origin.x,
      y: bounds.y - origin.y,
      width: bounds.width,
      height: bounds.height,
    };
  });
};

test("Dashboard keyboard resize survives a real Core reload", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* openDashboard({ page, request });
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Personalizar" }).click());
      const boundary = page.getByRole("separator").first();
      yield* Effect.tryPromise(() => boundary.press("ArrowRight"));
      yield* Effect.tryPromise(() => expect(boundary).toHaveAttribute("aria-valuenow", "1.1"));
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Personalizar" }).click());
      yield* Effect.tryPromise(() => expect(boundary).toHaveAttribute("aria-valuenow", "1.1"));
    })
  ));

test("Dashboard keyboard cancellation preserves the document and catalog drag adds a persistent Widget", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* openDashboard({ page, request });
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Personalizar" }).click());
      const edits: Array<string> = [];
      page.on("request", (call) => {
        if (new URL(call.url()).pathname === "/dashboard/edits") edits.push(call.method());
      });
      const handle = page.getByRole("button", {
        name: "Arrastrar Gastos por categoría",
        exact: true,
      });
      yield* Effect.tryPromise(() => handle.press("Space"));
      yield* Effect.tryPromise(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
      yield* Effect.tryPromise(() => handle.press("ArrowRight"));
      yield* Effect.tryPromise(() => handle.press("Escape"));
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Vista previa de la distribución", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Personalizar" }).click());
      expect(edits).toEqual([]);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { level: 2 })).toHaveText([
          "Widgets disponibles",
          "Gastos por categoría",
          "Presupuesto de restaurantes",
          "Transacciones recientes",
          "Salidas del mes",
        ])
      );
      const catalogHandle = page
        .getByRole("list", { name: "Widgets disponibles para arrastrar" })
        .getByRole("button", { name: "Arrastrar Transacciones recientes", exact: true });
      yield* dragWidget({
        page,
        source: catalogHandle,
        destination: page.getByLabel("Colocar sobre Gastos por categoría", { exact: true }),
        announcement: "Colocar sobre Gastos por categoría",
      });
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Transacciones recientes", exact: true })
        ).toHaveCount(2)
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Transacciones recientes", exact: true })
        ).toHaveCount(2)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { level: 2 })).toHaveCount(widgetCountWithAddition)
      );
    })
  ));

test("Dashboard pointer swaps and edge moves persist without losing Widgets", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* openDashboard({ page, request });
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Personalizar" }).click());
      yield* dragWidget({
        page,
        source: page.getByRole("button", { name: "Arrastrar Gastos por categoría", exact: true }),
        destination: page.getByLabel("Colocar sobre Presupuesto de restaurantes", { exact: true }),
        announcement: "Colocar sobre Presupuesto de restaurantes",
      });
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { level: 2 }).nth(1)).toHaveText(
          "Presupuesto de restaurantes"
        )
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { level: 2 }).first()).toHaveText(
          "Presupuesto de restaurantes"
        )
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Personalizar" }).click());
      yield* dragWidget({
        page,
        source: page.getByRole("button", { name: "Arrastrar Salidas del mes", exact: true }).last(),
        destination: page.getByLabel("Colocar arriba de Presupuesto de restaurantes", {
          exact: true,
        }),
        announcement: "Colocar arriba de Presupuesto de restaurantes",
      });
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { level: 2 }).nth(1)).toHaveText("Salidas del mes")
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { level: 2 })).toHaveText([
          "Salidas del mes",
          "Presupuesto de restaurantes",
          "Gastos por categoría",
          "Transacciones recientes",
        ])
      );
    })
  ));
