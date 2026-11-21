import { browserSessionBindingHeader } from "~/shell/browser-transport/contract";
import { Option, Schema } from "effect";
import { WebSessionId } from "../../src/core/web-session/contract";
import { type AuthenticatedWebSession, type BoundWebSessionLookup } from "./contract";
import { decodeSessionLookup, sessionDigestLookup } from "./internal/authentication";
import {
  sessionCookie as nativeSessionCookie,
  sessionDigest as nativeSessionDigest,
  sessionSetCookie as nativeSessionSetCookie,
} from "./internal/credentials";

export const readBoundWebSessionProof = (
  request: Request
): Promise<Option.Option<{ binding: WebSessionId; digest: Uint8Array }>> => {
  const binding = Schema.decodeUnknownOption(WebSessionId)(
    request.headers.get(browserSessionBindingHeader)
  );

  const bearer = sessionCookie(request);

  if (Option.isNone(binding) || Option.isNone(bearer)) {
    return Promise.resolve(Option.none<{ binding: WebSessionId; digest: Uint8Array }>());
  }

  return sessionDigest(bearer.value).then((digest) =>
    Option.some({ digest, binding: binding.value })
  );
};

type BoundProof = Readonly<{ digest: Uint8Array; binding: WebSessionId; current: number }>;

const lookupBoundProof = (input: BoundProof, requireConsent: boolean): BoundWebSessionLookup =>
  sessionDigestLookup({
    ...input,
    binding: Option.some(input.binding),
    freshness: "live",
    requireConsent,
  });

export const boundSessionLookup = (input: BoundProof): BoundWebSessionLookup =>
  lookupBoundProof(input, true);

export const boundSecuritySessionLookup = (input: BoundProof): BoundWebSessionLookup =>
  lookupBoundProof(input, false);

export const resolveBoundCanonicalWebSession = (
  input: Readonly<{ lookup: BoundWebSessionLookup; row: unknown }>
): Option.Option<AuthenticatedWebSession> => decodeSessionLookup(input);

export const sessionSetCookie: typeof nativeSessionSetCookie = (...args) =>
  nativeSessionSetCookie(...args);

export const sessionCookie: typeof nativeSessionCookie = (...args) => nativeSessionCookie(...args);

export const sessionDigest: typeof nativeSessionDigest = (...args) => nativeSessionDigest(...args);

export const absentSessionResponse = (path: string): Response => {
  if (path === "/web/session/binding") {
    return Response.json({ binding: null }, { headers: { "cache-control": "no-store" } });
  }

  if (path === "/web/session/logout") {
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": "__Host-fidy_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        "cache-control": "no-store",
      },
    });
  }

  return Response.json(
    {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    { status: 401 }
  );
};
