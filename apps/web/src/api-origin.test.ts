import { describe, expect, it } from "vitest";
import { parseApiOrigin } from "./api-origin";

describe("browser API origin", () => {
  it("accepts an explicit HTTP origin", () => {
    expect(parseApiOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(parseApiOrigin("https://api.fidyapp.com")).toBe("https://api.fidyapp.com");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["malformed", "not a url"],
    ["non-HTTP", "ftp://api.fidyapp.com"],
    ["credentials", "https://user@example.com"],
    ["path", "https://api.fidyapp.com/v1"],
    ["query", "https://api.fidyapp.com?preview=true"],
    ["fragment", "https://api.fidyapp.com#preview"],
  ])("fails closed for %s configuration", (_case, configured) => {
    expect(() => parseApiOrigin(configured)).toThrow("VITE_API_ORIGIN must be an HTTP origin");
  });
});
