import { playwright } from "./playwright-runtime";
import {
  denialAndCancellationJourney,
  isolateProviderSource,
  signupJourney,
  whatsappAssociationJourney,
} from "./provider-authentication.journeys";

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
