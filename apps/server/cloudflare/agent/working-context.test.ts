import {
  HostedAgentSessionId,
  ProactiveInsightTranscriptEntry,
  type TranscriptEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  UserTranscriptEntry,
} from "../../src/core/agent/contract";
import { assert, expect, it } from "@effect/vitest";
import { DateTime, Option, Predicate } from "effect";
import { IanaTimeZone } from "../../src/core/_shared/context";
import { UserId } from "../../src/core/identity/contract";
import { InsightEventId } from "../../src/core/insights/contract";
import { type SessionTranscriptEntry, assembleWorkingContext } from "./internal/working-context";

const userA = UserId.make("f1d1a000-0000-4000-8000-000000000281");

const userB = UserId.make("f1d1a000-0000-4000-8000-000000000282");

const oldTurn = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000283");

const activeTurn = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000284");

const sessionA = HostedAgentSessionId.make("f1d1a000-0000-4000-8000-000000000285");

const sessionOld = HostedAgentSessionId.make("f1d1a000-0000-4000-8000-000000000286");

const now = DateTime.makeUnsafe("2026-09-25T12:00:00Z");

const entry = (text: string, turnId = oldTurn): TranscriptEntry =>
  UserTranscriptEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000287"),
    turnId,
    occurredAt: now,
    text: TranscriptText.make(text),
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
    channel: "web" as const,
    startedAt: now,
    memories: [{ text: "current Memory" }],
    proactiveReply: Option.none(),
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

  assert(Predicate.isTagged(result.activeRequest, "Present"));
  expect(result.activeRequest.text).toBe("active text");
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
      Predicate.isTagged(section, "Transcript") &&
      Predicate.isTagged(section.entry, "UserTranscriptEntry")
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
    channel: "web" as const,
    startedAt: now,
    memories: [],
    proactiveReply: Option.none(),
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

    expect(result.sections.some(Predicate.isTagged("CompactedConversation"))).toBe(false);
  }
});

it("a contextual proactive message remains same-User data, without inventing a requested Turn or prior session", () => {
  const proactive = ProactiveInsightTranscriptEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000288"),
    insightEventId: InsightEventId.make("f1d1a000-0000-4000-8000-000000000289"),
    occurredAt: now,
    text: TranscriptText.make("Tu resumen semanal: 12 COP."),
  });

  for (const owner of [userA, userB]) {
    const context = assembleWorkingContext({
      sessionId: sessionA,
      userId: userA,
      activeTurnId: activeTurn,
      user: { serviceMarket: "CO", locale: "es-CO", timeZone: IanaTimeZone.make("America/Bogota") },
      channel: "web" as const,
      startedAt: now,
      memories: [],
      compactedConversation: Option.none(),
      transcript: [],
      proactiveReply: Option.some({ userId: owner, entry: proactive }),
      activeRequest: "¿Qué significa este resumen?",
    });

    expect(
      context.sections.flatMap((section) =>
        Predicate.isTagged(section, "ProactiveReply") ? [section.entry] : []
      )
    ).toEqual(owner === userA ? [proactive] : []);
    expect(context.sections.some(Predicate.isTagged("Transcript"))).toBe(false);
  }
});
