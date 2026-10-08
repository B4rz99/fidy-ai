import { playwright } from "./playwright-runtime";
import {
  blockedPopupJourney,
  denialAndCancellationJourney,
  lostCompletionJourney,
  pendingRedemptionJourney,
  signupJourney,
  whatsappAssociationJourney,
} from "./provider-authentication.journeys";

const configuration = {
  provider: "google",
  label: "Google",
  authorizationPattern: "https://accounts.google.com/o/oauth2/v2/auth**",
  selectFromPublicSite: false,
} as const;
playwright.test(
  "creates a User from the public site with Google, saves recovery, and persists the session",
  ({ page, context, request }) => signupJourney({ configuration, page, context, request })
);
playwright.test(
  "denial and cancellation never claim successful signup or enter the authenticated app",
  ({ page, context, request }) =>
    denialAndCancellationJourney({ configuration, page, context, request })
);
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
