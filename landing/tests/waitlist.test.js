import { describe, expect, test } from "bun:test";

import handler from "../api/waitlist";

const makeResponse = () => ({
  statusCode: null,
  headers: {},
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  setHeader(name, value) {
    this.headers[name] = value;
    return this;
  },
  end(body = null) {
    this.body = body;
  },
});

const request = (email) => ({
  method: "POST",
  headers: { "x-forwarded-for": "203.0.113.7" },
  body: { email, locale: "en" },
});

describe("waitlist endpoint", () => {
  test("returns the same success response for new and duplicate emails", async () => {
    const fetchMock = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return calls.length % 2 === 1
        ? { ok: true, status: 200, json: async () => [{ allowed: true }] }
        : { ok: true, status: 201 };
    };
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

    try {
      const firstResponse = makeResponse();
      await handler(request("person@example.com"), firstResponse);
      const duplicateResponse = makeResponse();
      await handler(request("PERSON@example.com"), duplicateResponse);

      expect({ status: firstResponse.statusCode, body: firstResponse.body }).toEqual({
        status: 200,
        body: JSON.stringify({ ok: true }),
      });
      expect({ status: duplicateResponse.statusCode, body: duplicateResponse.body }).toEqual({
        status: 200,
        body: JSON.stringify({ ok: true }),
      });
      expect(calls).toHaveLength(4);
      expect(calls[0].url).toBe(
        "https://example.supabase.co/rest/v1/rpc/check_waitlist_rate_limit"
      );
      expect(calls[1].url).toBe(
        "https://example.supabase.co/rest/v1/waitlist_emails?on_conflict=email_key"
      );
      expect(calls[1].options.headers.Authorization).toBe("Bearer service-role-key");
      expect(calls[1].options.headers.Prefer).toBe("resolution=ignore-duplicates,return=minimal");
      expect(calls[1].options.body).toBe(
        JSON.stringify({ email: "person@example.com", locale: "en" })
      );
    } finally {
      globalThis.fetch = fetchMock;
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
  });

  test("returns a JSON error when the rate-limit service is unavailable", async () => {
    const fetchMock = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network unavailable");
    };
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

    try {
      const response = makeResponse();
      await handler(request("person@example.com"), response);

      expect(response.statusCode).toBe(502);
      expect(response.body).toBe(JSON.stringify({ error: "Waitlist request failed" }));
    } finally {
      globalThis.fetch = fetchMock;
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
  });

  test("rejects requests after the IP rate limit without writing", async () => {
    const fetchMock = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => [{ allowed: false }] };
    };
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

    try {
      const response = makeResponse();
      await handler(
        {
          ...request("blocked@example.com"),
          headers: {
            "x-vercel-forwarded-for": "203.0.113.7",
            "x-forwarded-for": "198.51.100.9",
          },
        },
        response
      );

      expect(response.statusCode).toBe(429);
      expect(response.body).toBe(JSON.stringify({ error: "Too many requests" }));
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0].options.body).p_ip).toBe("203.0.113.7");
    } finally {
      globalThis.fetch = fetchMock;
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
  });
});
