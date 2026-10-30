import type { Locator, Page, Route } from "@playwright/test";
import { Data, DateTime, Effect } from "effect";
import { apiOrigin, installCategories, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const themes = ["light", "dark"] as const;
type Theme = (typeof themes)[number];
const palette = {
  light: {
    control: "rgb(118, 113, 107)",
    primaryBorder: "rgb(20, 20, 20)",
    focus: "rgb(20, 20, 20)",
    emailForeground: "rgb(0, 0, 0)",
    emailBackground: "rgb(250, 227, 217)",
    warning: "rgb(107, 66, 0)",
    warningBackground: "rgb(255, 240, 209)",
    error: "rgb(159, 39, 35)",
    errorBackground: "rgb(253, 234, 231)",
  },
  dark: {
    control: "rgb(133, 133, 133)",
    primaryBorder: "rgb(136, 204, 32)",
    focus: "rgb(255, 246, 239)",
    emailForeground: "rgb(255, 246, 239)",
    emailBackground: "rgb(46, 46, 46)",
    warning: "rgb(245, 207, 128)",
    warningBackground: "rgb(53, 42, 23)",
    error: "rgb(255, 176, 168)",
    errorBackground: "rgb(59, 35, 35)",
  },
};
const captureDirectory = "test-results/brand-token-captures";
const reviewId = "24000000-0000-4000-8000-000000001554";
const reviewItem = {
  id: reviewId,
  source: "email",
  timeZone: "America/Bogota",
  reason: "ambiguous-currency",
  status: "pending",
  revision: 0,
  createdAt: "2026-10-15T12:00:00Z",
  expiresAt: "2027-01-13T12:00:00Z",
};

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

test.afterEach(({ page }, information) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (information.status === information.expectedStatus) return;
      const name = information.title.replaceAll(/[^a-z0-9-]+/giu, "-");
      yield* Effect.tryPromise((signal) =>
        page.screenshot({
          signal,
          path: `${captureDirectory}/failed-${name}.png`,
          fullPage: true,
          caret: "hide",
        })
      );
    })
  )
);

const prepare = Effect.fnUntraced(function* (page: Page, theme: Theme) {
  yield* Effect.tryPromise(() =>
    page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
  );
  yield* Effect.tryPromise(() =>
    page.clock.setFixedTime(DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-24T12:00:00Z")))
  );
  yield* Effect.tryPromise(() => installUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
});

const capture = Effect.fnUntraced(function* (page: Page, name: string) {
  yield* Effect.tryPromise(() => page.evaluate(() => document.fonts.ready));
  yield* Effect.tryPromise((signal) =>
    page.screenshot({
      signal,
      path: `${captureDirectory}/${name}.png`,
      fullPage: true,
      caret: "hide",
    })
  );
});

type Rgb = Readonly<{ red: number; green: number; blue: number }>;
type Rgba = Rgb & Readonly<{ alpha: number }>;
type RenderedColors = Readonly<{ foreground: Rgb; background: Rgb }>;
type ColorMeasurement =
  | Readonly<{ _tag: "Detached" }>
  | Readonly<{ _tag: "Rendered"; colors: RenderedColors }>;
class DetachedColorTarget extends Data.TaggedError("DetachedColorTarget")<{}> {}
const readColors = (
  element: Element,
  property: "color" | "borderLeftColor" | "outlineColor"
): ColorMeasurement => {
  if (!element.isConnected) return { _tag: "Detached" };
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Color measurement requires a canvas context");
  const maximumChannel = 255;
  const pixel = (color: string): Rgba => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    if (red === undefined || green === undefined || blue === undefined || alpha === undefined) {
      throw new Error("Canvas did not return a complete RGBA pixel");
    }
    return {
      red: red / maximumChannel,
      green: green / maximumChannel,
      blue: blue / maximumChannel,
      alpha: alpha / maximumChannel,
    };
  };
  let background = { red: 1, green: 1, blue: 1 };
  const ancestors: Element[] = [];
  let current = property === "color" ? element : element.parentElement;
  while (current !== null) {
    ancestors.unshift(current);
    current = current.parentElement;
  }
  for (const ancestor of ancestors) {
    const channels = pixel(getComputedStyle(ancestor).backgroundColor);
    const { alpha } = channels;
    background = {
      red: channels.red * alpha + background.red * (1 - alpha),
      green: channels.green * alpha + background.green * (1 - alpha),
      blue: channels.blue * alpha + background.blue * (1 - alpha),
    };
  }
  const { red, green, blue } = pixel(getComputedStyle(element)[property]);
  return { _tag: "Rendered", colors: { foreground: { red, green, blue }, background } };
};
const linearChannel = (channel: number): number => {
  const threshold = 0.04045;
  const linearDivisor = 12.92;
  const offset = 0.055;
  const gammaDivisor = 1.055;
  const gamma = 2.4;
  return channel <= threshold
    ? channel / linearDivisor
    : ((channel + offset) / gammaDivisor) ** gamma;
};
const luminance = (channels: Rgb): number => {
  const redWeight = 0.2126;
  const greenWeight = 0.7152;
  const blueWeight = 0.0722;
  return (
    linearChannel(channels.red) * redWeight +
    linearChannel(channels.green) * greenWeight +
    linearChannel(channels.blue) * blueWeight
  );
};
const contrast = Effect.fnUntraced(function* (
  locator: Locator,
  property: "color" | "borderLeftColor" | "outlineColor",
  minimum: number
) {
  const colors = yield* Effect.tryPromise((signal) =>
    locator.evaluate(readColors, property, { signal })
  ).pipe(
    Effect.flatMap((value) =>
      value._tag === "Detached"
        ? Effect.fail(new DetachedColorTarget())
        : Effect.succeed(value.colors)
    ),
    Effect.retry({ times: 5, while: (error) => error instanceof DetachedColorTarget })
  );
  const foregroundLight = luminance(colors.foreground);
  const backgroundLight = luminance(colors.background);
  const offset = 0.05;
  const ratio =
    (Math.max(foregroundLight, backgroundLight) + offset) /
    (Math.min(foregroundLight, backgroundLight) + offset);
  test.info().annotations.push({
    type: "contrast",
    description: `${locator.toString()}: ${property} ${ratio.toFixed(2)}:1 (minimum ${minimum}:1)`,
  });
  expect(ratio).toBeGreaterThanOrEqual(minimum);
  const maximumChannel = 255;
  return {
    ratio,
    background: `rgb(${Math.round(colors.background.red * maximumChannel)}, ${Math.round(colors.background.green * maximumChannel)}, ${Math.round(colors.background.blue * maximumChannel)})`,
  };
});
const minimumTextContrast = 4.5;
const minimumControlContrast = 3;

type ReviewState = "warning" | "ready" | "error";
const readyDraft = {
  amount: "13500",
  currency: "COP",
  direction: "outflow",
  counterparty: "Compra de ejemplo",
  occurredAt: "2026-10-23T12:00:00Z",
  userProvidedFields: [],
};
const reviewRoute = (route: Route, state: ReviewState): Promise<void> => {
  const path = new URL(route.request().url()).pathname;
  if (route.request().method() !== "GET") return route.abort("blockedbyclient");
  if (path.endsWith("/material")) {
    return route.fulfill({
      json: {
        data: {
          available: true,
          text: "Correo de ejemplo · Compra por COP 13.500",
          truncated: false,
        },
        next: [],
      },
    });
  }
  if (path.endsWith(reviewId)) {
    return state === "error"
      ? route.fulfill({
          status: 503,
          json: { error: { code: "unavailable", message: "Synthetic read failure" } },
        })
      : route.fulfill({
          body: response({
            item: reviewItem,
            revision: 0,
            ...(state === "ready" ? { draft: readyDraft } : {}),
          }),
          contentType: "application/json",
        });
  }
  return route.fulfill({
    body: response({ pendingCount: 1, total: 1, items: [reviewItem] }),
    contentType: "application/json",
  });
};

const checkReviewWarning = Effect.fnUntraced(function* (page: Page, theme: Theme) {
  const colors = palette[theme];
  const panel = page.locator('[data-review="panel"]').filter({ visible: true });
  const icon = panel.locator('[data-review="source-icon"][data-source="email"]');
  yield* Effect.tryPromise((signal) =>
    expect(icon).toHaveCSS("color", colors.emailForeground, { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(icon).toHaveCSS("background-color", colors.emailBackground, { signal })
  );
  yield* contrast(icon, "color", minimumTextContrast);
  const notice = panel.getByRole("alert");
  yield* Effect.tryPromise((signal) =>
    expect(notice).toHaveCSS("color", colors.warning, { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(notice).toHaveCSS("border-left-color", colors.warning, { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(notice).toHaveCSS("background-color", colors.warningBackground, { signal })
  );
  yield* contrast(notice, "color", minimumTextContrast);
  const input = panel.getByLabel("Contraparte (opcional)");
  yield* Effect.tryPromise((signal) =>
    expect(input).toHaveCSS("border-left-color", colors.control, { signal })
  );
  yield* contrast(input, "borderLeftColor", minimumControlContrast);
  const confirm = panel.getByRole("button", { name: "Confirmar", exact: true });
  yield* Effect.tryPromise((signal) => expect(confirm).toBeDisabled({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(confirm).toHaveCSS("border-left-color", colors.control, { signal })
  );
  yield* contrast(confirm, "color", minimumTextContrast);
  yield* capture(page, `review-warning-email-${theme}`);
  yield* Effect.tryPromise((signal) => input.focus({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(input).toHaveCSS("border-left-color", colors.focus, { signal })
  );
  yield* contrast(input, "borderLeftColor", minimumControlContrast);
  yield* capture(page, `review-focus-${theme}`);
});

const checkReviewReady = Effect.fnUntraced(function* (page: Page, theme: Theme) {
  const confirm = page.getByRole("button", { name: "Confirmar", exact: true });
  yield* Effect.tryPromise((signal) => expect(confirm).toBeEnabled({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(confirm).toHaveCSS("border-left-color", palette[theme].primaryBorder, { signal })
  );
  yield* contrast(confirm, "borderLeftColor", minimumControlContrast);
  yield* contrast(confirm, "color", minimumTextContrast);
  yield* capture(page, `review-ready-${theme}`);
  yield* Effect.tryPromise((signal) => confirm.hover({ signal }));
  const hoverBorder = theme === "light" ? "rgb(20, 20, 20)" : "rgb(121, 185, 27)";
  yield* Effect.tryPromise((signal) =>
    expect(confirm).toHaveCSS("border-left-color", hoverBorder, { signal })
  );
  yield* contrast(confirm, "borderLeftColor", minimumControlContrast);
  yield* contrast(confirm, "color", minimumTextContrast);
  yield* capture(page, `review-primary-hover-${theme}`);
});
const checkReview = Effect.fnUntraced(function* (page: Page, theme: Theme) {
  yield* prepare(page, theme);
  let state: ReviewState = "warning";
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/ingestion/review-workspace**`, (route) => reviewRoute(route, state))
  );
  yield* Effect.tryPromise((signal) => page.goto("/app/needs-review", { signal }));
  yield* checkReviewWarning(page, theme);
  state = "ready";
  yield* Effect.tryPromise((signal) => page.reload({ signal }));
  yield* checkReviewReady(page, theme);
  state = "error";
  yield* Effect.tryPromise((signal) => page.reload({ signal }));
  const notice = page.getByRole("alert");
  yield* Effect.tryPromise((signal) =>
    expect(notice).toContainText("No pudimos cargar todos los datos del elemento.", { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(notice).toHaveCSS("color", palette[theme].error, { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(notice).toHaveCSS("border-left-color", palette[theme].error, { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(notice).toHaveCSS("background-color", palette[theme].errorBackground, { signal })
  );
  yield* contrast(notice, "color", minimumTextContrast);
  yield* capture(page, `review-error-${theme}`);
});
for (const theme of themes) {
  test(`Review email, controls and warning/error notices preserve approved contrast in ${theme}`, ({
    page,
  }) => Effect.runPromise(checkReview(page, theme)));
}

const transaction = {
  categoryId: "24000000-0000-4000-8000-000000000301",
  id: "25000000-0000-4000-8000-000000001554",
  money: { amount: "13500", currency: "COP" },
  counterparty: "Compra de ejemplo",
  direction: "outflow",
  occurredAt: "2026-10-23T12:00:00Z",
  createdAt: "2026-10-23T12:00:00Z",
  revision: 1,
};
const checkTransactionToolbar = Effect.fnUntraced(function* (page: Page, theme: Theme) {
  const colors = palette[theme];
  const search = page.getByRole("searchbox", { name: "Buscar transacciones" });
  const filters = page.getByRole("button", { name: "Filtros", exact: true });
  yield* Effect.tryPromise((signal) =>
    expect(search).toHaveCSS("border-left-color", colors.control, { signal })
  );
  yield* contrast(search, "borderLeftColor", minimumControlContrast);
  yield* Effect.tryPromise((signal) =>
    expect(filters).toHaveCSS("border-left-color", colors.control, { signal })
  );
  yield* contrast(filters, "borderLeftColor", minimumControlContrast);
  yield* capture(page, `transactions-default-${theme}`);
  yield* Effect.tryPromise((signal) => filters.hover({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(filters).toHaveCSS("border-left-color", colors.control, { signal })
  );
  yield* contrast(filters, "color", minimumTextContrast);
  yield* contrast(filters, "borderLeftColor", minimumControlContrast);
  yield* capture(page, `transactions-hover-${theme}`);
  yield* Effect.tryPromise((signal) => search.focus({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(search).toHaveCSS("border-left-color", colors.focus, { signal })
  );
  yield* contrast(search, "borderLeftColor", minimumControlContrast);
  yield* capture(page, `transactions-focus-${theme}`);
});
const checkTransactionForm = Effect.fnUntraced(function* (page: Page, theme: Theme) {
  const colors = palette[theme];
  yield* Effect.tryPromise((signal) =>
    page.getByRole("button", { name: "+ Registrar", exact: true }).click({ signal })
  );
  const amount = page.getByLabel("Monto · COP", { exact: true });
  const notes = page.getByLabel("Notas (opcional)", { exact: true });
  const category = page.getByRole("button", {
    name: "Categoría: Asignar automáticamente",
    exact: true,
  });
  const submit = page.getByRole("button", { name: "Registrar", exact: true });
  yield* Effect.tryPromise((signal) =>
    page.getByRole("heading", { name: "Registrar transacción", exact: true }).click({ signal })
  );
  for (const input of [amount, notes, category]) {
    yield* Effect.tryPromise((signal) =>
      expect(input).toHaveCSS("border-left-color", colors.control, { signal })
    );
    yield* contrast(input, "borderLeftColor", minimumControlContrast);
  }
  yield* Effect.tryPromise((signal) =>
    expect(submit).toHaveCSS("border-left-color", colors.primaryBorder, { signal })
  );
  yield* contrast(submit, "color", minimumTextContrast);
  yield* contrast(submit, "borderLeftColor", minimumControlContrast);
  const selected = page.getByRole("button", { name: "Gasto", exact: true });
  yield* Effect.tryPromise((signal) =>
    expect(selected).toHaveAttribute("aria-pressed", "true", { signal })
  );
  yield* contrast(selected, "color", minimumTextContrast);
  yield* capture(page, `transactions-form-selected-${theme}`);
  yield* Effect.tryPromise((signal) => notes.focus({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(notes).toHaveCSS("outline-color", colors.focus, { signal })
  );
  yield* Effect.tryPromise((signal) => expect(notes).toHaveCSS("outline-width", "2px", { signal }));
  yield* Effect.tryPromise((signal) =>
    expect(notes).toHaveCSS("outline-style", "solid", { signal })
  );
  yield* contrast(notes, "outlineColor", minimumControlContrast);
  yield* capture(page, `transactions-notes-focus-${theme}`);
  yield* Effect.tryPromise((signal) => amount.fill("13500", { signal }));
  yield* Effect.tryPromise((signal) => submit.click({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("alert")).toContainText("No pudimos confirmar el registro", { signal })
  );
  for (const input of [amount, notes, category, submit]) {
    yield* Effect.tryPromise((signal) => expect(input).toBeDisabled({ signal }));
    yield* Effect.tryPromise((signal) =>
      expect(input).toHaveCSS("border-left-color", colors.control, { signal })
    );
  }
  yield* contrast(submit, "color", minimumTextContrast);
  yield* capture(page, `transactions-disabled-${theme}`);
});
const checkTransactions = Effect.fnUntraced(function* (page: Page, theme: Theme) {
  yield* prepare(page, theme);
  yield* Effect.tryPromise(() =>
    installCategories({ page, categories: [{ id: transaction.categoryId, label: "Vivienda" }] })
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/web/session/binding`, (route) =>
      route.fulfill({ json: { binding: null } })
    )
  );
  let mutations = 0;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/transactions**`, (route) => {
      if (route.request().method() !== "GET") {
        mutations += 1;
        return route.abort("failed");
      }
      return route.fulfill({ contentType: "application/json", body: response([transaction]) });
    })
  );
  yield* Effect.tryPromise((signal) => page.goto("/app/transactions", { signal }));
  yield* checkTransactionToolbar(page, theme);
  yield* checkTransactionForm(page, theme);
  expect(mutations).toBe(1);
});
for (const theme of themes) {
  test(`Transaction controls remain distinguishable through default, hover, focus, selected and disabled states in ${theme}`, ({
    page,
  }) => Effect.runPromise(checkTransactions(page, theme)));
}

const categoryId = "24000000-0000-4000-8000-000000000301";
const budgetPeriod = {
  from: "2026-10-01T05:00:00Z",
  to: "2026-11-01T05:00:00Z",
  timeZone: "America/Bogota",
};
const budget = {
  id: "24000000-0000-4000-8000-000000000311",
  categoryId,
  cap: { amount: "100000", currency: "COP" },
  groupName: "Hogar",
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
};
const budgetReport = {
  budgets: [budget],
  period: budgetPeriod,
  initialized: true,
  cashFlow: {
    income: [{ amount: "50000", currency: "COP" }],
    expenses: [{ amount: "130000", currency: "COP" }],
  },
  statuses: [
    {
      budget,
      spent: { amount: "130000", currency: "COP" },
      period: budgetPeriod,
      type: "over",
      overBy: { amount: "30000", currency: "COP" },
    },
  ],
};
const checkBudget = Effect.fnUntraced(function* (page: Page, theme: Theme) {
  yield* prepare(page, theme);
  yield* Effect.tryPromise(() =>
    installCategories({ page, categories: [{ id: categoryId, label: "Vivienda" }] })
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budget-status?**`, (route) =>
      route.fulfill({ contentType: "application/json", body: response(budgetReport) })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budgets`, (route) =>
      route.fulfill({ contentType: "application/json", body: response([budget]) })
    )
  );
  yield* Effect.tryPromise((signal) => page.goto("/app/budgets?month=2026-10", { signal }));
  const summary = page.getByRole("region", { name: "Resumen COP", exact: true });
  const exceeded = summary.getByText(/excedido/u);
  const negative = summary.getByText("El plan supera los ingresos recibidos", { exact: true });
  yield* Effect.tryPromise((signal) =>
    expect(exceeded).toHaveCSS("color", palette[theme].error, { signal })
  );
  yield* contrast(exceeded, "color", minimumTextContrast);
  yield* Effect.tryPromise((signal) =>
    expect(negative).toHaveCSS("color", palette[theme].error, { signal })
  );
  const treatment = yield* contrast(negative, "color", minimumTextContrast);
  expect(treatment.background).toBe(palette[theme].errorBackground);
  yield* capture(page, `budget-exceeded-negative-${theme}`);
});
for (const theme of themes) {
  test(`Exceeded Budget text and negative allocation use readable semantic pairs in ${theme}`, ({
    page,
  }) => Effect.runPromise(checkBudget(page, theme)));
}

const checkAccessMethods = Effect.fnUntraced(function* (page: Page, theme: Theme) {
  const provider = page.getByRole("button", { name: "Continuar con Google", exact: true });
  const alternative = page.getByRole("button", { name: "Correo verificado", exact: true });
  for (const button of [provider, alternative]) {
    yield* Effect.tryPromise((signal) =>
      expect(button).toHaveCSS("border-left-color", palette[theme].control, { signal })
    );
    yield* contrast(button, "borderLeftColor", minimumControlContrast);
    yield* contrast(button, "color", minimumTextContrast);
  }
  yield* capture(page, `access-active-default-${theme}`);
  yield* Effect.tryPromise((signal) => provider.hover({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(provider).toHaveCSS("border-left-color", palette[theme].control, { signal })
  );
  yield* contrast(provider, "borderLeftColor", minimumControlContrast);
  yield* Effect.tryPromise((signal) => provider.focus({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(provider).toHaveCSS("outline-color", palette[theme].focus, { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(provider).toHaveCSS("outline-width", "2px", { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(provider).toHaveCSS("outline-style", "solid", { signal })
  );
  yield* contrast(provider, "outlineColor", minimumControlContrast);
  yield* capture(page, `access-provider-focus-hover-${theme}`);
  yield* Effect.tryPromise((signal) => alternative.click({ signal }));
  const input = page.getByLabel("Correo verificado", { exact: true });
  yield* Effect.tryPromise((signal) =>
    expect(input).toHaveCSS("border-left-color", palette[theme].control, { signal })
  );
  yield* contrast(input, "borderLeftColor", minimumControlContrast);
  yield* capture(page, `access-input-default-${theme}`);
  yield* Effect.tryPromise((signal) => input.focus({ signal }));
  const shadow = yield* Effect.tryPromise((signal) =>
    input.evaluate((element) => getComputedStyle(element).boxShadow, undefined, { signal })
  );
  expect(shadow).toContain(palette[theme].focus);
  yield* capture(page, `access-input-focus-${theme}`);
});
const checkSignupBorders = Effect.fnUntraced(function* (page: Page, theme: Theme) {
  yield* Effect.tryPromise((signal) =>
    page
      .getByRole("button", { name: "Opciones de inicio de sesión", exact: true })
      .click({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    page.getByRole("button", { name: "Crea tu cuenta", exact: true }).click({ signal })
  );
  const acceptance = page.getByRole("checkbox", {
    name: "Acepto el tratamiento de datos descrito en la Política de privacidad.",
    exact: true,
  });
  const provider = page.getByRole("button", { name: "Continuar con Google", exact: true });
  yield* Effect.tryPromise((signal) => expect(acceptance).toBeEnabled({ signal }));
  yield* Effect.tryPromise((signal) => expect(provider).toBeDisabled({ signal }));
  const subduedBorder = theme === "light" ? "rgb(192, 183, 174)" : "rgb(91, 91, 85)";
  yield* Effect.tryPromise((signal) =>
    expect(provider).toHaveCSS("border-left-color", subduedBorder, { signal })
  );
  yield* Effect.tryPromise((signal) => expect(provider).toHaveCSS("opacity", "0.58", { signal }));
  yield* capture(page, `access-signup-disabled-preserved-${theme}`);
  yield* Effect.tryPromise((signal) => acceptance.check({ signal }));
  yield* Effect.tryPromise((signal) => expect(provider).toBeEnabled({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(provider).toHaveCSS("border-left-color", palette[theme].control, { signal })
  );
  yield* contrast(provider, "borderLeftColor", minimumControlContrast);
  yield* capture(page, `access-signup-active-${theme}`);
  yield* Effect.tryPromise((signal) => acceptance.uncheck({ signal }));
  yield* Effect.tryPromise((signal) => expect(provider).toBeDisabled({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(provider).toHaveCSS("border-left-color", subduedBorder, { signal })
  );
});
const checkAccess = Effect.fnUntraced(function* (page: Page, theme: Theme) {
  yield* Effect.tryPromise(() =>
    page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
  );
  let mutations = 0;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/**`, (route) => {
      if (route.request().method() === "GET") return route.fallback();
      mutations += 1;
      return route.abort("blockedbyclient");
    })
  );
  yield* Effect.tryPromise((signal) => page.goto("/login", { signal }));
  yield* checkAccessMethods(page, theme);
  yield* checkSignupBorders(page, theme);
  expect(mutations).toBe(0);
});
for (const theme of themes) {
  test(`Active Access control borders are distinguishable without changing focus or the disabled signup treatment in ${theme}`, ({
    page,
  }) => Effect.runPromise(checkAccess(page, theme)));
}

const dashboardView = {
  title: "Tablero de ejemplo",
  context: {
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
    calculatedAt: "2026-10-24T12:00:00Z",
  },
  layout: {
    kind: "leaf",
    widget: {
      widget: {
        id: "24000000-0000-4000-8000-000000001554",
        type: "transaction-list",
        title: "Transacciones de ejemplo",
        limit: 10,
      },
      result: { transactions: [] },
    },
  },
};
const checkDashboard = Effect.fnUntraced(function* (page: Page, theme: Theme) {
  yield* prepare(page, theme);
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/view`, (route) =>
      route.fulfill({ contentType: "application/json", body: response(dashboardView) })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/catalog`, (route) =>
      route.fulfill({ contentType: "application/json", body: response([]) })
    )
  );
  yield* Effect.tryPromise((signal) => page.goto("/app/dashboard", { signal }));
  const personalize = page.getByRole("button", { name: "Personalizar", exact: true });
  yield* Effect.tryPromise((signal) =>
    expect(personalize).toHaveCSS("border-left-color", palette[theme].control, { signal })
  );
  yield* contrast(personalize, "borderLeftColor", minimumControlContrast);
  yield* capture(page, `dashboard-personalize-default-${theme}`);
  yield* Effect.tryPromise((signal) => personalize.hover({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(personalize).toHaveCSS("border-left-color", palette[theme].control, { signal })
  );
  yield* contrast(personalize, "color", minimumTextContrast);
  yield* Effect.tryPromise((signal) => personalize.focus({ signal }));
  yield* Effect.tryPromise((signal) =>
    expect(personalize).toHaveCSS("outline-color", palette[theme].focus, { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(personalize).toHaveCSS("outline-width", "2px", { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(personalize).toHaveCSS("outline-style", "solid", { signal })
  );
  yield* contrast(personalize, "outlineColor", minimumControlContrast);
  yield* capture(page, `dashboard-personalize-focus-hover-${theme}`);
});
for (const theme of themes) {
  test(`Dashboard Personalizar retains its accessible control border and focus in ${theme}`, ({
    page,
  }) => Effect.runPromise(checkDashboard(page, theme)));
}
