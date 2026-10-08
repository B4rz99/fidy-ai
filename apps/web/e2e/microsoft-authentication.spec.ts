import { playwright } from "./playwright-runtime";
import {
  denialAndCancellationJourney,
  signupJourney,
  whatsappAssociationJourney,
} from "./provider-authentication.journeys";

const configuration = {
  provider: "microsoft",
  label: "Microsoft",
  authorizationPattern: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize**",
  selectFromPublicSite: true,
} as const;
playwright.test(
  "creates a User from the public site with Microsoft, saves recovery, and persists the session",
  ({ page, context, request }) => signupJourney({ configuration, page, context, request })
);
playwright.test(
  "denial and cancellation never claim successful signup or enter the authenticated app",
  ({ page, context, request }) =>
    denialAndCancellationJourney({ configuration, page, context, request })
);
// The shared controller's lost response, pending redemption and popup refusal are covered
// by Google journeys. Microsoft keeps its provider-specific success, denial and chat handoff.

for (const existing of [false, true]) {
  playwright.test(
    `WhatsApp provider handoff confirms the originating chat and ${existing ? "initially links a web-created User" : "creates a new User with recovery"}`,
    ({ page, context, request }) =>
      whatsappAssociationJourney({ configuration, page, context, request, existing })
  );
}
