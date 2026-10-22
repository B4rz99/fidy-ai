import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import type { Cause } from "effect";
import { Clock, Effect, Option, Schema } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { playwright } from "./playwright-runtime";
import {
  advanceRefusedRequest,
  installAcceptanceClock,
  installAcceptanceClockWithNativePerformance,
} from "./acceptance-clock";

const { expect } = playwright;

const successStatus = 200;
const resourceLimitedStatus = 429;
const noContentStatus = 204;
const pairingTimeoutMilliseconds = 15_000;
const firstPollMilliseconds = 5_000;
const operatorOrigin = browserAcceptanceTopology().operator;

/** The browser obtains a WebSession only from real Core redemption, never from a route mock. */
export const visiblePairingCode = (page: Page): Promise<string> =>
  page
    .locator('[aria-label^="Código de vinculación "]')
    .getAttribute("aria-label")
    .then((label) => {
      const code = label?.replace("Código de vinculación ", "") ?? "";
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
      return code;
    });

export const openBrowserLogin = (page: Page): Promise<void> =>
  page
    .goto("/login")
    .then(() => page.getByRole("button", { name: "WhatsApp o correo verificado" }).click());

type SignInFixture = Readonly<{ page: Page; request: APIRequestContext }>;
type ConsentRead = Readonly<{ status: number }>;
const observeConsentRead = (page: Page): Promise<ConsentRead> =>
  page
    .waitForResponse(
      (response) => response.url().endsWith("/web/consent") && response.request().method() === "GET"
    )
    .then((response) => ({ status: response.status() }));
const confirmConsentRead = (page: Page, first: ConsentRead): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      let response = first;
      const maximumRetries = 6;
      for (
        let retry = 0;
        response.status === resourceLimitedStatus && retry < maximumRetries;
        retry++
      ) {
        yield* Effect.sleep("1 second");
        const refreshed = observeConsentRead(page);
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Reintentar", exact: true }).click()
        );
        response = yield* Effect.tryPromise(() => refreshed);
      }
      expect(response.status).toBe(successStatus);
    }).pipe(Effect.timeout("15 seconds"))
  );
const navigateThroughConsent = (page: Page, navigate: () => Promise<unknown>): Promise<void> => {
  const consent = observeConsentRead(page);
  return navigate()
    .then(() => consent)
    .then((response) => confirmConsentRead(page, response));
};

export const reloadTransactionsThroughCore = (page: Page): Promise<void> =>
  navigateThroughConsent(page, () => page.reload());

/** A declared temporary refusal requires the visible retry path, not another sign-in. */
export const openTransactionsThroughCore = (page: Page): Promise<void> =>
  navigateThroughConsent(page, () => page.goto("/app/transactions"));

/** Upgrade checks Consent before requesting payment data; honor only explicit pressure refusals. */
export const openUpgradeThroughCore = (page: Page): Promise<void> =>
  navigateThroughConsent(page, () => page.goto("/upgrade"));
type RecurringIdentity =
  | "recurringStableReads"
  | "recurring"
  | "recurringSummary"
  | "recurringRecoveryUnavailable"
  | "recurringRecoveryMalformed"
  | "recurringRecoveryLimited"
  | "recurringRecoveryPressure"
  | "recurringEditing"
  | "recurringLifecycle"
  | "recurringTracking"
  | "recurringExceptions"
  | "recurringChat"
  | "recurringPagination";

const signInWithIdentity = ({
  page,
  request,
  identity,
  clockMode,
}: SignInFixture &
  Readonly<{
    clockMode: "controlled" | "native-performance";
    identity:
      | "primary"
      | "firstCard"
      | "dashboard"
      | "budget"
      | "budgetEditing"
      | "pagination"
      | "access"
      | "privacy"
      | "privacyRenewal"
      | "privacyErasure"
      | RecurringIdentity
      | "navigationTransactions"
      | "navigationLoading"
      | "navigationConsent"
      | "navigationBudget"
      | "navigationRecurring"
      | "navigationReviewBudget"
      | "navigationReviewTransactions"
      | "navigationClock"
      | "navigationDashboard";
  }>): Promise<void> =>
  openBrowserLogin(page)
    .then(() =>
      clockMode === "controlled"
        ? installAcceptanceClock(page)
        : installAcceptanceClockWithNativePerformance(page)
    )
    .then(() => page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click())
    .then(() => visiblePairingCode(page))
    .then((code) => request.post(`${operatorOrigin}/approve?code=${code}&${identity}=true`))
    .then((approval) => {
      expect(approval.status()).toBe(noContentStatus);
      const consent = observeConsentRead(page);
      const redemption = page.waitForResponse("**/web/pairings/redeem");
      return page.clock
        .fastForward(firstPollMilliseconds)
        .then(() => redemption)
        .then((response) => {
          expect(response.status()).toBe(successStatus);
          return consent;
        });
    })
    .then((consent) =>
      expect(page)
        .toHaveURL(/\/app\/transactions$/u, { timeout: pairingTimeoutMilliseconds })
        .then(() => page.clock.setSystemTime(Effect.runSync(Clock.currentTimeMillis)))
        .then(() => confirmConsentRead(page, consent))
    );

/** Real public email pairing; the loopback fixture only delivers the synthetic proof. */
export const signInWithVerifiedEmailThroughCore = ({
  page,
  request,
  email,
}: SignInFixture & Readonly<{ email: string }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installAcceptanceClock(page));
      yield* Effect.tryPromise(() => openBrowserLogin(page));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click()
      );
      const code = yield* Effect.tryPromise(() => visiblePairingCode(page));
      yield* Effect.tryPromise(() =>
        page.getByLabel("O accede con tu correo verificado").fill(email)
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Enviar código por correo" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Código recibido por correo")).toBeVisible()
      );
      const delivered = yield* Effect.tryPromise(() =>
        request.post(`http://127.0.0.1:4175/email/login/deliver?code=${code}`)
      );
      expect(delivered.status()).toBe(noContentStatus);
      const proof = `${code}-JKLM-NPQR-STUV-WXYZ`;
      yield* Effect.tryPromise(() => page.getByLabel("Código recibido por correo").fill(proof));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Aprobar este navegador" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page).toHaveURL(/\/app\/transactions$/u, { timeout: pairingTimeoutMilliseconds })
      );
      expect(page.url()).not.toContain(proof);
      expect(
        yield* Effect.tryPromise(() =>
          page.evaluate(() => localStorage.length + sessionStorage.length)
        )
      ).toBe(0);
    })
  );

/** Independent unfunded User: never switches or deletes the first-card User's retained history. */
export const signInFirstDaviplataThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithVerifiedEmailThroughCore({ ...input, email: "daviplata@example.com" });

/** Signs in the seeded User with an available PaymentSource through real Core redemption. */
export const signInThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "primary", clockMode: "controlled" });

/** Signs in a separate User whose first Subscription must tokenize a new card. */
export const signInFirstCardThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "firstCard", clockMode: "controlled" });

/** Dashboard mutations have their own User so concurrent enrollment cannot reset its document. */
export const signInDashboardThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "dashboard", clockMode: "controlled" });
/** Budget mutations have their own User so they cannot change another journey's Widget data. */
export const signInBudgetThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "budget", clockMode: "controlled" });
/** Independent retained history spanning more than one canonical page. */
export const signInPaginationThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "pagination", clockMode: "controlled" });

/** Independent metadata-only MCP continuation User; no usable OAuth grant is seeded. */
export const signInAccessThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "access", clockMode: "controlled" });

/** Direct acceptance probes latch the same public identity as a mounted browser client. */
export const browserSessionHeaders = (
  request: APIRequestContext
): Promise<Record<string, string>> =>
  request
    .get(`${browserAcceptanceTopology().api}/web/session/binding`, {
      headers: { origin: browserAcceptanceTopology().app },
    })
    .then((reply) => reply.json())
    .then((body: unknown) => {
      const identity = Schema.decodeUnknownSync(
        Schema.Struct({ binding: Schema.OptionFromNullOr(Schema.String) })
      )(body);
      return {
        origin: browserAcceptanceTopology().app,
        "Fidy-Session-Binding": Option.getOrElse(identity.binding, () => "none"),
      };
    });
export const boundSessionRequests = (
  request: APIRequestContext
): Pick<APIRequestContext, "get" | "post"> => ({
  get: (url, options) =>
    browserSessionHeaders(request).then((binding) =>
      request.get(url, { ...options, headers: { ...binding, ...options?.headers } })
    ),
  post: (url, options) =>
    browserSessionHeaders(request).then((binding) =>
      request.post(url, { ...options, headers: { ...binding, ...options?.headers } })
    ),
});

const canonicalRecoveryMilliseconds = 15_000;
const resourceProbeRetries = 6;
export const probeCanonicalRequest = ({
  request,
  send,
}: Readonly<{ request: APIRequestContext; send: () => Promise<APIResponse> }>): Effect.Effect<
  APIResponse,
  Cause.UnknownError | Cause.TimeoutError
> =>
  Effect.gen(function* () {
    for (let retry = 0; retry < resourceProbeRetries; retry++) {
      const response = yield* Effect.tryPromise(() => send());
      if (!(yield* Effect.tryPromise(() => advanceRefusedRequest({ request, response })))) {
        return response;
      }
    }
    return yield* Effect.tryPromise(() => send());
  }).pipe(Effect.timeout(canonicalRecoveryMilliseconds));

/** Independent expired-trial User for irreversible processing-withdrawal acceptance. */
export const signInPrivacyThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "privacy", clockMode: "controlled" });

/** Independent erasure identity keeps request pressure and terminal intent isolated from withdrawal journeys. */
export const signInPrivacyErasureThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "privacyErasure", clockMode: "controlled" });

/** Independent renewal identity keeps withdrawal isolated from parallel browser journeys. */
export const signInPrivacyRenewalThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "privacyRenewal", clockMode: "controlled" });

/** Each recurring journey has independent planning data and canonical admission limits. */
export const signInRecurringThroughCore = (
  input: SignInFixture &
    Readonly<{
      identity: RecurringIdentity;
    }>
): Promise<void> => signInWithIdentity({ ...input, clockMode: "controlled" });

type NavigationFixture = SignInFixture &
  Readonly<{
    identity:
      | "navigationTransactions"
      | "navigationLoading"
      | "navigationConsent"
      | "navigationBudget"
      | "navigationRecurring"
      | "navigationReviewBudget"
      | "navigationReviewTransactions"
      | "navigationClock"
      | "navigationDashboard";
  }>;
/** Navigation journeys own their User and retained data. */
export const signInNavigationThroughCore = (input: NavigationFixture): Promise<void> =>
  signInWithIdentity({ ...input, clockMode: "controlled" });
/** Timing probes preserve native performance while virtualizing polling and cooldowns. */
export const signInNavigationPerformanceThroughCore = (input: NavigationFixture): Promise<void> =>
  signInWithIdentity({ ...input, clockMode: "native-performance" });

/** Budget editor journeys cannot race the Budget Widget's cap mutations. */
export const signInBudgetEditingThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "budgetEditing", clockMode: "controlled" });
