import type { Page, Route } from "@playwright/test";
import { type Cause, Effect } from "effect";
import { apiOrigin } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { signInRecurringThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
const nonceHexLength = 64;
const turnId = "20000000-0000-4000-8000-000000000991";
const reply = (route: Route, body: unknown): Promise<void> =>
  route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(body) });
const acknowledge = (route: Route): Promise<void> =>
  route.fulfill({ status: 200, contentType: "application/json", body: '{"status":"completed"}' });
const openAndSend = (page: Page, text: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Abrir agente Fidy", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.getByLabel("Mensaje", { exact: true }).fill(text));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Enviar", exact: true }).click()
      );
    })
  );

type Requests = unknown[];
type Response = (route: Route, count: number) => Promise<void>;
const recordRequests =
  (requests: Requests, respond: Response) =>
  (route: Route): Promise<void> => {
    requests.push(route.request().postDataJSON());
    return respond(route, requests.length);
  };
const unavailable = (route: Route): Promise<void> =>
  route.fulfill({
    status: 503,
    contentType: "application/json",
    body: '{"status":"unavailable"}',
  });
const recoveredReply = (route: Route): Promise<void> =>
  reply(route, {
    turnId,
    receipt: "a".repeat(nonceHexLength),
    text: "Consulta recuperada",
  });
const recoverProgress: Response = (route, count) =>
  count === 1 ? unavailable(route) : recoveredReply(route);
const recoverDelivery: Response = (route, count) =>
  count === 1 ? unavailable(route) : acknowledge(route);
const processingReply = (route: Route): Promise<void> =>
  reply(route, { status: "processing", turnId });
const holdRoute =
  (pending: ReturnType<typeof Promise.withResolvers<Route>>) =>
  (route: Route): void =>
    pending.resolve(route);

test("replacing authentication discards the old tab's retained chat draft", ({
  page,
  request,
  context,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page, request, identity: "recurringChat" })
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Abrir agente Fidy" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Mensaje", { exact: true }).fill("Borrador privado anterior")
      );
      const other = yield* Effect.tryPromise(() => context.newPage());
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page: other, request, identity: "recurringChat" })
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No pudimos autorizar esta acción.")).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Mensaje", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Abrir agente Fidy" })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        other.getByRole("button", { name: "Abrir agente Fidy" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(other.getByLabel("Mensaje", { exact: true })).toHaveValue("")
      );
      yield* Effect.tryPromise(() =>
        expect(other.getByRole("heading", { name: "¿En qué te ayudo?", exact: true })).toBeVisible()
      );
    })
  ));

type Failure = Readonly<{ status: number; code: string; feedback: string }>;
const failureThenReplies =
  (failure: Failure): Response =>
  (route, count) =>
    count === 1
      ? route.fulfill({
          status: failure.status,
          contentType: "application/json",
          body: JSON.stringify({ status: failure.code }),
        })
      : reply(route, {
          text: `Respuesta ${count - 1}`,
          turnId: `20000000-0000-4000-8000-${count === 2 ? "000000000002" : "000000000003"}`,
          receipt: "a".repeat(nonceHexLength),
        });

const discardAtPrivacy = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cerrar chat" }).click());
    yield* Effect.tryPromise(() =>
      page
        .getByRole("navigation", { name: "Aplicación" })
        .getByText("Ajustes", { exact: true })
        .click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("link", { name: "Privacidad", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Abrir agente Fidy" })).toHaveCount(0)
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("link", { name: "Presupuestos", exact: true }).click()
    );
    yield* Effect.tryPromise(() => page.getByRole("button", { name: "Abrir agente Fidy" }).click());
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("heading", { name: "¿En qué te ayudo?", exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Mensaje", { exact: true })).toHaveValue("")
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Respuesta recibida con el chat cerrado", { exact: true })).toHaveCount(
        0
      )
    );
  });

test("a reply received with chat closed is acknowledged only after it becomes visible", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page, request, identity: "recurringChat" })
      );
      const pending = Promise.withResolvers<Route>();
      const receipts: unknown[] = [];
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/web/hosted-turns`, holdRoute(pending))
      );
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/web/hosted-turns/delivery`, recordRequests(receipts, acknowledge))
      );
      yield* Effect.tryPromise(() => openAndSend(page, "Consulta mientras cierro el chat"));
      const route = yield* Effect.tryPromise(() => pending.promise);
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cerrar chat" }).click());
      yield* Effect.tryPromise(() =>
        reply(route, {
          turnId,
          receipt: "a".repeat(nonceHexLength),
          text: "Respuesta recibida con el chat cerrado",
        })
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Presupuestos", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Presupuestos", exact: true })).toBeVisible()
      );
      expect(receipts).toEqual([]);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Abrir agente Fidy" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("Respuesta recibida con el chat cerrado", { exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Mensaje", { exact: true })).toBeEnabled()
      );
      expect(receipts).toEqual([{ turnId, receipt: "a".repeat(nonceHexLength) }]);
      yield* discardAtPrivacy(page);
    })
  ));

const retryAndContinue = (page: Page, draft: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const history = page.getByRole("log", { name: "Conversación con Fidy" });
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Enviar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Respuesta 1", { exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() => expect(page.getByLabel("Mensaje")).toBeEnabled());
    yield* Effect.tryPromise(() => expect(page.getByLabel("Mensaje")).toHaveValue(""));
    yield* Effect.tryPromise(() =>
      expect(history.getByText(draft, { exact: true })).toHaveCount(1)
    );
    yield* Effect.tryPromise(() => page.getByLabel("Mensaje").fill("Gracias"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Enviar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Respuesta 2", { exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() => expect(page.getByLabel("Mensaje")).toBeEnabled());
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Respuesta 1", { exact: true })).toHaveCount(1)
    );
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("button", { name: /Confirmar cambio|Reintentar conexión/u })
      ).toHaveCount(0)
    );
  });

for (const failure of [
  { status: 503, code: "unavailable", feedback: "No se pudo completar el turno." },
  {
    status: 429,
    code: "provider_quota_exceeded",
    feedback: "El agente alcanzó su límite diario.",
  },
] as const) {
  test(`chat retains its ${failure.code} draft across navigation and retries only explicitly`, ({
    page,
    request,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          signInRecurringThroughCore({ page, request, identity: "recurringChat" })
        );
        const draft = "Consulta mi plan de prueba sin modificarlo";
        const history = page.getByRole("log", { name: "Conversación con Fidy" });
        const submissions: unknown[] = [];
        const receipts: unknown[] = [];
        const handler = recordRequests(submissions, failureThenReplies(failure));
        yield* Effect.tryPromise(() => page.route(`${apiOrigin}/web/hosted-turns`, handler));
        yield* Effect.tryPromise(() =>
          page.route(
            `${apiOrigin}/web/hosted-turns/delivery`,
            recordRequests(receipts, acknowledge)
          )
        );
        yield* Effect.tryPromise(() => openAndSend(page, draft));
        yield* Effect.tryPromise(() =>
          expect(page.getByText(failure.feedback, { exact: false })).toBeVisible()
        );
        yield* Effect.tryPromise(() => expect(page.getByLabel("Mensaje")).toHaveValue(draft));
        yield* Effect.tryPromise(() => expect(page.getByLabel("Mensaje")).toBeEnabled());
        yield* Effect.tryPromise(() =>
          expect(history.getByText(draft, { exact: true })).toHaveCount(0)
        );
        expect(submissions).toEqual([{ text: draft }]);
        expect(receipts).toEqual([]);
        yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cerrar chat" }).click());
        yield* Effect.tryPromise(() =>
          page.getByRole("link", { name: "Presupuestos", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("heading", { name: "Presupuestos", exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Abrir agente Fidy", exact: true }).click()
        );
        yield* Effect.tryPromise(() => expect(page.getByLabel("Mensaje")).toHaveValue(draft));
        expect(submissions).toEqual([{ text: draft }]);
        yield* retryAndContinue(page, draft);
        expect(submissions).toEqual([{ text: draft }, { text: draft }, { text: "Gracias" }]);
        expect(receipts).toHaveLength(2);
      })
    ));
}

const installRecovery = (
  page: Page,
  {
    submissions,
    progress,
    receipts,
  }: Readonly<{ submissions: Requests; progress: Requests; receipts: Requests }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/web/hosted-turns`, recordRequests(submissions, processingReply))
    );
    yield* Effect.tryPromise(() =>
      page.route(
        `${apiOrigin}/web/hosted-turns/progress`,
        recordRequests(progress, recoverProgress)
      )
    );
    yield* Effect.tryPromise(() =>
      page.route(
        `${apiOrigin}/web/hosted-turns/delivery`,
        recordRequests(receipts, recoverDelivery)
      )
    );
  });

test("uncertain chat progress and failed delivery recover without replaying the message", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page, request, identity: "recurringChat" })
      );
      const submissions: unknown[] = [];
      const progress: unknown[] = [];
      const receipts: unknown[] = [];
      yield* installRecovery(page, { submissions, progress, receipts });
      yield* Effect.tryPromise(() => openAndSend(page, "Consulta sin cambios"));
      const composer = page.getByLabel("Mensaje", { exact: true });
      const check = page.getByRole("button", { name: "Consultar estado", exact: true });
      yield* Effect.tryPromise(() => expect(check).toBeVisible());
      yield* Effect.tryPromise(() => expect(composer).toBeDisabled());
      expect(progress).toEqual([]);
      yield* Effect.tryPromise(() => check.click());
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No se pudo recuperar el turno.", { exact: false })).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(composer).toBeDisabled());
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cerrar chat" }).click());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Abrir agente Fidy" }).click()
      );
      expect(progress).toEqual([{ turnId }]);
      expect(submissions).toEqual([{ text: "Consulta sin cambios" }]);
      yield* Effect.tryPromise(() => check.click());
      const retry = page.getByRole("button", { name: "Reintentar conexión", exact: true });
      yield* Effect.tryPromise(() => expect(retry).toBeVisible());
      yield* Effect.tryPromise(() => expect(composer).toBeDisabled());
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Consulta recuperada", { exact: true })).toHaveCount(1)
      );
      yield* Effect.tryPromise(() => retry.click());
      yield* Effect.tryPromise(() => expect(composer).toBeEnabled());
      yield* Effect.tryPromise(() => expect(retry).toHaveCount(0));
      yield* Effect.tryPromise(() => expect(check).toHaveCount(0));
      expect(submissions).toEqual([{ text: "Consulta sin cambios" }]);
      expect(progress).toEqual([{ turnId }, { turnId }]);
      expect(receipts).toEqual([
        { turnId, receipt: "a".repeat(nonceHexLength) },
        { turnId, receipt: "a".repeat(nonceHexLength) },
      ]);
    })
  ));
