import type { Duration } from "effect";

export const webSessionCookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: "strict",
  path: "/",
} as const;

export const initialWebSessionCookieOptions = {
  ...webSessionCookieOptions,
  maxAge: "30 days",
} as const;

export const renewedWebSessionCookieOptions = (
  maxAge: Duration.Duration
): typeof webSessionCookieOptions & Readonly<{ maxAge: Duration.Duration }> => ({
  ...webSessionCookieOptions,
  maxAge,
});
