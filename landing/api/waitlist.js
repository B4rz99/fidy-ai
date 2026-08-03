const allowedLocales = new Set(["en", "es"]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sendJson = (response, status, body) => {
  response.status(status).setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
};

const readConfig = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  return supabaseUrl && supabaseServiceRoleKey ? { supabaseUrl, supabaseServiceRoleKey } : null;
};

const parseBody = (request) => {
  const body = typeof request.body === "object" && request.body !== null ? request.body : {};
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const locale = allowedLocales.has(body?.locale) ? body.locale : "en";

  return emailPattern.test(email) ? { email, locale } : null;
};

const getFirstIp = (header) => (typeof header === "string" ? header.split(",")[0].trim() : null);

const getClientIp = (request) =>
  getFirstIp(request.headers?.["x-vercel-forwarded-for"]) ||
  getFirstIp(request.headers?.["x-forwarded-for"]) ||
  getFirstIp(request.headers?.["x-real-ip"]) ||
  "0.0.0.0";

const authHeaders = (supabaseServiceRoleKey) => ({
  apikey: supabaseServiceRoleKey,
  Authorization: `Bearer ${supabaseServiceRoleKey}`,
  "Content-Type": "application/json",
});

const checkRateLimit = ({ supabaseUrl, supabaseServiceRoleKey }, ip) =>
  fetch(`${supabaseUrl}/rest/v1/rpc/check_waitlist_rate_limit`, {
    method: "POST",
    headers: authHeaders(supabaseServiceRoleKey),
    body: JSON.stringify({
      p_ip: ip,
      p_window_key: new Date().toISOString().slice(0, 16),
      p_max_count: 5,
    }),
  });

const addWaitlistEmail = ({ supabaseUrl, supabaseServiceRoleKey }, body) =>
  fetch(`${supabaseUrl}/rest/v1/waitlist_emails?on_conflict=email_key`, {
    method: "POST",
    headers: {
      ...authHeaders(supabaseServiceRoleKey),
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
  });

const readRateLimit = async (config, ip) => {
  try {
    const response = await checkRateLimit(config, ip);
    if (!response.ok) return null;

    const data = await response.json();
    return typeof data?.[0]?.allowed === "boolean" ? data[0] : null;
  } catch {
    return null;
  }
};

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed" });
  }

  const config = readConfig();
  const body = parseBody(request);

  if (!config) {
    return sendJson(response, 500, { error: "Waitlist is not configured" });
  }

  if (!body) {
    return sendJson(response, 400, { error: "Invalid email" });
  }

  const rateLimit = await readRateLimit(config, getClientIp(request));

  if (rateLimit === null) {
    return sendJson(response, 502, { error: "Waitlist request failed" });
  }
  if (!rateLimit.allowed) {
    return sendJson(response, 429, { error: "Too many requests" });
  }

  const supabaseResponse = await addWaitlistEmail(config, body);

  if (supabaseResponse.ok) {
    return sendJson(response, 200, { ok: true });
  }

  return sendJson(response, 502, { error: "Waitlist request failed" });
};
