import { playwright } from "./playwright-runtime";
import {
  denialAndCancellationJourney,
  duplicateProviderActionJourney,
  expiredAssociationJourney,
  isolateProviderSource,
  lateCompletionJourney,
  signupJourney,
  whatsappAssociationJourney,
  whatsappLinkSignupJourney,
} from "./provider-authentication.journeys";

playwright.test.describe.configure({ mode: "parallel" });

playwright.test.beforeEach(({ context }) => isolateProviderSource(context));

const configuration = {
  provider: "microsoft",
  label: "Microsoft",
  authorizationPattern: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize**",
  recoverWithOperator: false,
} as const;
playwright.test(
  "creates a User with Microsoft, saves recovery, and persists the session",
  ({ page, context, request }) => signupJourney({ configuration, page, context, request })
);
for (const intent of ["signup", "login"] as const) {
  playwright.test(
    `${intent} denial and cancellation reopen the provider directly without authenticating`,
    ({ page, context, request }) =>
      denialAndCancellationJourney({ configuration, page, context, request, intent })
  );
}

for (const existing of [false, true]) {
  playwright.test(
    `WhatsApp provider handoff confirms the originating chat and ${existing ? "initially links a web-created User" : "creates a new User with recovery"}`,
    ({ page, context, request }) =>
      whatsappAssociationJourney({ configuration, page, context, request, existing })
  );
}

playwright.test(
  "WhatsApp link signup accepts Consent in the browser and returns directly to the chat",
  ({ page, context, request }) =>
    whatsappLinkSignupJourney({ configuration, page, context, request })
);

playwright.test(
  "repeated provider actions in the opening gesture admit one popup and one attempt",
  ({ page, context, request }) =>
    duplicateProviderActionJourney({ configuration, page, context, request })
);

playwright.test(
  "association review cannot renew the original browser proof lifetime",
  ({ page, context, request }) =>
    expiredAssociationJourney({ configuration, page, context, request })
);

for (const outcome of ["cancel", "leave"] as const) {
  playwright.test(
    `a committed completion arriving after ${outcome} cannot restore recovery or redeem`,
    ({ page, context, request }) =>
      lateCompletionJourney({ configuration, page, context, request, outcome })
  );
}
