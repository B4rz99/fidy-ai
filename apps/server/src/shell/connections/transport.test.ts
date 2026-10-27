import { expect, it } from "vitest";
import { Option, Schema } from "effect";
import { ConnectionBrowserApi, ConnectionContinuationReview } from "./contract";
import { connectionBrowserTransport } from "./runtime";

it("recognizes each declared browser transport with its method and cookie-only forwarding", () => {
  for (const endpoint of Object.values(ConnectionBrowserApi.groups.connectionBrowser.endpoints)) {
    expect(connectionBrowserTransport(endpoint.path)).toEqual(
      Option.some({
        operation: endpoint.identifier,
        method: endpoint.method,
        forwardedHeaders: ["content-type", "cookie", "origin"],
      })
    );
  }
});

it("excludes canonical, foreign and malformed paths from browser continuation", () => {
  for (const path of [
    "/connections",
    "/web/connections/other",
    "/web/connections/begin/extra",
    "/web/connections/review/",
    "/web/connections/Review",
    "/web/connections/%72eview",
  ]) {
    expect(connectionBrowserTransport(path)).toEqual(Option.none());
  }
});

it("rejects contradictory handoff states and expiry beyond the original attempt", () => {
  const authorization = {
    url: "https://auth1-api-open-finance-sandbox.ambientesbc.com/auth?client_id=10000000-0000-4000-8000-000000000001&response_type=code&scope=accounts&request_uri=urn:ietf:params:oauth:request_uri:synthetic",
    expiresAt: "2026-10-27T12:01:00.000Z",
  };
  const base = {
    connection: {
      id: "12670000-0000-4000-8000-000000000001",
      institutionId: "bancolombia",
      state: "Connecting",
    },
    institutionName: "Bancolombia",
    expiresAt: "2026-10-27T12:10:00.000Z",
    authorization,
  };
  for (const phase of ["ready", "preparing", "failed"]) {
    expect(
      Option.isNone(Schema.decodeUnknownOption(ConnectionContinuationReview)({ ...base, phase }))
    ).toBe(true);
  }
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(ConnectionContinuationReview)({ ...base, phase: "prepared" })
    )
  ).toBe(true);
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(ConnectionContinuationReview)({
        ...base,
        phase: "prepared",
        authorization: { ...authorization, expiresAt: "2026-10-27T12:11:00.000Z" },
      })
    )
  ).toBe(true);
});
