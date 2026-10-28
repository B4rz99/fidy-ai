import { Option, Schema } from "effect";
import {
  ConnectionAttemptReference,
  OAuthRequestId,
  PATPairingPublicCode,
  ProviderHandoffSearch,
} from "@/transport/client";

export const LoginSearch = Schema.Struct({
  ...ProviderHandoffSearch.fields,
  resume: Schema.optionalKey(Schema.Literals(["pat", "account", "access"])),
  cliCode: Schema.optionalKey(PATPairingPublicCode),
  oauthRequest: Schema.optionalKey(OAuthRequestId),
  connectionAttempt: Schema.optionalKey(ConnectionAttemptReference),
});
const resumeDestinations = {
  pat: "/settings/access?resume=pat",
  account: "/settings/account",
  access: "/settings/access",
} as const;

export const destinationAfterLogin = (input: unknown): string => {
  const search = Schema.decodeUnknownOption(LoginSearch)(input);
  if (Option.isNone(search)) return "/app/transactions";
  const requested = search.value;
  if (requested.resume !== undefined) return resumeDestinations[requested.resume];
  if (requested.cliCode !== undefined) {
    return `/connect/cli?cliCode=${encodeURIComponent(requested.cliCode)}`;
  }
  if (requested.oauthRequest !== undefined) {
    return `/oauth/review/${encodeURIComponent(requested.oauthRequest)}`;
  }
  if (requested.connectionAttempt !== undefined) {
    return `/connections/continue?attempt=${encodeURIComponent(requested.connectionAttempt)}`;
  }
  return "/app/transactions";
};
