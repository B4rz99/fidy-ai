import type { APIRequestContext, APIResponse, Page, Response, Route } from "@playwright/test";
import type { Cause } from "effect";
import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { StartedBrowserLoginPairing } from "@fidy/server/client";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { playwright } from "./playwright-runtime";
import { advanceRefusedRequest, installAcceptanceClock } from "./acceptance-clock";

const { expect } = playwright;

const successStatus = 200;
const resourceLimitedStatus = 429;
const noContentStatus = 204;
const pairingTimeoutMilliseconds = 15_000;
const firstPollMilliseconds = 5_000;
const { api: apiOrigin, operator: operatorOrigin } = browserAcceptanceTopology();

/** The browser obtains a WebSession only from real Core redemption, never from a route mock. */
export const visiblePairingCode = (page: Page): Promise<string> =>
  page
    .getByText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u)
    .innerText()
    .then((code) => {
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
      return code;
    });

export const openBrowserLogin = (page: Page): Promise<void> =>
  page.goto("/login").then(() => undefined);

type BrowserFixture = Readonly<{ page: Page; request: APIRequestContext }>;
type SignInFixture = BrowserFixture &
  (Readonly<{ deferFreshEntry: true }> | Readonly<Record<never, never>>);
type ConsentRead = Readonly<{ status: number }>;
const consentReads = new WeakMap<Page, ConsentRead>();
const isConsentRead = (response: Response): boolean => {
  if (response.request().method() !== "GET") return false;
  const url = new URL(response.url());
  if (url.pathname === "/web/consent") return true;
  if (
    url.pathname !== "/web/session/binding" ||
    !["?context=application", "?context=transactions"].includes(url.search)
  ) {
    return false;
  }
  if (response.status() === resourceLimitedStatus) return true;
  if (response.status() !== successStatus) return false;
  // Startup's declared response is decoded before the UI publishes it. Chromium can discard a
  // redirecting document's response body, so this observer records the fresh read's status only.
  return true;
};
const observeConsentRead = (page: Page): Promise<ConsentRead> => {
  if (!consentReads.has(page)) {
    consentReads.set(page, { status: 0 });
    page.on("response", (response) => {
      if (isConsentRead(response)) consentReads.set(page, { status: response.status() });
    });
  }
  return page.waitForResponse(isConsentRead).then((response) => ({ status: response.status() }));
};
export const confirmConsentRead = ({
  page,
  first,
}: Readonly<{ page: Page; first: ConsentRead }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const maximumRetries = 12;
      for (let retry = 0; retry < maximumRetries; retry++) {
        const response = consentReads.get(page) ?? first;
        if (response.status !== resourceLimitedStatus) {
          expect(response.status).toBe(successStatus);
          return;
        }
        // A declared refusal can be followed by the client's bounded automatic retry.
        // Only use manual retry once the browser exposes it after that attempt finishes.
        const button = page.getByRole("button", { name: "Reintentar", exact: true });
        if (yield* Effect.tryPromise(() => button.isVisible())) {
          yield* Effect.tryPromise(() => button.click());
        }
        yield* Effect.sleep("1 second");
      }
      expect((consentReads.get(page) ?? first).status).toBe(successStatus);
    }).pipe(Effect.timeout("15 seconds"))
  );
export const navigateThroughConsent = ({
  page,
  navigate,
}: Readonly<{ page: Page; navigate: () => Promise<unknown> }>): Promise<void> => {
  const consent = observeConsentRead(page);
  return navigate()
    .then(() => consent)
    .then((response) => confirmConsentRead({ page, first: response }));
};

export const reloadTransactionsThroughCore = (page: Page): Promise<void> =>
  navigateThroughConsent({ page, navigate: () => page.reload() });

/** A declared temporary refusal requires the visible retry path, not another sign-in. */
export const openTransactionsThroughCore = (page: Page): Promise<void> =>
  navigateThroughConsent({ page, navigate: () => page.goto("/app/transactions") });

/** Upgrade checks Consent before requesting payment data; honor only explicit pressure refusals. */
export const openUpgradeThroughCore = (page: Page): Promise<void> =>
  navigateThroughConsent({ page, navigate: () => page.goto("/upgrade") });
type RecurringIdentity =
  | "recurringScopeInvalid"
  | "recurringScopeRestored"
  | "recurringScopeSchedule"
  | "recurringScope"
  | "recurringScopePartial"
  | "recurringScopeAdjusted"
  | "recurringCreation"
  | "recurringCreationReview"
  | "recurringCreationClosed"
  | "recurringCreationDraft"
  | "recurringCreationSchedule"
  | "recurringSuggestionsPending"
  | "recurringSuggestionsUpdating"
  | "recurringSearch"
  | "recurringSplitCapture"
  | "recurringCapture"
  | "recurringCaptureUncertain"
  | "recurringCaptureCurrency"
  | "recurringManagement"
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

const signInThroughBrowser = ({
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
      | "firstDaviplata"
      | "subscriptionReflow"
      | "dashboard"
      | "budget"
      | "budgetEditing"
      | "pagination"
      | "moneyInput"
      | "access"
      | "privacy"
      | "privacyRenewal"
      | "privacyErasure"
      | RecurringIdentity
      | NavigationFixture["identity"];
  }>): Promise<void> =>
  openBrowserLogin(page)
    .then(() => (clockMode === "controlled" ? installAcceptanceClock(page) : undefined))
    .then(() => page.getByRole("button", { name: "WhatsApp" }).click())
    .then(() => visiblePairingCode(page))
    .then((code) => request.post(`${operatorOrigin}/approve?code=${code}&${identity}=true`))
    .then((approval) => {
      expect(approval.status()).toBe(noContentStatus);
      const consent = observeConsentRead(page);
      const redemption = page.waitForResponse("**/web/pairings/redeem");
      return (
        clockMode === "controlled"
          ? page.clock.fastForward(firstPollMilliseconds)
          : Promise.resolve()
      )
        .then(() => redemption)
        .then((response) => {
          expect(response.status()).toBe(successStatus);
          return consent;
        });
    })
    .then((consent) =>
      expect(page)
        .toHaveURL(/\/app\/transactions$/u, { timeout: pairingTimeoutMilliseconds })
        .then(() =>
          clockMode === "controlled"
            ? page.clock.setSystemTime(Effect.runSync(Clock.currentTimeMillis))
            : undefined
        )
        .then(() => confirmConsentRead({ page, first: consent }))
    );

/** Feature prerequisites use the real public proof exchange; login journeys exercise its UI. */
const startSessionThroughCore = (
  input: Parameters<typeof signInThroughBrowser>[0]
): Promise<void> => {
  const { page, request, identity } = input;
  const headers = { origin: browserAcceptanceTopology().app };
  return (
    page.request
      .post(`${apiOrigin}/web/pairings`, { headers })
      .then((response) => {
        expect(response.status()).toBe(successStatus);
        return response.json();
      })
      .then(Schema.decodeUnknownPromise(Schema.toCodecJson(StartedBrowserLoginPairing)))
      .then((pairing) =>
        request
          .post(`${operatorOrigin}/approve?code=${pairing.publicCode}&${identity}=true`)
          .then((approval) => {
            expect(approval.status()).toBe(noContentStatus);
            return page.request.post(`${apiOrigin}/web/pairings/redeem`, {
              headers,
              data: {
                pairingId: pairing.pairingId,
                privateVerifier: Redacted.value(pairing.privateVerifier),
              },
            });
          })
      )
      .then((redemption) => {
        expect(redemption.status()).toBe(successStatus);
        return input.clockMode === "controlled" ? installAcceptanceClock(page) : undefined;
      })
      .then(() =>
        input.clockMode === "controlled" && "deferFreshEntry" in input
          ? undefined
          : openTransactionsThroughCore(page)
      )
      // Request-count and latency probes begin after prerequisite reads have settled.
      .then(() =>
        input.clockMode === "native-performance"
          ? expect(page.getByRole("button", { name: "+ Registrar", exact: true }))
              .toBeEnabled()
              .then(() => page.waitForLoadState("networkidle"))
          : undefined
      )
  );
};

const signInWithIdentity = (input: Parameters<typeof signInThroughBrowser>[0]): Promise<void> =>
  input.page
    .context()
    .cookies()
    .then((cookies) =>
      cookies.some((cookie) => cookie.name === "__Host-fidy_session")
        ? signInThroughBrowser(input)
        : startSessionThroughCore(input)
    );

const PairingPublicCode = Schema.Struct({ publicCode: Schema.String });
/** Capture the real upstream body independently of Chromium's document-scoped response cache. */
const retainPairingCode = (route: Route, pending: PromiseWithResolvers<string>): Promise<void> =>
  route
    .fetch()
    .then((response) =>
      response
        .json()
        .then(Schema.decodeUnknownPromise(PairingPublicCode))
        .then((pairing) =>
          route.fulfill({ response }).then(() => pending.resolve(pairing.publicCode))
        )
    )
    .then(undefined, (cause: unknown) => pending.reject(cause));
const beginVerifiedEmailPairing = (page: Page): Effect.Effect<string, Cause.UnknownError> =>
  Effect.gen(function* () {
    const pending = Promise.withResolvers<string>();
    const path = `${apiOrigin}/web/pairings`;
    const capture = (route: Route): Promise<void> =>
      route.request().method() === "POST" ? retainPairingCode(route, pending) : route.continue();
    yield* Effect.acquireRelease(
      Effect.tryPromise(() => page.route(path, capture)),
      () => Effect.tryPromise(() => page.unroute(path, capture)).pipe(Effect.orDie)
    );
    return yield* Effect.tryPromise(() =>
      Promise.all([
        pending.promise,
        page.getByRole("button", { name: "Enviar código" }).click(),
      ]).then(([code]) => code)
    );
  }).pipe(Effect.scoped);

/** Real public email pairing; the loopback fixture only delivers the synthetic proof. */
export const signInWithVerifiedEmailThroughCore = ({
  page,
  request,
  email,
}: BrowserFixture & Readonly<{ email: string }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installAcceptanceClock(page));
      yield* Effect.tryPromise(() => openBrowserLogin(page));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Correo verificado", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.getByLabel("Correo verificado").fill(email));
      const code = yield* beginVerifiedEmailPairing(page);
      yield* Effect.tryPromise(() => expect(page.getByLabel("Código del correo")).toBeVisible());
      const delivered = yield* Effect.tryPromise(() =>
        request.post(`${operatorOrigin}/email/login/deliver?code=${code}`)
      );
      expect(delivered.status()).toBe(noContentStatus);
      const proof = `${code}-JKLM-NPQR-STUV-WXYZ`;
      yield* Effect.tryPromise(() => page.getByLabel("Código del correo").fill(proof));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Confirmar y entrar" }).click()
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
  signInWithIdentity({ ...input, identity: "firstDaviplata", clockMode: "controlled" });

/** Signs in the seeded User with an available PaymentSource through real Core redemption. */
export const signInThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "primary", clockMode: "controlled" });

/** Signs in a separate User whose first Subscription must tokenize a new card. */
export const signInFirstCardThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "firstCard", clockMode: "controlled" });

/** Payment reflow starts with an unpaid User, independent of earlier successful collections. */
export const signInSubscriptionReflowThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "subscriptionReflow", clockMode: "controlled" });

/** Dashboard mutations have their own User so concurrent enrollment cannot reset its document. */
export const signInDashboardThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "dashboard", clockMode: "controlled" });
/** Budget mutations have their own User so they cannot change another journey's Widget data. */
export const signInBudgetThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "budget", clockMode: "controlled" });
/** Money entry mutations use their own User without changing another journey's history. */
export const signInMoneyInputThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "moneyInput", clockMode: "controlled" });

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

/** Calendar journeys retain native Date subclass construction across browser time zones. */
export const signInRecurringNativeClockThroughCore = (
  input: Omit<SignInFixture, "deferFreshEntry"> & Readonly<{ identity: RecurringIdentity }>
): Promise<void> => signInWithIdentity({ ...input, clockMode: "native-performance" });

type NavigationFixture = SignInFixture &
  Readonly<{
    identity:
      | "navigationOAuthLoading"
      | "navigationOAuthUnavailable"
      | "navigationOAuthSignedOut"
      | "navigationTransactions"
      | "navigationLoading"
      | "navigationConsent"
      | "navigationConsentRetry"
      | "navigationConsentRecovery"
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
/** Public proof exchange prepares the session; timing probes keep native clocks throughout. */
export const signInNavigationPerformanceThroughCore = (
  input: Omit<NavigationFixture, "deferFreshEntry">
): Promise<void> => signInWithIdentity({ ...input, clockMode: "native-performance" });

/** The clock guard retains the complete login UI and its native polling delay. */
export const signInNativeClockThroughCore = (
  input: Omit<NavigationFixture, "deferFreshEntry">
): Promise<void> => signInThroughBrowser({ ...input, clockMode: "native-performance" });

/** Budget editor journeys cannot race the Budget Widget's cap mutations. */
export const signInBudgetEditingThroughCore = (input: SignInFixture): Promise<void> =>
  signInWithIdentity({ ...input, identity: "budgetEditing", clockMode: "controlled" });
