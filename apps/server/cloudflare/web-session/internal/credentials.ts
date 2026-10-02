import { Option, Schema } from "effect";
import { WebSessionBearer } from "../../../src/core/web-session/reference";

const cookieName = "__Host-fidy_session=";

export const sessionCookie = (request: Request): Option.Option<WebSessionBearer> => {
  const cookies =
    request.headers
      .get("cookie")
      ?.split(";")
      .map((value) => value.trim()) ?? [];
  const selected = cookies.filter((cookie) => cookie.startsWith(cookieName));
  if (selected.length !== 1) return Option.none();
  return Schema.decodeUnknownOption(WebSessionBearer)(selected[0]?.slice(cookieName.length));
};

export const sessionDigest = (value: WebSessionBearer): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((digest) => new Uint8Array(digest));

export const sessionSetCookie = (token: string): string =>
  `__Host-fidy_session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`;
