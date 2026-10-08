import type { AuthenticationProvider } from "../../../src/shell/provider-authentication/contract";
import { browserOrigins } from "../../runtime/contract";
import type { ProviderEnvironment } from "../contract";

const bindingNames = {
  google: {
    id: "GOOGLE_CLIENT_ID",
    secret: "GOOGLE_CLIENT_SECRET",
    redirect: "GOOGLE_REDIRECT_URI",
  },
  microsoft: {
    id: "MICROSOFT_CLIENT_ID",
    secret: "MICROSOFT_CLIENT_SECRET",
    redirect: "MICROSOFT_REDIRECT_URI",
  },
} as const;
const apiOrigins = new Map<string, string>([
  [browserOrigins.production, "https://api.fidyapp.com"],
  [browserOrigins.acceptance, "https://127.0.0.1:4174"],
  [browserOrigins.local, "http://localhost:8787"],
]);
export const providerConfiguration = ({
  environment,
  provider,
}: Readonly<{
  environment: ProviderEnvironment;
  provider: AuthenticationProvider;
}>): Readonly<{
  clientId: string;
  redirectUri: string;
  configured: boolean;
  cookieName: string;
}> => {
  const names = bindingNames[provider];
  const clientId = environment[names.id] ?? "";
  const secret = environment[names.secret] ?? "";
  const redirectUri = environment[names.redirect] ?? "";
  const origin = apiOrigins.get(environment.BROWSER_ORIGIN);
  return {
    clientId,
    redirectUri,
    configured:
      clientId.length > 0 &&
      secret.length > 0 &&
      origin !== undefined &&
      redirectUri === `${origin}/providers/${provider}/callback`,
    cookieName: `__Host-fidy_${provider}`,
  };
};
