import { PaymentEnrollmentId, ResourceLimited } from "@fidy/server/client";
import type { APIRequestContext, APIResponse, Page, Route } from "@playwright/test";
import { DateTime, Effect, Option, Schema } from "effect";
import type { Cause } from "effect";
import { playwright } from "./playwright-runtime";
import {
  boundSessionRequests,
  browserSessionHeaders,
  openUpgradeThroughCore,
  probeCanonicalRequest,
  reloadTransactionsThroughCore,
  signInFirstCardThroughCore,
  signInFirstDaviplataThroughCore,
  signInNavigationThroughCore,
  signInThroughCore,
  signInWithVerifiedEmailThroughCore,
} from "./real-core-fixture";

const { expect, test } = playwright;

const api = "https://127.0.0.1:4174";
const appOrigin = "https://127.0.0.1:4173";
const ok = 200;
const created = 201;
const forbidden = 403;
const unauthorized = 401;
const noContent = 204;
const notFound = 404;
const enrollmentJourneyMilliseconds = 60_000;
const canonicalRecoveryMilliseconds = 15_000;
const resourceProbeRetries = 6;
const maximumProbeDelaySeconds = 5;
const RetrySeconds = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(maximumProbeDelaySeconds)
);

const fromPlaywright = <A>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
const holdTransactionRead = (
  page: Page,
  release: Promise<void>
): Promise<Readonly<{ received: Promise<Route> }>> => {
  const received = Promise.withResolvers<Route>();
  return page
    .route(`${api}/transactions?*`, (route) => {
      received.resolve(route);
      return release.then(() => route.continue());
    })
    .then(() => ({ received: received.promise }));
};

// Playwright serializes this function into the browser; Effect is not present there.
const fetchWithBearer = ({
  url,
  token,
}: {
  url: string;
  token: string;
}): Promise<typeof SessionProbeWire.Encoded> =>
  window
    .fetch(url, { credentials: "omit", headers: { authorization: `Bearer ${token}` } })
    .then((response) =>
      response.text().then((body) => ({
        status: response.status,
        body,
        retryAfter: response.headers.get("retry-after"),
      }))
    );

const SessionProbeWire = Schema.Struct({
  status: Schema.Int,
  body: Schema.String,
  retryAfter: Schema.OptionFromNullOr(Schema.String),
});
const fetchWithSession = ({
  url,
  headers,
}: Readonly<{ url: string; headers: Record<string, string> }>): Promise<
  typeof SessionProbeWire.Encoded
> =>
  window.fetch(url, { credentials: "include", headers }).then((response) =>
    response.text().then((body) => ({
      status: response.status,
      body,
      retryAfter: response.headers.get("retry-after"),
    }))
  );
const inspectBrowserSnapshot = (
  page: Page,
  url: string,
  bearer: Option.Option<string> = Option.none()
): Effect.Effect<
  Readonly<{ status: number; body: string }>,
  Cause.UnknownError | Cause.TimeoutError
> =>
  Effect.gen(function* () {
    const limited = 429;
    const millisecondsPerSecond = 1_000;
    const send = (): Promise<typeof SessionProbeWire.Encoded> =>
      Option.match(bearer, {
        onNone: () =>
          browserSessionHeaders(page.request).then((headers) =>
            page.evaluate(fetchWithSession, { url, headers })
          ),
        onSome: (token) => page.evaluate(fetchWithBearer, { url, token }),
      });
    for (let retry = 0; retry < resourceProbeRetries; retry++) {
      const received = yield* fromPlaywright(send());
      const wire = yield* Schema.decodeEffect(SessionProbeWire)(received).pipe(Effect.orDie);
      const seconds = Option.flatMap(wire.retryAfter, Schema.decodeOption(RetrySeconds));
      const refusal = Schema.decodeOption(
        Schema.fromJsonString(Schema.toCodecJson(ResourceLimited))
      )(wire.body);
      if (wire.status !== limited || Option.isNone(seconds) || Option.isNone(refusal)) {
        return { status: wire.status, body: wire.body };
      }
      yield* Effect.sleep(seconds.value * millisecondsPerSecond);
    }
    const wire = yield* fromPlaywright(send());
    return { status: wire.status, body: wire.body };
  }).pipe(Effect.timeout(canonicalRecoveryMilliseconds));
const inspectCanonicalSnapshot = (
  page: Page,
  path: string
): Effect.Effect<
  Readonly<{ status: number; body: string }>,
  Cause.UnknownError | Cause.TimeoutError
> =>
  Effect.gen(function* () {
    const response = yield* probeCanonicalRequest({
      request: page.request,
      send: () =>
        boundSessionRequests(page.context().request).get(path, { headers: { origin: appOrigin } }),
    });
    return { status: response.status(), body: yield* fromPlaywright(response.text()) };
  });
const assertUnderScopedBrowser = (
  page: Page,
  request: APIRequestContext,
  bearer: string
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const refused = yield* probeCanonicalRequest({
        request: page.request,
        send: () =>
          request.get(`${api}/transactions`, {
            headers: {
              authorization: `Bearer ${bearer}`,
            },
          }),
      });
      expect(refused.status()).toBe(forbidden);
      const browserRefusal = yield* inspectBrowserSnapshot(
        page,
        `${api}/transactions`,
        Option.some(bearer)
      );
      expect(browserRefusal.status).toBe(forbidden);
      expect(browserRefusal.body).not.toContain("OTHER-USER-PRIVATE");
      const runProbe = Effect.runPromiseWith(yield* Effect.context<never>());
      yield* fromPlaywright(
        page.route(`${api}/transactions?*`, (route) =>
          runProbe(
            probeCanonicalRequest({
              request: page.request,
              send: () =>
                request.get(route.request().url(), {
                  headers: {
                    authorization: `Bearer ${bearer}`,
                  },
                }),
            })
          ).then((coreResponse) => {
            expect(coreResponse.status()).toBe(forbidden);
            return route.fulfill({
              response: coreResponse,
            });
          })
        )
      );
      yield* fromPlaywright(page.goto("/app/transactions"));
      yield* fromPlaywright(expect(page.getByRole("alert")).toBeVisible());
      expect(yield* fromPlaywright(page.locator("body").textContent())).not.toContain(bearer);
      expect(yield* fromPlaywright(page.locator("body").textContent())).not.toContain(
        yield* fromPlaywright(refused.text())
      );
    })
  );
test("fresh and concurrent Dashboard first use explicitly initializes through authoritative Core queries", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(
        (yield* fromPlaywright(request.post("http://127.0.0.1:4175/dashboard/reset"))).status()
      ).toBe(noContent);
      yield* fromPlaywright(signInFirstCardThroughCore({ page, request }));
      for (const path of ["/dashboard", "/dashboard/view"]) {
        const absent = yield* inspectCanonicalSnapshot(page, `${api}${path}`);
        expect(absent.status).toBe(notFound);
        expect(absent.body).toContain("dashboard_uninitialized");
      }
      const other = yield* fromPlaywright(page.context().newPage());
      const initializeCalls: Array<string> = [];
      page.context().on("request", (call) => {
        if (call.url() === `${api}/dashboard/initialize`) initializeCalls.push(call.method());
      });
      yield* fromPlaywright(
        Promise.all([page.goto("/app/dashboard"), other.goto("/app/dashboard")])
      );
      yield* fromPlaywright(
        expect(page.getByRole("heading", { name: "Tablero", exact: true })).toBeVisible({
          timeout: canonicalRecoveryMilliseconds,
        })
      );
      yield* fromPlaywright(
        expect(other.getByRole("heading", { name: "Tablero", exact: true })).toBeVisible({
          timeout: canonicalRecoveryMilliseconds,
        })
      );
      expect(initializeCalls.length).toBeGreaterThan(0);
      expect(initializeCalls.every((method) => method === "POST")).toBe(true);
      const before = yield* inspectCanonicalSnapshot(page, `${api}/dashboard`);
      expect(before.status).toBe(ok);
      const countBefore = initializeCalls.length;
      yield* fromPlaywright(page.reload());
      yield* fromPlaywright(
        expect(page.getByRole("heading", { name: "Tablero", exact: true })).toBeVisible()
      );
      const after = yield* inspectCanonicalSnapshot(page, `${api}/dashboard`);
      expect(after).toEqual(before);
      expect(initializeCalls).toHaveLength(countBefore);
      yield* fromPlaywright(other.close());
    })
  ));

const startPatPairing = Effect.fnUntraced(function* (page: Page, request: APIRequestContext) {
  yield* fromPlaywright(
    signInThroughCore({
      page,
      request,
    })
  );
  const started = yield* fromPlaywright(
    request.post(`${api}/pat-pairings`, {
      data: {
        recipientLabel: "Agente emparejado",
        scopes: ["write"],
        lifetimeDays: 30,
      },
    })
  );
  expect(started.status()).toBe(ok);
  const { pairingId, publicCode, privateDeviceCode } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      pairingId: Schema.String,
      publicCode: Schema.String,
      privateDeviceCode: Schema.String,
    })
  )(yield* fromPlaywright(started.json()));
  return { pairingId, publicCode, privateDeviceCode };
});

test("reviews a real PATPairing and presents its under-scoped Core refusal without leaking details", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { pairingId, publicCode, privateDeviceCode } = yield* startPatPairing(page, request);
      yield* fromPlaywright(page.goto("/connect/cli"));
      yield* fromPlaywright(
        page
          .getByLabel("Código", {
            exact: true,
          })
          .fill(publicCode.toLowerCase())
      );
      yield* fromPlaywright(
        page
          .getByRole("button", {
            name: "Continuar",
          })
          .click()
      );
      yield* fromPlaywright(expect(page.getByText("Agente emparejado").first()).toBeVisible());
      yield* fromPlaywright(
        page
          .getByRole("button", {
            name: "Autorizar acceso",
          })
          .click()
      );
      yield* fromPlaywright(expect(page.getByText("Acceso autorizado")).toBeVisible());
      expect(yield* fromPlaywright(page.locator("body").textContent())).not.toContain(
        privateDeviceCode
      );
      const claimed = yield* fromPlaywright(
        request.post(`${api}/pat-pairings/claim`, {
          data: {
            pairingId,
            privateDeviceCode,
          },
        })
      );
      expect(claimed.status()).toBe(ok);
      const { bearer } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          bearer: Schema.String,
        })
      )(yield* fromPlaywright(claimed.json()));
      expect(bearer).toMatch(/^fin_/u);
      expect(yield* fromPlaywright(page.locator("body").textContent())).not.toContain(bearer);
      yield* fromPlaywright(assertUnderScopedBrowser(page, request, bearer));
    })
  ));
test("renders a seeded Category identity from real public and Core routes", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* fromPlaywright(
        signInThroughCore({
          page,
          request,
        })
      );
      const categories = yield* probeCanonicalRequest({
        request: page.request,
        send: () =>
          boundSessionRequests(page.request).get(`${api}/categories`, {
            headers: {
              origin: "https://127.0.0.1:4173",
            },
          }),
      });
      expect(categories.status()).toBe(ok);
      expect(yield* fromPlaywright(categories.json())).toMatchObject({
        data: expect.arrayContaining([
          {
            id: "10000000-0000-4000-8000-000000000001",
            label: "Restaurantes",
          },
        ]),
      });
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      const captured = yield* probeCanonicalRequest({
        request: page.request,
        send: () =>
          boundSessionRequests(page.request).post(`${api}/transactions`, {
            headers: {
              origin: "https://127.0.0.1:4173",
            },
            data: {
              money: {
                amount: "12500",
                currency: "COP",
              },
              counterparty: "La Cocina real",
              direction: "outflow",
              categoryId: "10000000-0000-4000-8000-000000000001",
              occurredAt,
            },
          }),
      });
      expect(captured.status()).toBe(created);
      yield* fromPlaywright(reloadTransactionsThroughCore(page));
      yield* fromPlaywright(expect(page.getByText("La Cocina real").first()).toBeVisible());
      yield* fromPlaywright(
        expect(page.getByText("Restaurantes").filter({ visible: true }).first()).toBeVisible()
      );
    })
  ));
test("renders stored hostile Transaction text literally after a real Core write and reload", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* fromPlaywright(signInThroughCore({ page, request }));
      const hostile = '<img src=x onerror="window.__fidyStoredInjection=true">';
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      const captured = yield* probeCanonicalRequest({
        request: page.request,
        send: () =>
          boundSessionRequests(page.request).post(`${api}/transactions`, {
            headers: { origin: appOrigin },
            data: {
              money: { amount: "12500", currency: "COP" },
              counterparty: hostile,
              direction: "outflow",
              categoryId: "10000000-0000-4000-8000-000000000001",
              occurredAt,
            },
          }),
      });
      expect(captured.status()).toBe(created);
      yield* fromPlaywright(reloadTransactionsThroughCore(page));
      yield* fromPlaywright(expect(page.getByText(hostile, { exact: true }).first()).toBeVisible());
      yield* fromPlaywright(expect(page.locator('img[src="x"]')).toHaveCount(0));
      expect(
        yield* fromPlaywright(page.evaluate(() => Object.hasOwn(window, "__fidyStoredInjection")))
      ).toBe(false);
    })
  ));

test("a browser cannot render or fetch another User's private Transaction through public routes", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* fromPlaywright(
        signInThroughCore({
          page,
          request,
        })
      );
      yield* fromPlaywright(page.goto("/app/transactions"));
      const refusal = yield* inspectBrowserSnapshot(
        page,
        `${api}/transactions/24000000-0000-4000-8000-000000000262`
      );
      expect(refusal.status).toBe(notFound);
      expect(refusal.body).not.toContain("OTHER-USER-PRIVATE");
      expect(yield* fromPlaywright(page.locator("body").textContent())).not.toContain(
        "OTHER-USER-PRIVATE"
      );
    })
  ));
test("renders loading until the real Core answers Transactions", ({ page, request }) => {
  const release = Promise.withResolvers<void>();
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* fromPlaywright(
        signInNavigationThroughCore({
          page,
          request,
          identity: "navigationLoading",
        })
      );
      yield* fromPlaywright(
        expect(page.getByText("No hay transacciones para mostrar")).toBeVisible()
      );
      const held = yield* fromPlaywright(holdTransactionRead(page, release.promise));
      yield* fromPlaywright(reloadTransactionsThroughCore(page));
      yield* fromPlaywright(
        expect(
          page.getByRole("region", {
            name: "Cargando transacciones",
          })
        ).toBeVisible()
      );
      yield* fromPlaywright(held.received);
      // Observe logical success after any bounded native-admission retries.
      const completed = page.waitForResponse(
        (response) => response.url().startsWith(`${api}/transactions?`) && response.status() === ok,
        { timeout: canonicalRecoveryMilliseconds }
      );
      release.resolve();
      yield* fromPlaywright(completed);
      yield* fromPlaywright(
        expect(
          page.getByRole("region", {
            name: "Cargando transacciones",
          })
        ).toHaveCount(0)
      );
    }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
  );
});
test("approves a browser pairing through the real verified-email public route", ({
  page,
  request,
}) => signInWithVerifiedEmailThroughCore({ page, request, email: "usuario@example.com" }));
test("replaces a verified EmailCredential through public operations after fixture delivery", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* fromPlaywright(
        signInThroughCore({
          page,
          request,
        })
      );
      yield* fromPlaywright(page.goto("/settings/account"));
      yield* fromPlaywright(page.getByLabel("Nuevo correo").fill("nuevo@example.com"));
      yield* fromPlaywright(
        page
          .getByRole("button", {
            name: "Enviar código",
          })
          .click()
      );
      yield* fromPlaywright(
        expect(page.getByText("Enviamos un código a nuevo@example.com.")).toBeVisible()
      );
      const delivered = yield* fromPlaywright(
        request.post("http://127.0.0.1:4175/email/replacement/deliver")
      );
      expect(delivered.status()).toBe(noContent);
      const code = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
      yield* fromPlaywright(page.getByLabel("Código de verificación").fill(code));
      yield* fromPlaywright(
        page
          .getByRole("button", {
            name: "Cambiar correo",
          })
          .click()
      );
      yield* fromPlaywright(
        expect(page.getByText("Tu nuevo correo verificado ya está activo.")).toBeVisible()
      );
      expect(page.url()).not.toContain(code);
      expect(
        yield* fromPlaywright(page.evaluate(() => localStorage.length + sessionStorage.length))
      ).toBe(0);
    })
  ));
type EnrollmentSubmission = Readonly<{ status: number; body: unknown }>;
const captureEnrollmentReply = (
  response: APIResponse,
  route: Route,
  capture: ReturnType<typeof Promise.withResolvers<EnrollmentSubmission>>
): Promise<void> =>
  response.json().then((body: unknown) => {
    capture.resolve({ status: response.status(), body });
    return route.fulfill({ response });
  });
const observeEnrollmentSubmission = (
  page: Page,
  capture: ReturnType<typeof Promise.withResolvers<EnrollmentSubmission>>
): ReturnType<Page["route"]> =>
  page.route(`${api}/web/subscription/payment-enrollments/submit`, (route) =>
    route.fetch().then((response) => captureEnrollmentReply(response, route, capture))
  );

const submitReusedCard = Effect.fnUntraced(function* (page: Page, request: APIRequestContext) {
  yield* fromPlaywright(
    signInThroughCore({
      page,
      request,
    })
  );
  yield* fromPlaywright(openUpgradeThroughCore(page));
  const preparing = page.waitForResponse(
    (response) => response.url() === `${api}/web/subscription/payment-enrollments/prepare`
  );
  yield* fromPlaywright(
    page
      .getByRole("button", {
        name: "Elegir mensual",
      })
      .click()
  );
  const prepared = yield* fromPlaywright(preparing);
  expect(prepared.status()).toBe(ok);
  yield* fromPlaywright(
    expect(
      page.getByText("Usaremos de nuevo tu fuente de pago guardada.", {
        exact: false,
      })
    ).toBeVisible()
  );
  yield* fromPlaywright(page.getByLabel(/Acepto el reglamento/iu).check());
  yield* fromPlaywright(page.getByLabel(/Autorizo el tratamiento/iu).check());
  const submission = Promise.withResolvers<EnrollmentSubmission>();
  yield* fromPlaywright(observeEnrollmentSubmission(page, submission));
  yield* fromPlaywright(page.getByRole("button", { name: "Activar Pro" }).click());
  const submitted = yield* fromPlaywright(submission.promise);
  expect(submitted.status).toBe(ok);
  const submissionBody = submitted.body;
  expect(submissionBody).toMatchObject({
    status: "payment-pending",
    billingAttempt: {
      status: "pending",
    },
  });
  const { billingAttempt } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      billingAttempt: Schema.Struct({
        id: Schema.String,
      }),
    })
  )(submissionBody);
  return billingAttempt.id;
});

test("submits reused-source Subscription enrollment through real public and Core routes", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const billingAttemptId = yield* submitReusedCard(page, request);
      expect(
        (yield* fromPlaywright(request.post("http://127.0.0.1:4175/billing/collect"))).status()
      ).toBe(noContent);
      const settled = yield* fromPlaywright(
        boundSessionRequests(page.request).get(
          `${api}/web/subscription/billing-attempts/${billingAttemptId}`,
          {
            headers: {
              origin: "https://127.0.0.1:4173",
            },
          }
        )
      );
      expect(settled.status()).toBe(ok);
      expect(yield* fromPlaywright(settled.json())).toMatchObject({
        status: "succeeded",
      });
      const standing = yield* probeCanonicalRequest({
        request: page.request,
        send: () =>
          boundSessionRequests(page.request).get(`${api}/subscription/status`, {
            headers: {
              origin: "https://127.0.0.1:4173",
            },
          }),
      });
      expect(standing.status()).toBe(ok);
      expect(yield* fromPlaywright(standing.json())).toMatchObject({
        data: {
          accessTier: "pro",
          paidSubscription: {
            billingPeriod: "monthly",
            priceId: "22700000-0000-4000-8000-000000000002",
          },
        },
      });
      yield* fromPlaywright(
        expect(page.getByText("Tu pago fue realizado y tu suscripción está activa.")).toBeVisible({
          timeout: 20_000,
        })
      );
    })
  ));
const installCardTokenRoute = (
  page: Page,
  cardNumber: string,
  capture: { providerTokens: number }
): ReturnType<Page["route"]> =>
  page.route("https://sandbox.wompi.co/v1/tokens/cards", (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        status: noContent,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "POST",
        },
      });
    }
    capture.providerTokens += 1;
    expect(route.request().postData()).toContain(cardNumber);
    return route.fulfill({
      status: ok,
      headers: {
        "access-control-allow-origin": "*",
      },
      contentType: "application/json",
      body: '{"data":{"id":"tok_acceptance_first_card","brand":"VISA"}}',
    });
  });

const captureFidyBodies = (page: Page, bodies: Array<string>): void => {
  page.on("request", (outbound) => {
    if (outbound.url().startsWith(api) && outbound.postData() !== null) {
      bodies.push(outbound.postData() ?? "");
    }
  });
};

test("tokenizes a first card without an email-login credential through real public and Core routes", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* fromPlaywright(signInFirstCardThroughCore({ page, request }));
      const cardNumber = "4111111111111111";
      const capture = { providerTokens: 0 };
      const fidyBodies: Array<string> = [];
      captureFidyBodies(page, fidyBodies);
      yield* fromPlaywright(installCardTokenRoute(page, cardNumber, capture));
      yield* fromPlaywright(openUpgradeThroughCore(page));
      yield* fromPlaywright(
        page
          .getByRole("button", {
            name: "Elegir mensual",
          })
          .click()
      );
      yield* fromPlaywright(expect(page.getByLabel("Número de tarjeta")).toBeVisible());
      yield* fromPlaywright(expect(page.getByLabel("Correo de facturación")).toHaveValue(""));
      yield* fromPlaywright(page.getByLabel("Correo de facturación").fill("tarjeta@example.com"));
      yield* fromPlaywright(page.getByLabel("Número de tarjeta").fill(cardNumber));
      yield* fromPlaywright(page.getByLabel("Vencimiento").fill("122028"));
      yield* fromPlaywright(page.getByLabel("CVC").fill("123"));
      yield* fromPlaywright(page.getByLabel("Nombre en la tarjeta").fill("Usuario Prueba"));
      yield* fromPlaywright(page.getByLabel(/Acepto el reglamento/iu).check());
      yield* fromPlaywright(page.getByLabel(/Autorizo el tratamiento/iu).check());
      // The application navigates on this response. Read the real Core reply before
      // releasing it to Chromium, which can discard response bodies after navigation.
      const submitResponse = Promise.withResolvers<EnrollmentSubmission>();
      yield* fromPlaywright(observeEnrollmentSubmission(page, submitResponse));
      yield* fromPlaywright(
        page
          .getByRole("button", {
            name: "Activar Pro",
          })
          .click()
      );
      const submitted = yield* fromPlaywright(submitResponse.promise);
      expect(submitted.status).toBe(ok);
      expect(submitted.body).toMatchObject({
        status: "payment-pending",
      });
      expect(
        (yield* fromPlaywright(request.post("http://127.0.0.1:4175/billing/collect"))).status()
      ).toBe(noContent);
      yield* fromPlaywright(
        expect(page.getByText("Tu pago fue realizado y tu suscripción está activa.")).toBeVisible({
          timeout: 20_000,
        })
      );
      expect(capture.providerTokens).toBe(1);
      expect(
        fidyBodies.every((body) => !body.includes(cardNumber) && !body.includes("Usuario Prueba"))
      ).toBe(true);
    })
  ));
type DaviplataFixtureStep = "tokenize" | "send" | "confirm";
const daviplataFixtureUrls: Readonly<Record<DaviplataFixtureStep, string>> = {
  tokenize: "https://sandbox.wompi.co/v1/tokens/daviplata",
  send: "https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox?token=daviplata_devtest_acceptance&operation=RESEND_OTP",
  confirm:
    "https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox?token=daviplata_devtest_acceptance&operation=VALIDATE_OTP_API",
};
const daviplataAuthorization = "daviplata_devtest_acceptance";
const daviplataServiceBearers = {
  initial: "synthetic-daviplata-initial",
  sent: "synthetic-daviplata-code",
  approved: "synthetic-daviplata-approved",
};
const daviplataOtpFixture = (approved: boolean): unknown => ({
  data: {
    subscription: { PK: daviplataAuthorization, status: approved ? "APPROVED" : "PENDING" },
    authorization: {
      access_token: approved ? daviplataServiceBearers.approved : daviplataServiceBearers.sent,
    },
    attempts: {
      currentSendCode: 1,
      limitSendCode: 2,
      currentValidateCode: approved ? 1 : 0,
      limitValidateCode: 2,
    },
  },
});
const daviplataProviderReply = (step: DaviplataFixtureStep): unknown =>
  step === "tokenize"
    ? {
        data: {
          id: daviplataAuthorization,
          status: "PENDING",
          url_services: {
            token: daviplataServiceBearers.initial,
            code_otp_send: daviplataFixtureUrls.send,
            code_otp_validate: daviplataFixtureUrls.confirm,
          },
        },
      }
    : daviplataOtpFixture(step === "confirm");
const assertDaviplataProviderRequest = (route: Route, step: DaviplataFixtureStep): void => {
  expect(route.request().method()).toBe("POST");
  const bearers = {
    tokenize: `pub_test_${"f1d7c0de".repeat(3)}`,
    send: daviplataServiceBearers.initial,
    confirm: daviplataServiceBearers.sent,
  };
  expect(route.request().headers().authorization).toBe(`Bearer ${bearers[step]}`);
  if (step === "send") {
    expect(route.request().postData()).toBeNull();
    return;
  }
  expect(route.request().postDataJSON()).toEqual(
    step === "tokenize"
      ? { type_document: "CC", number_document: "1122233", product_number: "3991111111" }
      : { code: "574829" }
  );
};
const installDaviplataProviderRoutes = (
  page: Page,
  calls: Array<DaviplataFixtureStep>
): Promise<unknown> =>
  Promise.all(
    (["tokenize", "send", "confirm"] as const).map((step) =>
      page.route(daviplataFixtureUrls[step], (route) => {
        if (route.request().method() === "OPTIONS") {
          return route.fulfill({
            status: noContent,
            headers: {
              "access-control-allow-origin": "*",
              "access-control-allow-headers": "authorization, content-type",
              "access-control-allow-methods": "POST",
            },
          });
        }
        assertDaviplataProviderRequest(route, step);
        calls.push(step);
        return route.fulfill({
          status: ok,
          headers: { "access-control-allow-origin": "*" },
          contentType: "application/json",
          body: JSON.stringify(daviplataProviderReply(step)),
        });
      })
    )
  );
type ObservedFidyBody = Readonly<{ url: string; body: string }>;
const captureDaviplataFidyBodies = (page: Page, bodies: Array<ObservedFidyBody>): void => {
  page.on("request", (outbound) => {
    const body = outbound.postData();
    if (outbound.url().startsWith(api) && body !== null) bodies.push({ url: outbound.url(), body });
  });
};
const assertDaviplataSecrecy = (bodies: ReadonlyArray<ObservedFidyBody>): void => {
  const secrets = [
    "1122233",
    "3991111111",
    "574829",
    ...Object.values(daviplataServiceBearers),
    "number_document",
    "product_number",
    '"code"',
    "access_token",
  ];
  expect(bodies.every(({ body }) => secrets.every((secret) => !body.includes(secret)))).toBe(true);
  const approved = bodies.filter(({ body }) => body.includes(daviplataAuthorization));
  expect(approved).toHaveLength(1);
  expect(approved[0]?.url).toBe(`${api}/web/subscription/payment-enrollments/submit`);
  expect(approved[0]?.body).toContain('"method":"daviplata"');
  expect(approved[0]?.body).toContain('"billingEmail":"daviplata@example.com"');
};
const submitFirstDaviplata = Effect.fnUntraced(function* (page: Page) {
  yield* fromPlaywright(openUpgradeThroughCore(page));
  yield* fromPlaywright(page.getByRole("button", { name: "DaviPlata" }).click());
  yield* fromPlaywright(page.getByRole("button", { name: "Elegir mensual" }).click());
  yield* fromPlaywright(
    expect(page.getByText("Cédula de ciudadanía (CC). Por ahora solo admitimos CC.")).toBeVisible()
  );
  yield* fromPlaywright(page.getByLabel("Número de cédula").fill("1122233"));
  yield* fromPlaywright(page.getByLabel("Número de DaviPlata").fill("3991111111"));
  yield* fromPlaywright(
    expect(page.getByLabel("Correo de facturación")).toHaveValue("daviplata@example.com")
  );
  yield* fromPlaywright(page.getByLabel(/Acepto el reglamento/iu).check());
  yield* fromPlaywright(page.getByLabel(/Autorizo el tratamiento/iu).check());
  yield* fromPlaywright(page.getByRole("button", { name: "Autorizar con DaviPlata" }).click());
  yield* fromPlaywright(expect(page.getByLabel("Número de cédula")).toHaveCount(0));
  yield* fromPlaywright(page.getByLabel("Código de verificación").fill("574829"));
  const submission = page.waitForResponse(
    (response) => response.url() === `${api}/web/subscription/payment-enrollments/submit`
  );
  yield* fromPlaywright(page.getByRole("button", { name: "Confirmar código" }).click());
  const submitted = yield* fromPlaywright(submission);
  expect(submitted.status()).toBe(ok);
  const { enrollmentId } = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ enrollmentId: PaymentEnrollmentId }))
  )(submitted.request().postData());
  const enrollment = yield* fromPlaywright(
    boundSessionRequests(page.request).get(
      `${api}/web/subscription/payment-enrollments/${enrollmentId}`,
      {
        headers: { origin: appOrigin },
      }
    )
  );
  expect(enrollment.status()).toBe(ok);
  expect(yield* fromPlaywright(enrollment.json())).toMatchObject({
    status: "available",
    enrollmentId,
    method: "daviplata",
    priceId: "22700000-0000-4000-8000-000000000002",
  });
});

test("authorizes DaviPlata directly in the built browser and grants paid Pro only after real Core collection", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      test.setTimeout(enrollmentJourneyMilliseconds);
      yield* fromPlaywright(signInFirstDaviplataThroughCore({ page, request }));
      const providerCalls: Array<DaviplataFixtureStep> = [];
      const fidyBodies: Array<ObservedFidyBody> = [];
      captureDaviplataFidyBodies(page, fidyBodies);
      yield* fromPlaywright(installDaviplataProviderRoutes(page, providerCalls));
      yield* submitFirstDaviplata(page);
      const beforeCollection = yield* fromPlaywright(
        boundSessionRequests(page.request).get(`${api}/subscription/status`)
      );
      expect(beforeCollection.status()).toBe(ok);
      expect(yield* fromPlaywright(beforeCollection.json())).toMatchObject({
        data: {
          accessTier: "free",
          paidSubscription: null,
          recentAttempts: [
            {
              status: "pending",
              billingPeriod: "monthly",
              priceId: "22700000-0000-4000-8000-000000000002",
            },
          ],
        },
      });
      expect(
        (yield* fromPlaywright(request.post("http://127.0.0.1:4175/billing/collect"))).status()
      ).toBe(noContent);
      yield* fromPlaywright(
        expect(page.getByText("Tu pago fue realizado y tu suscripción está activa.")).toBeVisible({
          timeout: 20_000,
        })
      );
      const afterCollection = yield* fromPlaywright(
        boundSessionRequests(page.request).get(`${api}/subscription/status`)
      );
      expect(afterCollection.status()).toBe(ok);
      expect(yield* fromPlaywright(afterCollection.json())).toMatchObject({
        data: {
          accessTier: "pro",
          paidSubscription: {
            billingPeriod: "monthly",
            priceId: "22700000-0000-4000-8000-000000000002",
          },
        },
      });
      expect(providerCalls).toEqual(["tokenize", "send", "confirm"]);
      assertDaviplataSecrecy(fidyBodies);
      expect(yield* fromPlaywright(page.locator("body").textContent())).not.toContain(
        daviplataAuthorization
      );
    })
  ));

const issueReadOnlyPat = Effect.fnUntraced(function* (page: Page, request: APIRequestContext) {
  yield* fromPlaywright(signInThroughCore({ page, request }));
  yield* fromPlaywright(page.goto("/settings/access"));
  yield* fromPlaywright(
    page
      .getByLabel("Nombre", {
        exact: true,
      })
      .fill("Agente de casa")
  );
  yield* fromPlaywright(
    page
      .getByRole("checkbox", {
        name: /^Lectura:/u,
      })
      .check()
  );
  yield* fromPlaywright(
    page
      .getByRole("button", {
        name: "Duración del token",
      })
      .click()
  );
  yield* fromPlaywright(page.getByRole("menuitemradio", { name: "30 días" }).click());
  yield* fromPlaywright(
    page
      .getByRole("button", {
        name: "Crear token",
      })
      .click()
  );
  yield* fromPlaywright(
    expect(
      page.getByRole("heading", {
        name: "Revisa el acceso",
      })
    ).toBeVisible()
  );
  yield* fromPlaywright(
    page
      .getByRole("button", {
        name: "Confirmar y crear token",
      })
      .click()
  );
  const bearer = yield* fromPlaywright(
    page
      .locator("code")
      .filter({
        hasText: /^fin_/u,
      })
      .textContent()
  );
  expect(bearer).toMatch(/^fin_/u);
  return yield* Schema.decodeUnknownEffect(Schema.String)(bearer);
});

const revokeReadOnlyPat = Effect.fnUntraced(function* (
  page: Page,
  request: APIRequestContext,
  bearer: string
) {
  yield* fromPlaywright(
    page
      .getByRole("button", {
        name: "Crear otro token",
      })
      .click()
  );
  yield* fromPlaywright(expect(page.getByText(bearer)).toHaveCount(0));
  yield* fromPlaywright(page.reload());
  yield* fromPlaywright(
    expect(
      page
        .getByRole("table", { name: "Tokens activos" })
        .getByText("Agente de casa", { exact: true })
    ).toBeVisible()
  );
  yield* fromPlaywright(
    page
      .getByRole("row")
      .filter({
        has: page.getByText("Agente de casa", { exact: true }),
      })
      .getByRole("button", {
        name: "Desactivar",
        exact: true,
      })
      .click()
  );
  yield* fromPlaywright(
    page
      .getByRole("button", {
        name: "Sí, desactivar",
      })
      .click()
  );
  yield* fromPlaywright(
    expect(page.getByText("Token desactivado. Dejó de funcionar de inmediato.")).toBeVisible()
  );
  const revoked = yield* fromPlaywright(
    request.get(`${api}/transactions`, {
      headers: {
        authorization: `Bearer ${bearer}`,
      },
    })
  );
  expect(revoked.status()).toBe(unauthorized);
});

test("a read-only PAT issued through the real browser session cannot capture Transactions after review or revocation", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bearer = yield* issueReadOnlyPat(page, request);
      const readOnly = yield* probeCanonicalRequest({
        request: page.request,
        send: () =>
          request.post(`${api}/transactions`, {
            headers: {
              authorization: `Bearer ${bearer}`,
            },
            data: {
              money: {
                amount: "1",
                currency: "COP",
              },
            },
          }),
      });
      expect(readOnly.status()).toBe(forbidden);
      yield* revokeReadOnlyPat(page, request, bearer);
    })
  ));
