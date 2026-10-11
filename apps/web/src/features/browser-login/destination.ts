import { Option, Schema } from "effect";
import {
  ConnectionAttemptReference,
  OAuthRequestId,
  PATPairingPublicCode,
} from "@/transport/client";

/** Only canonical public references select the post-login destination. */
export const destinationAfterLogin = (search: unknown): string => {
  const requested = Schema.decodeUnknownOption(
    Schema.Struct({
      cliCode: Schema.OptionFromOptionalKey(PATPairingPublicCode),
      oauthRequest: Schema.OptionFromOptionalKey(OAuthRequestId),
      connectionAttempt: Schema.OptionFromOptionalKey(ConnectionAttemptReference),
    })
  )(search);
  if (Option.isNone(requested)) return "/app/transactions";
  const { cliCode, oauthRequest, connectionAttempt } = requested.value;
  if (Option.isSome(cliCode)) return `/connect/cli?cliCode=${encodeURIComponent(cliCode.value)}`;
  if (Option.isSome(oauthRequest)) return `/oauth/review/${encodeURIComponent(oauthRequest.value)}`;
  if (Option.isSome(connectionAttempt)) {
    return `/connections/continue?attempt=${encodeURIComponent(connectionAttempt.value)}`;
  }
  return "/app/transactions";
};
