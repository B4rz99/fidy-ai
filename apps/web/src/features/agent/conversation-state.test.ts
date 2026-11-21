import { Option, Schema } from "effect";
import { expect, it } from "vitest";
import { HostedTurnProposal } from "@/transport/hosted-turn-client";
import {
  type Conversation,
  type HostedConversation,
  type SetConversation,
  presentHostedConversation,
} from "./conversation-state";

type Proposal = typeof HostedTurnProposal.Type;
const proposal = (confirmed: boolean): Proposal =>
  Schema.decodeSync(HostedTurnProposal)({
    text: "Voy a detener el seguimiento del plan recurrente «Netflix» ($45.900 COP al mes).",
    turnId: "24000000-0000-4000-8000-000000001350",
    receipt: "a".repeat(64),
    ...(confirmed ? { confirmation: { command: `CONFIRMAR ${"b".repeat(64)}` } } : {}),
  });

type Calls = { propose: number; progress: number; acknowledge: number };
type Mounted = Readonly<{
  view: () => HostedConversation;
  current: () => Conversation;
  calls: Calls;
}>;
const mounted = (initial: Conversation): Mounted => {
  let conversation = initial;
  const calls: Calls = { propose: 0, progress: 0, acknowledge: 0 };
  const setConversation: SetConversation = (update) => {
    conversation = typeof update === "function" ? update(conversation) : update;
  };
  const view = (): HostedConversation =>
    presentHostedConversation({
      conversation,
      setConversation,
      propose: () => {
        calls.propose += 1;
      },
      progress: () => {
        calls.progress += 1;
      },
      acknowledge: () => {
        calls.acknowledge += 1;
      },
      current: () => conversation,
      active: () => true,
    });
  return { view, current: () => conversation, calls };
};
const discard = (view: HostedConversation): void => {
  const reply = Option.getOrThrow(view.display.reply);
  Option.getOrThrow(reply.decision).discard();
};

it("archives a discarded proposal with its outcome and unblocks a new submission", () => {
  const mountedConversation = mounted({
    turn: { tag: "completed", value: proposal(true) },
    history: [{ id: "entry-1", from: "user", text: "Deja de seguir Netflix" }],
  });
  const view = mountedConversation.view();
  expect(view.display.canDiscard).toBe(true);

  discard(view);

  const state = mountedConversation.current();
  expect(state.turn).toEqual({ tag: "idle" });
  expect(state.history.map((entry) => entry.text)).toEqual([
    "Deja de seguir Netflix",
    "Voy a detener el seguimiento del plan recurrente «Netflix» ($45.900 COP al mes).",
    "Cambio descartado. No se aplicó ningún cambio.",
  ]);
  expect(mountedConversation.view().display.canSubmit).toBe(true);
});

it("keeps a pending confirmation unreachable while its delivery acknowledgement is in flight", () => {
  const held = proposal(true);
  const mountedConversation = mounted({
    turn: { tag: "confirming", value: held },
    history: [],
  });
  const view = mountedConversation.view();
  expect(view.display.canDiscard).toBe(false);

  discard(view);

  expect(mountedConversation.current()).toEqual({
    turn: { tag: "confirming", value: held },
    history: [],
  });
});

it("withholds discard while the delivery receipt is unconfirmed so the turn can settle", () => {
  const held = proposal(true);
  const mountedConversation = mounted({
    turn: { tag: "unconfirmed", value: held },
    history: [],
  });
  const view = mountedConversation.view();
  expect(view.display.canDiscard).toBe(false);
  expect(view.display.canRetryDelivery).toBe(true);

  discard(view);

  expect(mountedConversation.current()).toEqual({
    turn: { tag: "unconfirmed", value: held },
    history: [],
  });
});

it("neutralizes stale actions after discard so the challenge stays unreachable", () => {
  const mountedConversation = mounted({
    turn: { tag: "completed", value: proposal(true) },
    history: [],
  });
  const stale = mountedConversation.view();

  discard(stale);

  const reply = Option.getOrThrow(stale.display.reply);
  const decision = Option.getOrThrow(reply.decision);
  decision.confirm();
  decision.discard();
  reply.onVisible();
  stale.checkProgress();
  stale.retryDelivery();

  expect(mountedConversation.current().turn).toEqual({ tag: "idle" });
  expect(mountedConversation.calls).toEqual({ propose: 0, progress: 0, acknowledge: 0 });
});

it("offers no discard when the reply carries no pending confirmation", () => {
  const mountedConversation = mounted({
    turn: { tag: "completed", value: proposal(false) },
    history: [],
  });
  const reply = Option.getOrThrow(mountedConversation.view().display.reply);

  expect(Option.isNone(reply.decision)).toBe(true);
  expect(mountedConversation.view().display.canDiscard).toBe(false);
});
