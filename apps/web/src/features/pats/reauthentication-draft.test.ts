// @vitest-environment jsdom

import { Option } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { PATLifetimeDays, PATRecipientLabel, PATScopes } from "@/transport/client";
import { preservePATDraft, resumePATDraft } from "./reauthentication-draft";

const userId = "10000000-0000-4000-8000-000000000001";
const draft = {
  recipientLabel: PATRecipientLabel.make("Accesos QA"),
  scopes: PATScopes.make(["read"]),
  lifetimeDays: PATLifetimeDays.make(7),
};
afterEach(() => {
  window.sessionStorage.clear();
  vi.useRealTimers();
});
it("restores only grant choices once for the same authenticated User", () => {
  expect(preservePATDraft({ userId, draft })).toBe(true);
  expect(resumePATDraft(userId)).toEqual(Option.some(draft));
  expect(resumePATDraft(userId)).toEqual(Option.none());
});
it("discards drafts on account replacement and after the bounded handoff", () => {
  preservePATDraft({ userId, draft });
  expect(resumePATDraft("10000000-0000-4000-8000-000000000002")).toEqual(Option.none());
  expect(resumePATDraft(userId)).toEqual(Option.none());
  vi.useFakeTimers();
  preservePATDraft({ userId, draft });
  vi.advanceTimersByTime(20 * 60 * 1000);
  expect(resumePATDraft(userId)).toEqual(Option.none());
});
it("discards malformed storage without granting or throwing", () => {
  window.sessionStorage.setItem("fidy:pat-identity-confirmation", "invalid");
  expect(resumePATDraft(userId)).toEqual(Option.none());
});
