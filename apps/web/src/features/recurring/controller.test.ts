import { expect, it } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { recurringWorkspaceQuery } from "./controller";

it("retains the prepared recurring display source across equivalent render inputs", () => {
  const client = makeFidyClient({ apiOrigin: "https://api.test.fidyapp.com" });
  const prepared = recurringWorkspaceQuery(client, { month: "2026-10", view: "compact" });
  const rendered = recurringWorkspaceQuery(client, { month: "2026-10", view: "compact" });
  expect(rendered.view).toBe(prepared.view);
  expect(rendered.source).toBe(prepared.source);
  expect(recurringWorkspaceQuery(client, { month: "2026-11", view: "compact" }).view).not.toBe(
    prepared.view
  );
});
