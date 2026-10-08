import { expect, it } from "vitest";
import { Option } from "effect";
import { ConnectionBrowserApi } from "./contract";
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
