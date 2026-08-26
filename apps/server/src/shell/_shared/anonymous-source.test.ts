import { expect, it } from "@effect/vitest";
import { Option } from "effect";
import { anonymousRequestSource } from "./anonymous-source";

const request = (input: {
  readonly remoteAddress: Option.Option<string>;
  readonly forwardedFor: Option.Option<string>;
}): Parameters<typeof anonymousRequestSource>[0] => ({
  remoteAddress: input.remoteAddress,
  headers: Option.match(input.forwardedFor, {
    onNone: () => ({}),
    onSome: (forwardedFor) => ({ "x-forwarded-for": forwardedFor }),
  }),
});

const source = (input: Parameters<typeof request>[0]): Option.Option<string> =>
  anonymousRequestSource(request(input));

const someRequest = (
  remoteAddress: string,
  forwardedFor: Option.Option<string>
): Option.Option<string> => source({ remoteAddress: Option.some(remoteAddress), forwardedFor });

it("uses a valid public peer directly and normalizes mapped IPv4", () => {
  expect(someRequest("203.0.113.9", Option.some("198.51.100.1"))).toEqual(
    Option.some("203.0.113.9")
  );
  expect(someRequest("::FFFF:203.0.113.10", Option.none())).toEqual(Option.some("203.0.113.10"));
});

it("rejects absent or malformed peer addresses", () => {
  expect(source({ remoteAddress: Option.none(), forwardedFor: Option.none() })).toEqual(
    Option.none()
  );
  expect(someRequest("not-an-ip", Option.none())).toEqual(Option.none());
});

it("requires valid forwarding metadata from trusted loopback and private IPv4 peers", () => {
  expect(someRequest("::1", Option.none())).toEqual(Option.none());
  expect(someRequest("127.0.0.1", Option.some("invalid"))).toEqual(Option.none());
  expect(someRequest("10.0.0.1", Option.some("198.51.100.2"))).toEqual(Option.some("198.51.100.2"));
  expect(someRequest("192.168.1.1", Option.some("198.51.100.3"))).toEqual(
    Option.some("198.51.100.3")
  );
  expect(someRequest("172.16.0.1", Option.some("198.51.100.4"))).toEqual(
    Option.some("198.51.100.4")
  );
});

it("accepts private IPv6 proxies and selects the final forwarded address", () => {
  expect(someRequest("fc00::1", Option.some("198.51.100.5, 2001:db8::5"))).toEqual(
    Option.some("2001:db8::5")
  );
  expect(someRequest("fd00::1", Option.some("::FFFF:198.51.100.6"))).toEqual(
    Option.some("198.51.100.6")
  );
  expect(someRequest("fe80::1", Option.some("198.51.100.7"))).toEqual(Option.some("198.51.100.7"));
});
