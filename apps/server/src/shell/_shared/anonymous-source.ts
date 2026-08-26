import { isIP } from "node:net";
import { Option } from "effect";

const mappedIpv4Prefix = "::ffff:";

const normalizeAddress = (address: string): string =>
  address.toLowerCase().startsWith(mappedIpv4Prefix)
    ? address.slice(mappedIpv4Prefix.length)
    : address;

const isTrustedProxyAddress = (address: string): boolean => {
  const normalized = normalizeAddress(address);
  if (normalized === "::1" || normalized === "127.0.0.1") return true;
  if (normalized.startsWith("10.") || normalized.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./u.test(normalized)) return true;
  return (
    normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")
  );
};

const forwardedClientAddress = (header: Option.Option<string>): Option.Option<string> =>
  Option.flatMap(header, (value) => {
    const addresses = value.split(",").map((part) => normalizeAddress(part.trim()));
    if (addresses.some((address) => isIP(address) === 0)) return Option.none();
    return Option.fromUndefinedOr(addresses.at(-1));
  });

type AnonymousSourceRequest = Readonly<{
  remoteAddress: Option.Option<string>;
  headers: Readonly<Record<string, string>>;
}>;

/** Resolves an anonymous abuse-control key without trusting client-supplied forwarding metadata. */
export const anonymousRequestSource = (request: AnonymousSourceRequest): Option.Option<string> =>
  Option.flatMap(request.remoteAddress, (peerAddress) => {
    const peer = normalizeAddress(peerAddress);
    if (isIP(peer) === 0) return Option.none();
    if (!isTrustedProxyAddress(peer)) return Option.some(peer);
    return forwardedClientAddress(Option.fromUndefinedOr(request.headers["x-forwarded-for"]));
  });
