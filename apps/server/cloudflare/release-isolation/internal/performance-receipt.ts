import { Effect, Schema } from "effect";
import { Hex } from "effect/encoding";
import { installedOrigins } from "../../../src/shell/browser-transport/contract";
import type { AcceptanceEnvironment } from "../contract";
import { acceptanceApiHeader } from "../contract";
import { verifyRequest } from "./request-proof";

export const performanceReceiptPath =
  "/internal/release-smoke?acceptance=transaction-fixture&cohort=performance&ordinal=1";
export const isPerformanceReceipt = (request: Request): boolean => {
  const url = new URL(request.url);
  return request.method === "POST" && url.pathname + url.search === performanceReceiptPath;
};

const sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const ReceiptRequest = Schema.Struct({
  resourcePrefix: Schema.String.check(Schema.isPattern(/^fidy-2259-[a-f0-9]{12}$/u)),
  nativeManifestDigest: sha,
});
const coordinates = Schema.Struct({
  ...ReceiptRequest.fields,
  nativeRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  member: Schema.Literal("performance-1"),
  sessionBindingSha256: sha,
});
export type Coordinates = typeof coordinates.Type;
export const SealedTransactionReceipt = Schema.Struct({
  ...coordinates.fields,
  iv: Schema.String.check(Schema.isPattern(/^[a-f0-9]{24}$/u)),
  sealed: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{2}){16,24000}$/u)),
  signature: Schema.String.check(Schema.isPattern(/^[a-f0-9]{128}$/u)),
});
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
const boxKey = async (secret: string, coordinates: Coordinates): Promise<CryptoKey> => {
  const main = await crypto.subtle.importKey("raw", bytes.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
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
  );
};
const ecdsa = { name: "ECDSA", namedCurve: "P-256" };
const signed = (coordinates: Coordinates, iv: string, sealed: string): Uint8Array<ArrayBuffer> =>
  bytes.encode(JSON.stringify([context(coordinates), iv, sealed]));
export const sealTransactionReceipt = async (
  credentials: { secret: string; privateKey: string },
  coordinates: Coordinates,
  data: string
): Promise<typeof SealedTransactionReceipt.Type> => {
  const { secret, privateKey } = credentials;
  const box = await boxKey(secret, coordinates);
  const signer = await crypto.subtle.importKey("pkcs8", unhex(privateKey), ecdsa, false, ["sign"]);
  const ivBytes = 12;
  const iv = crypto.getRandomValues(new Uint8Array(ivBytes));
  const sealed = hex(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: bytes.encode(context(coordinates)) },
      box,
      bytes.encode(data)
    )
  );
  const ivHex = Hex.encode(iv);
  const signature = hex(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signer,
      signed(coordinates, ivHex, sealed)
    )
  );
  return { ...coordinates, iv: ivHex, sealed, signature };
};
export const openTransactionReceipt = async (
  secret: string,
  publicKey: string,
  value: typeof SealedTransactionReceipt.Type
): Promise<string> => {
  const verifier = await crypto.subtle.importKey("spki", unhex(publicKey), ecdsa, false, [
    "verify",
  ]);
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifier,
      unhex(value.signature),
      signed(value, value.iv, value.sealed)
    ))
  ) {
    throw new Error("Unauthenticated native fixture receipt");
  }
  const box = await boxKey(secret, value);
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unhex(value.iv), additionalData: bytes.encode(context(value)) },
    box,
    unhex(value.sealed)
  );
  return new TextDecoder().decode(raw);
};
