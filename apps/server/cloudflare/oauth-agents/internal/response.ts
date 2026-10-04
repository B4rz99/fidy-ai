/** One owner-private policy for metadata-safe bootstrap responses. */
export const oauthResponse = (input: Readonly<{ body: object; status: number }>): Response =>
  Response.json(input.body, {
    status: input.status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
