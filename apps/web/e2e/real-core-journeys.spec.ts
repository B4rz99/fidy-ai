import type { APIRequestContext, Page, Route } from "@playwright/test";
import { DateTime, Effect, Schema } from "effect";
import type { Cause } from "effect";
import { playwright } from "./playwright-runtime";
import {
  signInFirstCardThroughCore,
  signInFirstDaviplataThroughCore,
  signInThroughCore,
  signInWithVerifiedEmailThroughCore,
} from "./real-core-fixture";

const { expect, test } = playwright;

const api = "https://127.0.0.1:4174";
const ok = 200;
const created = 201;
const forbidden = 403;
const unauthorized = 401;
const noContent = 204;
const notFound = 404;

// Playwright owns these promises; each call is made at its point in the test Effect.
const fromPlaywright = <A>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
const continueAfterDelay = (route: Route): Promise<void> =>
  Effect.runPromise(Effect.sleep("1 second")).then(() => route.continue());

// Playwright serializes this function into the browser; Effect is not present there.
const fetchWithBearer = ({
  url,
  token,
}: {
  url: string;
  token: string;
}): Promise<{ status: number; body: string }> =>
  window
    .fetch(url, { credentials: "omit", headers: { authorization: `Bearer ${token}` } })
    .then((response) => response.text().then((body) => ({ status: response.status, body })));

const fetchWithSession = (url: string): Promise<{ status: number; body: string }> =>
  window
    .fetch(url, { credentials: "include" })
    .then((response) => response.text().then((body) => ({ status: response.status, body })));
const assertUnderScopedBrowser = (
  page: Page,
  request: APIRequestContext,
  bearer: string
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      // A PAT does not authenticate the browser shell; its refusal is forwarded as-is to the UI.
      const refused = yield* fromPlaywright(
        request.get(`${api}/transactions`, {
          headers: {
            authorization: `Bearer ${bearer}`,
          },
        })
      );
      expect(refused.status()).toBe(forbidden);
      const browserRefusal = yield* fromPlaywright(
        page.evaluate(fetchWithBearer, { url: `${api}/transactions`, token: bearer })
      );
      expect(browserRefusal.status).toBe(forbidden);
      expect(browserRefusal.body).not.toContain("OTHER-USER-PRIVATE");
      yield* fromPlaywright(
        page.route(`${api}/transactions?*`, (route) =>
          // Replay this UI query with only the CLI bearer: browser WebSessions have no reduced scope.
          request
            .get(route.request().url(), {
              headers: {
                authorization: `Bearer ${bearer}`,
              },
            })
            .then((coreResponse) => {
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
      yield* fromPlaywright(page.goto("/settings/pats"));
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
      const categories = yield* fromPlaywright(
        page.request.get(`${api}/categories`, {
          headers: {
            origin: "https://127.0.0.1:4173",
          },
        })
      );
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
      const captured = yield* fromPlaywright(
        page.request.post(`${api}/transactions`, {
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
        })
      );
      expect(captured.status()).toBe(created);
      yield* fromPlaywright(page.goto("/app/transactions"));
      yield* fromPlaywright(expect(page.getByText("La Cocina real").first()).toBeVisible());
      yield* fromPlaywright(expect(page.getByText("Restaurantes").first()).toBeVisible());
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
      const refusal = yield* fromPlaywright(
        page.evaluate(fetchWithSession, `${api}/transactions/24000000-0000-4000-8000-000000000262`)
      );
      expect(refusal.status).toBe(notFound);
      expect(refusal.body).not.toContain("OTHER-USER-PRIVATE");
      expect(yield* fromPlaywright(page.locator("body").textContent())).not.toContain(
        "OTHER-USER-PRIVATE"
      );
    })
  ));
test("renders loading until the real Core answers Transactions", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* fromPlaywright(
        signInThroughCore({
          page,
          request,
        })
      );
      yield* fromPlaywright(page.route(`${api}/transactions?*`, continueAfterDelay));
      yield* fromPlaywright(page.goto("/app/transactions"));
      yield* fromPlaywright(
        expect(
          page.getByRole("region", {
            name: "Cargando transacciones",
          })
        ).toBeVisible()
      );
      yield* fromPlaywright(
        expect(
          page.getByRole("region", {
            name: "Cargando transacciones",
          })
        ).toHaveCount(0)
      );
    })
  ));
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
      yield* fromPlaywright(page.goto("/settings/email"));
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
const submitReusedCard = Effect.fnUntraced(function* (page: Page, request: APIRequestContext) {
  yield* fromPlaywright(
    signInThroughCore({
      page,
      request,
    })
  );
  yield* fromPlaywright(page.goto("/upgrade"));
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
  const submission = page.waitForResponse(
    (response) => response.url() === `${api}/web/subscription/payment-enrollments/submit`
  );
  yield* fromPlaywright(
    page
      .getByRole("button", {
        name: "Activar Pro",
      })
      .click()
  );
  const submitted = yield* fromPlaywright(submission);
  expect(submitted.status()).toBe(ok);
  const submissionBody: unknown = yield* fromPlaywright(submitted.json());
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
        page.request.get(`${api}/web/subscription/billing-attempts/${billingAttemptId}`, {
          headers: {
            origin: "https://127.0.0.1:4173",
          },
        })
      );
      expect(settled.status()).toBe(ok);
      expect(yield* fromPlaywright(settled.json())).toMatchObject({
        status: "succeeded",
      });
      const standing = yield* fromPlaywright(
        page.request.get(`${api}/subscription/status`, {
          headers: {
            origin: "https://127.0.0.1:4173",
          },
        })
      );
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

test("tokenizes a first card outside Fidy and enrolls through real public and Core routes", ({
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
      yield* fromPlaywright(page.goto("/upgrade"));
      yield* fromPlaywright(
        page
          .getByRole("button", {
            name: "Elegir mensual",
          })
          .click()
      );
      yield* fromPlaywright(expect(page.getByLabel("Número de tarjeta")).toBeVisible());
      yield* fromPlaywright(page.getByLabel("Número de tarjeta").fill(cardNumber));
      yield* fromPlaywright(page.getByLabel("Vencimiento").fill("122028"));
      yield* fromPlaywright(page.getByLabel("CVC").fill("123"));
      yield* fromPlaywright(page.getByLabel("Nombre en la tarjeta").fill("Usuario Prueba"));
      yield* fromPlaywright(page.getByLabel(/Acepto el reglamento/iu).check());
      yield* fromPlaywright(page.getByLabel(/Autorizo el tratamiento/iu).check());
      const submitResponse = page.waitForResponse(
        (response) => response.url() === `${api}/web/subscription/payment-enrollments/submit`
      );
      yield* fromPlaywright(
        page
          .getByRole("button", {
            name: "Activar Pro",
          })
          .click()
      );
      const submitted = yield* fromPlaywright(submitResponse);
      expect(submitted.status()).toBe(ok);
      expect(yield* fromPlaywright(submitted.json())).toMatchObject({
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
  send: "https://sandbox.wompi.co/fidy-synthetic-daviplata/send",
  confirm: "https://sandbox.wompi.co/fidy-synthetic-daviplata/confirm",
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
// Intercepted synthetic replies do not prove real Wompi merchant activation or browser CORS.
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
  yield* fromPlaywright(page.goto("/upgrade"));
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
  expect(yield* fromPlaywright(submitted.json())).toMatchObject({
    status: "payment-pending",
    billingAttempt: { status: "pending" },
  });
});

test("authorizes DaviPlata directly in the built browser and grants paid Pro only after real Core collection", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* fromPlaywright(signInFirstDaviplataThroughCore({ page, request }));
      const providerCalls: Array<DaviplataFixtureStep> = [];
      const fidyBodies: Array<ObservedFidyBody> = [];
      captureDaviplataFidyBodies(page, fidyBodies);
      yield* fromPlaywright(installDaviplataProviderRoutes(page, providerCalls));
      yield* submitFirstDaviplata(page);
      const beforeCollection = yield* fromPlaywright(
        page.request.get(`${api}/subscription/status`, {
          headers: { origin: "https://127.0.0.1:4173" },
        })
      );
      expect(beforeCollection.status()).toBe(ok);
      expect(yield* fromPlaywright(beforeCollection.json())).toMatchObject({
        data: { accessTier: "free", paidSubscription: null },
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
        page.request.get(`${api}/subscription/status`, {
          headers: { origin: "https://127.0.0.1:4173" },
        })
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
  yield* fromPlaywright(page.goto("/settings/pats"));
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
        name: "30 días",
      })
      .click()
  );
  yield* fromPlaywright(
    page
      .getByRole("button", {
        name: "Revisar token",
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
      page.getByRole("heading", {
        name: "Agente de casa",
      })
    ).toBeVisible()
  );
  yield* fromPlaywright(
    page
      .locator('[data-slot="card"]')
      .filter({
        has: page.getByRole("heading", {
          name: "Agente de casa",
        }),
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
      const readOnly = yield* fromPlaywright(
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
        })
      );
      expect(readOnly.status()).toBe(forbidden);
      yield* revokeReadOnlyPat(page, request, bearer);
    })
  ));
