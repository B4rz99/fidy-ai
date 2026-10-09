import { playwright } from "./playwright-runtime";
import {
  blockedPopupJourney,
  denialAndCancellationJourney,
  disclosureRetryJourney,
  lostCompletionJourney,
  pendingRedemptionJourney,
  signupJourney,
  stalledProviderJourney,
  unavailablePairingJourney,
  whatsappAssociationJourney,
} from "./provider-authentication.journeys";

const configuration = {
  provider: "google",
  label: "Google",
  authorizationPattern: "https://accounts.google.com/o/oauth2/v2/auth**",
  recoverWithOperator: true,
  selectFromPublicSite: false,
} as const;
playwright.test(
  "an unavailable pairing response closes the popup and permits explicit signup retry",
  ({ page, context, request }) =>
    unavailablePairingJourney({ configuration, page, context, request })
);
playwright.test(
  "failed Consent loading can be retried without bypassing explicit acceptance",
  ({ page, context, request }) => disclosureRetryJourney({ configuration, page, context, request })
);
playwright.test(
  "closing the provider during a stalled status request preserves cancellation and allows retry",
  ({ page, context, request }) =>
    stalledProviderJourney({ configuration, page, context, request, outcome: "popup-close" })
);
for (const outcome of ["cancel", "timeout"] as const) {
  playwright.test(
    `a stalled status request permits ${outcome} and ignores its late response before retry`,
    ({ page, context, request }) =>
      stalledProviderJourney({ configuration, page, context, request, outcome })
  );
}
playwright.test(
  "creates a User from the public site with Google, saves recovery, and persists the session",
  ({ page, context, request }) => signupJourney({ configuration, page, context, request })
);
for (const intent of ["signup", "login"] as const) {
  playwright.test(
    `${intent} denial and cancellation reopen the provider directly without authenticating`,
    ({ page, context, request }) =>
      denialAndCancellationJourney({ configuration, page, context, request, intent })
  );
}
playwright.test(
  "a lost committed signup response directs sign-in and never rediscloses recovery",
  ({ page, context, request }) => lostCompletionJourney({ configuration, page, context, request })
);
playwright.test(
  "pending Browser Login redemption refuses access truthfully instead of remaining stuck",
  ({ page, context, request }) =>
    pendingRedemptionJourney({ configuration, page, context, request })
);

playwright.test(
  "a blocked popup sends no authentication mutation and permits restarting signup",
  ({ page, context, request }) => blockedPopupJourney({ configuration, page, context, request })
);

for (const existing of [false, true]) {
  playwright.test(
    `WhatsApp provider handoff confirms the originating chat and ${existing ? "initially links a web-created User" : "creates a new User with recovery"}`,
    ({ page, context, request }) =>
      whatsappAssociationJourney({ configuration, page, context, request, existing })
  );
}
