import { browserSessionBindingHeader } from "~/shell/browser-transport/contract";
import { prepareBrowserMetadata as prepareMetadata, readMetadata } from "./internal/metadata";
import { bindingResponse } from "./internal/binding";
import { type Effect, Option, Schema } from "effect";
import { WebSessionId } from "../../src/core/web-session/contract";
import {
  type FreshSessionSubject,
  type WebSessionAuthority,
} from "../../src/shell/web-session/contract";
import { completePairing, logout } from "./internal/lifecycle";
import { currentUser } from "./internal/current-user";
import {
  type AuthenticatedWebSession,
  type BoundWebSessionLookup,
  type WebSessionAuthentication,
  type WebSessionEstablishment,
  type WebSessionRequest,
} from "./contract";
import {
  authenticate,
  decodeSessionLookup,
  observeEntry,
  prepareBrowserSessionLookup as prepareBrowserLookup,
  prepareBrowserEntryLookup as prepareEntryLookup,
  sessionDigestLookup,
} from "./internal/authentication";
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

export const prepareBoundCanonicalWebSession = (
  input: Readonly<{ request: Request; current: number }>
): Promise<Option.Option<BoundWebSessionLookup>> =>
  readBoundWebSessionProof(input.request).then(
    Option.map((proof) => boundSessionLookup({ ...proof, current: input.current }))
  );

export const resolveBoundCanonicalWebSession = (
  input: Readonly<{ lookup: BoundWebSessionLookup; row: unknown }>
): Option.Option<AuthenticatedWebSession> => decodeSessionLookup(input);

export const boundCanonicalWebSessionAuthority = (
  lookup: BoundWebSessionLookup
): WebSessionAuthority => lookup.authority;

export const authenticateWebSession = (
  input: WebSessionAuthentication
): Promise<Option.Option<AuthenticatedWebSession>> =>
  authenticate({ ...input, requireConsent: false, binding: Option.none() });

export const authenticateBoundWebSession = (
  input: WebSessionAuthentication
): Promise<Option.Option<AuthenticatedWebSession>> => {
  const binding = Schema.decodeUnknownOption(WebSessionId)(
    input.request.headers.get(browserSessionBindingHeader)
  );
  return Option.isNone(binding)
    ? Promise.resolve(Option.none())
    : authenticate({ ...input, requireConsent: false, binding });
};

export const logoutWebSession = (input: WebSessionRequest): Effect.Effect<Response, void> =>
  logout(input);

export const establishWebSession = (
  input: WebSessionEstablishment
): Effect.Effect<Response, void> => completePairing(input);

export const currentWebSessionUser = (input: WebSessionRequest): Effect.Effect<Response> =>
  currentUser(input);

export const readCurrentWebSessionMetadata = (
  input: Parameters<typeof readMetadata>[0]
): ReturnType<typeof readMetadata> => readMetadata(input);

export const browserSession = (
  input: WebSessionRequest & Readonly<{ input: Readonly<{ current: number; fresh: boolean }> }>
): Promise<Option.Option<FreshSessionSubject>> =>
  authenticate({
    ...inputWithFreshness(input),
    requireConsent: false,
    binding: Option.none(),
  }).then((session) =>
    Option.map(session, (subject) => ({ id: subject.id, user_id: subject.userId }))
  );

const inputWithFreshness = (
  input: WebSessionRequest & Readonly<{ input: Readonly<{ current: number; fresh: boolean }> }>
): WebSessionAuthentication => ({
  request: input.request,
  db: input.db,
  current: input.input.current,
  freshness: input.input.fresh ? "fresh" : "live",
});

export const freshBrowserSession = (
  input: WebSessionRequest & Readonly<{ current: number }>
): Promise<Option.Option<FreshSessionSubject>> =>
  browserSession({ ...input, input: { current: input.current, fresh: true } });

export const authenticateCanonicalWebSession = (
  input: WebSessionRequest & Readonly<{ current: number }>
): Promise<Option.Option<AuthenticatedWebSession>> =>
  authenticate({ ...input, freshness: "live", requireConsent: true, binding: Option.none() });

export const browserSessionBindingResponse = (
  input: WebSessionRequest
): Effect.Effect<Option.Option<Response>> => bindingResponse(input);

export const readWebSessionEntry = (
  input: Parameters<typeof observeEntry>[0]
): ReturnType<typeof observeEntry> => observeEntry(input);

export const prepareBrowserMetadata: typeof prepareMetadata = (input) => prepareMetadata(input);

export const prepareBrowserSessionLookup: typeof prepareBrowserLookup = (input) =>
  prepareBrowserLookup(input);

export const prepareBrowserEntryLookup: typeof prepareEntryLookup = (input) =>
  prepareEntryLookup(input);

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
