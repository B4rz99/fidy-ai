import { expect, it } from "@effect/vitest";
import { DateTime, Option, Schema } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import { UserId } from "~/core/identity/reference";
import { TranscriptEntry, TranscriptTurnId } from "~/core/transcript/model";
import { HostedAgentSessionId } from "~/core/transcript/reference";
import { type SessionTranscriptEntry, assembleWorkingContext } from "./working-context";

const userA = UserId.make("f1d1a000-0000-4000-8000-000000000281");
const userB = UserId.make("f1d1a000-0000-4000-8000-000000000282");
const oldTurn = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000283");
const activeTurn = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000284");
const sessionA = HostedAgentSessionId.make("f1d1a000-0000-4000-8000-000000000285");
const sessionOld = HostedAgentSessionId.make("f1d1a000-0000-4000-8000-000000000286");
const now = DateTime.makeUnsafe("2026-09-25T12:00:00Z");
const entry = (text: string, turnId = oldTurn): TranscriptEntry =>
  Schema.decodeSync(TranscriptEntry)({
    _tag: "UserTranscriptEntry",
    id: "f1d1a000-0000-4000-8000-000000000287",
    turnId,
    occurredAt: "2026-09-25T12:00:00Z",
    text,
  });
const retained = (
  text: string,
  sequence: bigint,
  overrides: Partial<SessionTranscriptEntry> = {}
): SessionTranscriptEntry => ({
  userId: userA,
  sessionId: sessionA,
  sequence,
  entry: entry(text),
  ...overrides,
});

it("orders exact current-session evidence while excluding prior sessions, another User and the active request", () => {
  const result = assembleWorkingContext({
    sessionId: sessionA,
    userId: userA,
    activeTurnId: activeTurn,
    user: {
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: IanaTimeZone.make("America/Bogota"),
    },
    startedAt: now,
    memories: [{ text: "current Memory" }],
    compactedConversation: Option.some({
      sessionId: sessionA,
      userId: userA,
      text: "current continuity",
    }),
    transcript: [
      retained("second", 5n),
      retained("prior session", 1n, { sessionId: sessionOld }),
      retained("other User", 2n, { userId: userB }),
      retained("first", 3n),
      retained("active text", 6n, { entry: entry("active text", activeTurn) }),
    ],
    activeRequest: "active text",
  });
  expect(result.activeRequest).toEqual({ _tag: "Present", text: "active text" });
  expect(result.sections.map((section) => section._tag)).toEqual([
    "AssistantPolicy",
    "TurnStarted",
    "ContinuityBoundary",
    "Memory",
    "CompactedConversation",
    "Transcript",
    "Transcript",
    "ContinuityBoundary",
  ]);
  expect(
    result.sections.flatMap((section) =>
      section._tag === "Transcript" && section.entry._tag === "UserTranscriptEntry"
        ? [section.entry.text]
        : []
    )
  ).toEqual(["first", "second"]);
});

it("does not load an old or foreign CompactedConversation into a new session", () => {
  const base = {
    sessionId: sessionA,
    userId: userA,
    activeTurnId: activeTurn,
    user: {
      serviceMarket: "CO" as const,
      locale: "es-CO" as const,
      timeZone: IanaTimeZone.make("America/Bogota"),
    },
    startedAt: now,
    memories: [],
    transcript: [],
    activeRequest: "hola",
  };
  for (const scope of [
    { userId: userA, sessionId: sessionOld },
    { userId: userB, sessionId: sessionA },
  ]) {
    const result = assembleWorkingContext({
      ...base,
      compactedConversation: Option.some({ ...scope, text: "private" }),
    });
    expect(result.sections.some((section) => section._tag === "CompactedConversation")).toBe(false);
  }
});
