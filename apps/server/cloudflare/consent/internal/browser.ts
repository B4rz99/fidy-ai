const unauthenticatedStatus = 401;

export const consentResponse = (status: number): Response =>
  Response.json(
    {
      error: { code: status === unauthenticatedStatus ? "unauthenticated" : "consent_unavailable" },
    },
    {
      status,
      headers: { "cache-control": "no-store" },
    }
  );
