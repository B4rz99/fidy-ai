import { Cause, Option } from "effect";
import type { ProviderConfiguration } from "../contract";
import { providerConfiguration } from "./configuration";
import { ProviderVerificationFailure } from "./token-contract";
import type { AuthenticationProvider } from "../../../src/shell/provider-authentication/contract";

const redirectStatus = 303;
const maximumCodeLength = 4096;
export const validCode = (query: URLSearchParams): boolean => {
  const code = query.get("code") ?? "";
  return (
    !query.has("error") &&
    code.length > 0 &&
    code.length <= maximumCodeLength &&
    query.getAll("code").length === 1
  );
};
export const cookieVerifier = ({
  request,
  cookieName,
}: Readonly<{ request: Request; cookieName: string }>): Option.Option<string> => {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`));
  if (values.length !== 1) return Option.none();
  const value = values[0]?.slice(cookieName.length + 1) ?? "";
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? Option.some(value) : Option.none();
};
export const rejectionReason = (
  failure: unknown
): ProviderVerificationFailure["reason"] | "verification_failed" | "verification_timed_out" => {
  if (failure instanceof ProviderVerificationFailure) return failure.reason;
  return Cause.isTimeoutError(failure) ? "verification_timed_out" : "verification_failed";
};
export const callbackRedirect = ({
  environment,
  provider,
  clearCookie,
}: Readonly<{
  environment: ProviderConfiguration;
  provider: AuthenticationProvider;
  clearCookie: boolean;
}>): Response =>
  new Response(null, {
    status: redirectStatus,
    headers: {
      location: `${environment.BROWSER_ORIGIN}/auth/${provider}-return`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...(clearCookie
        ? {
            "set-cookie": `${providerConfiguration({ environment, provider }).cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          }
        : {}),
    },
  });
