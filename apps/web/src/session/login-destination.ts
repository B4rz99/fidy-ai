import { Option, Schema } from "effect";
import {
  ConnectionAttemptReference,
  OAuthRequestId,
  PATPairingPublicCode,
  ProviderHandoffSearch,
} from "@/transport/client";

export const LoginSearch = Schema.Struct({
  ...ProviderHandoffSearch.fields,
  resume: Schema.optionalKey(Schema.Literals(["pat", "account"])),
  cliCode: Schema.optionalKey(PATPairingPublicCode),
  oauthRequest: Schema.optionalKey(OAuthRequestId),
  oauthOperation: Schema.optionalKey(OAuthRequestId),
  connectionAttempt: Schema.optionalKey(ConnectionAttemptReference),
});

export const destinationAfterLogin = (input: unknown): string => {
  const search = Schema.decodeUnknownOption(LoginSearch)(input);
  if (Option.isNone(search)) return "/app/transactions";
  const requested = search.value;
  if (requested.resume === "pat") return "/settings/access?resume=pat";
  if (requested.resume === "account") return "/settings/account";
  if (requested.cliCode !== undefined) {
    return `/connect/cli?cliCode=${encodeURIComponent(requested.cliCode)}`;
  }
  if (requested.oauthOperation !== undefined) {
    return `/oauth/operation/${encodeURIComponent(requested.oauthOperation)}`;
  }
  if (requested.oauthRequest !== undefined) {
    return `/oauth/review/${encodeURIComponent(requested.oauthRequest)}`;
  }
  if (requested.connectionAttempt !== undefined) {
    return `/connections/continue?attempt=${encodeURIComponent(requested.connectionAttempt)}`;
  }
  return "/app/transactions";
};
