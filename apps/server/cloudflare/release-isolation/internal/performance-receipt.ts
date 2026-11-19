import { Effect } from "effect";
import { Hex } from "effect/encoding";
import { installedOrigins } from "../../../src/shell/browser-transport/contract";
import type { AcceptanceEnvironment, Coordinates, SealedTransactionReceipt } from "../contract";
import {
  AcceptanceProofUnavailable,
  acceptanceApiHeader,
  performanceReceiptPath,
} from "../contract";
import { verifyRequest } from "./request-proof";

export const isPerformanceReceipt = (request: Request): boolean => {
  const url = new URL(request.url);
  return request.method === "POST" && url.pathname + url.search === performanceReceiptPath;
};

const boundHeader = (request: Request): boolean =>
  !request.headers.has("authorization") &&
  ["cookie", "fidy-session-binding"].every((name) => request.headers.has(name)) &&
  request.headers.get("content-type") === "application/json";
export const receiptAdmitted = (input: {
  request: Request;
  environment: AcceptanceEnvironment;
  boundary: "ingress" | "core";
  now: number;
}): Effect.Effect<boolean> => {
  const { request, environment, boundary } = input,
    api = installedOrigins.acceptance;
  const address =
    boundary === "ingress" ? new URL(request.url).origin : request.headers.get(acceptanceApiHeader);
  return isPerformanceReceipt(request) &&
    boundHeader(request) &&
    environment.BROWSER_ORIGIN === api.browser &&
    request.headers.get("origin") === api.browser &&
    address === api.api
    ? verifyRequest(input)
    : Effect.succeed(false);
};
const bytes = new TextEncoder();
const hex = (data: ArrayBuffer): string => Hex.encode(new Uint8Array(data));
const unhex = (text: string): Uint8Array<ArrayBuffer> => {
  const value = Hex.decode(text);
  if (value._tag === "Failure") throw new Error("Invalid sealed receipt");
  return Uint8Array.from(value.success);
};
const context = (coordinates: Coordinates): string =>
  JSON.stringify([
    "fidy-2259-native-provenance-v1",
    coordinates.nativeRevision,
    coordinates.member,
    coordinates.resourcePrefix,
    coordinates.nativeManifestDigest,
    coordinates.sessionBindingSha256,
  ]);
const crypt = <A>(operation: () => Promise<A>): Effect.Effect<A, AcceptanceProofUnavailable> =>
  Effect.tryPromise({ try: operation, catch: () => new AcceptanceProofUnavailable() });

const boxKey = Effect.fnUntraced(function* (secret: string, coordinates: Coordinates) {
  const main = yield* crypt(() =>
    crypto.subtle.importKey("raw", bytes.encode(secret), "HKDF", false, ["deriveKey"])
  );
  return yield* crypt(() =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: bytes.encode(context(coordinates)),
        info: bytes.encode("closed-receipt-encryption"),
      },
      main,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    )
  );
});
const ecdsa = { name: "ECDSA", namedCurve: "P-256" };
const signed = (coordinates: Coordinates, iv: string, sealed: string): Uint8Array<ArrayBuffer> =>
  bytes.encode(JSON.stringify([context(coordinates), iv, sealed]));

export const sealTransactionReceipt = Effect.fn(function* (input: {
  secret: string;
  privateKey: string;
  coordinates: Coordinates;
  data: string;
}) {
  const { secret, privateKey, coordinates, data } = input;
  const box = yield* boxKey(secret, coordinates);
  const signer = yield* crypt(() =>
    crypto.subtle.importKey("pkcs8", unhex(privateKey), ecdsa, false, ["sign"])
  );
  const ivBytes = 12;
  const iv = crypto.getRandomValues(new Uint8Array(ivBytes));
  const sealed = hex(
    yield* crypt(() =>
      crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: bytes.encode(context(coordinates)) },
        box,
        bytes.encode(data)
      )
    )
  );
  const ivHex = Hex.encode(iv);
  const signature = hex(
    yield* crypt(() =>
      crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        signer,
        signed(coordinates, ivHex, sealed)
      )
    )
  );
  return { ...coordinates, iv: ivHex, sealed, signature };
});
export const openTransactionReceipt = Effect.fn(function* ({
  secret,
  publicKey,
  value,
}: {
  secret: string;
  publicKey: string;
  value: typeof SealedTransactionReceipt.Type;
}) {
  const verifier = yield* crypt(() =>
    crypto.subtle.importKey("spki", unhex(publicKey), ecdsa, false, ["verify"])
  );
  const verified = yield* crypt(() =>
    crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifier,
      unhex(value.signature),
      signed(value, value.iv, value.sealed)
    )
  );
  if (!verified) return yield* new AcceptanceProofUnavailable();
  const box = yield* boxKey(secret, value);
  const raw = yield* crypt(() =>
    crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unhex(value.iv), additionalData: bytes.encode(context(value)) },
      box,
      unhex(value.sealed)
    )
  );
  return new TextDecoder().decode(raw);
});
