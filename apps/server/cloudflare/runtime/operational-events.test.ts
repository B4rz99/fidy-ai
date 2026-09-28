import { expect, it } from "vitest";
import { projectOperationalEvents } from "./operational-events";

it("projects only finite outcomes and drops hostile tail payload fields", () => {
  const projected = projectOperationalEvents([
    {
      outcome: "exception",
      eventTimestamp: 1_000_000,
      scriptName: "private-user-123",
      exceptions: [{ message: "secret" }],
    },
    {
      outcome: "exceededCpu",
      eventTimestamp: 1_000_000,
      event: { request: { url: "https://api.fidyapp.com/secret?token=private" } },
    },
    {
      outcome: "ok",
      eventTimestamp: 1_000_000,
      event: {
        request: { url: "https://api.fidyapp.com/providers/kapso/callback?userId=private" },
        response: { status: 401 },
      },
    },
    {
      outcome: "ok",
      eventTimestamp: 1_000_000,
      event: {
        request: { url: "https://api.fidyapp.com/not-a-callback?userId=private" },
        response: { status: 401 },
      },
    },
    {
      outcome: "exception",
      eventTimestamp: "bad",
      event: { request: { url: "https://api.fidyapp.com/other" } },
    },
  ]);
  expect(projected).toEqual([
    { kind: "worker_exception", bucketMs: 960_000 },
    { kind: "resource_limit", bucketMs: 960_000 },
    { kind: "callback_rejection", bucketMs: 960_000 },
  ]);
  expect(JSON.stringify(projected)).not.toContain("private");
});
