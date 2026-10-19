import type { DraftBarrier } from "./draft-barrier";
import { useAtomSet } from "@effect/atom-react";
import { Option } from "effect";
import { useState } from "react";
import type { FidyClient } from "@/transport/client";
import { type ReviewWrite, makeReviewWrite } from "./command";
import {
  type Command,
  type Detail,
  type Draft,
  creation,
  emptyDraft,
  mergeSuggestions,
} from "./model";

const autosaveMilliseconds = 650;
type Feedback = "saved" | "saving" | "unsaved" | "failed" | "uncertain";
type Queue = {
  id: Detail["item"]["id"];
  blocked: boolean;
  revision: number;
  draft: Draft;
  wanted: Option.Option<Draft>;
  timer: Option.Option<number>;
  tail: Promise<void>;
  clean: () => void;
};
const clearTimer = (owner: Queue): void => {
  Option.map(owner.timer, window.clearTimeout);
  owner.timer = Option.none();
};
type Send = (input: ReviewWrite) => Promise<unknown>;
const saveDraft = (
  owner: Queue,
  send: Send,
  feedback: (value: Feedback) => void
): Promise<void> => {
  clearTimer(owner);
  owner.tail = owner.tail.then(() => {
    if (owner.blocked || Option.isNone(owner.wanted)) return;
    const draft = owner.wanted.value;
    owner.wanted = Option.none();
    feedback("saving");
    return send({
      command: { _tag: "SaveDraft", id: owner.id, revision: owner.revision, draft },
      saved: (items) => {
        const latest = items[0];
        if (latest === undefined) {
          owner.blocked = true;
          feedback("uncertain");
          return;
        }
        owner.revision = latest.revision;
        if (Option.isNone(owner.wanted)) owner.clean();
        feedback(Option.isSome(owner.wanted) ? "unsaved" : "saved");
      },
      failed: (uncertain) => {
        owner.blocked = true;
        feedback(uncertain ? "uncertain" : "failed");
      },
    }).then(() => {});
  });
  return owner.tail;
};
const makeQueue = (detail: Detail, barrier: DraftBarrier): Queue => {
  const owner: Queue = {
    id: detail.item.id,
    blocked: false,
    revision: detail.revision,
    draft: Option.getOrElse(
      Option.orElse(detail.draft, () => detail.suggestions),
      emptyDraft
    ),
    wanted: Option.none(),
    timer: Option.none(),
    tail: Promise.resolve(),
    clean: () => barrier.delete(detail.item.id),
  };
  return owner;
};

type EditorController = Readonly<{
  draft: Draft;
  change: (draft: Draft) => void;
  suggested: (draft: Draft) => void;
  act: (kind: "Create" | "Skip") => void;
  feedback: Feedback;
  locked: boolean;
  creation: Option.Option<Command>;
}>;
const scheduleDraft = ({
  owner,
  next,
  send,
  feedback,
}: Readonly<{
  owner: Queue;
  next: Draft;
  send: Send;
  feedback: (value: Feedback) => void;
}>): void => {
  owner.draft = next;
  owner.wanted = Option.some(next);
  clearTimer(owner);
  owner.timer = Option.some(
    window.setTimeout(() => {
      saveDraft(owner, send, feedback).catch(() => haltQueue(owner, feedback));
    }, autosaveMilliseconds)
  );
};
const useCanonicalDraft = ({
  detail,
  barrier,
  feedback,
  acting,
}: Readonly<{
  detail: Detail;
  barrier: DraftBarrier;
  feedback: Feedback;
  acting: boolean;
}>): Readonly<{
  owner: Queue;
  draft: Draft;
  setDraft: (draft: Draft) => void;
}> => {
  const [owner, setOwner] = useState(() => makeQueue(detail, barrier));
  const [draft, setDraft] = useState(() => owner.draft);
  if (detail.revision > owner.revision && feedback === "saved" && !acting) {
    const next = makeQueue(detail, barrier);
    setOwner(next);
    setDraft(next.draft);
  }
  return { owner, draft, setDraft };
};

export const useReviewEditor = ({
  apiClient,
  detail,
  finished,
  barrier,
}: Readonly<{
  apiClient: FidyClient;
  detail: Detail;
  barrier: DraftBarrier;
  finished: (items: ReadonlyArray<Detail>, skipped: boolean) => void;
}>): EditorController => {
  const [writer] = useState(() => makeReviewWrite(apiClient));
  const send = useAtomSet(writer, { mode: "promiseExit" });
  const [feedback, setFeedback] = useState<Feedback>("saved");
  const [acting, setActing] = useState(false);
  const { owner, draft, setDraft } = useCanonicalDraft({ detail, barrier, feedback, acting });
  const superseded = detail.revision > owner.revision;
  const change = (next: Draft): void => {
    if (owner.blocked || acting || superseded) return;
    setDraft(next);
    setFeedback("unsaved");
    scheduleDraft({ owner, next, send, feedback: setFeedback });
    barrier.set(owner.id, () =>
      saveDraft(owner, send, setFeedback).then(() =>
        owner.blocked ? Option.none() : Option.some(owner.revision)
      )
    );
  };
  const act = (kind: "Create" | "Skip"): void => {
    if (owner.blocked || acting || superseded) return;
    setActing(true);
    saveDraft(owner, send, setFeedback)
      .then(() => runDecision({ kind, owner, detail, send, finished, setActing, setFeedback }))
      .catch(() => {
        haltQueue(owner, setFeedback);
        setActing(false);
      });
  };
  return {
    draft,
    change,
    suggested: (next) => change(mergeSuggestions({ draft: owner.draft, suggested: next })),
    act,
    feedback: superseded ? "failed" : feedback,
    locked: [superseded, feedback === "failed", feedback === "uncertain", acting].some(Boolean),
    creation: creation({ detail, draft }),
  };
};
const runDecision = ({
  kind,
  owner,
  detail,
  send,
  finished,
  setActing,
  setFeedback,
}: Readonly<{
  kind: "Create" | "Skip";
  owner: Queue;
  detail: Detail;
  send: Send;
  finished: (items: ReadonlyArray<Detail>, skipped: boolean) => void;
  setActing: (value: boolean) => void;
  setFeedback: (value: Feedback) => void;
}>): Promise<void> => {
  if (owner.blocked) {
    setActing(false);
    return Promise.resolve();
  }
  const command: Option.Option<Command> =
    kind === "Create"
      ? creation({ detail: { ...detail, revision: owner.revision }, draft: owner.draft })
      : Option.some({ _tag: "Skip", items: [{ id: detail.item.id, revision: owner.revision }] });
  if (Option.isNone(command)) {
    setActing(false);
    return Promise.resolve();
  }
  return send({
    command: command.value,
    saved: (items) => finished(items, kind === "Skip"),
    failed: (uncertain) => {
      owner.blocked = true;
      setFeedback(uncertain ? "uncertain" : "failed");
      setActing(false);
    },
  }).then(() => {});
};

const haltQueue = (owner: Queue, feedback: (value: Feedback) => void): void => {
  owner.blocked = true;
  feedback("uncertain");
};
