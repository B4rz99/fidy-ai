import { SecureRandom } from "effect/crypto";
import { Effect } from "effect";

export const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });
const workerSecureRandom = SecureRandom.make((size) =>
  crypto.getRandomValues(new Uint8Array(size))
);
export const uuid = (): string => Effect.runSync(workerSecureRandom.uuidV4().pipe(Effect.orDie));
export const json = ({
  body,
  status,
  headers,
}: Readonly<{ body: object; status: number; headers: HeadersInit }>): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return Response.json(body, { status, headers: responseHeaders });
};
export const invalid = (): Response =>
  Response.json(
    {
      error: {
        code: "pairing_invalid",
        message: "Esta vinculación ya no es válida. Inicia de nuevo.",
      },
    },
    { status: 400 }
  );
export const unavailable = (): Response =>
  Response.json({ status: "unavailable" }, { status: 503 });
export const noSession = (): Response =>
  Response.json(
    {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    { status: 401 }
  );
