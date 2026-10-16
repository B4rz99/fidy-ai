import { type DraftBarrier, flushReviewSelection } from "./draft-barrier";
import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { useState } from "react";
import { type ReviewWrite, makeReviewWrite } from "./command";
import type { Detail, Item, Workspace } from "./model";

export type InboxControl = Readonly<{
  barrier: DraftBarrier;
  selected: Option.Option<Item["id"]>;
  checked: ReadonlyArray<Item["id"]>;
  undo: ReadonlyArray<Detail>;
  feedback: string;
  locked: boolean;
  choose: (item: Item) => void;
  toggle: (item: Item) => void;
  finished: (items: ReadonlyArray<Detail>, skipped: boolean) => void;
  bulk: (restore: boolean, items: ReadonlyArray<Item>) => void;
  recover: () => void;
  undoSkip: () => void;
}>;
export const useInboxControl = ({
  view,
  refresh,
}: Readonly<{ view: Workspace; refresh: () => void }>): InboxControl => {
  const [barrier] = useState<DraftBarrier>(() => new Map());
  const apiClient = useRouter().options.context.apiClient;
  const [writer] = useState(() => makeReviewWrite(apiClient));
  const send = useAtomSet(writer);
  const [selection, setSelection] = useState(() => Option.none<Item["id"]>());
  const [checked, setChecked] = useState<ReadonlyArray<Item["id"]>>([]);
  const [undo, setUndo] = useState<ReadonlyArray<Detail>>([]);
  const [feedback, setFeedback] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [recovering, setRecovering] = useState<Option.Option<Workspace>>(Option.none);
  const locked =
    blocked &&
    Option.match(recovering, { onNone: () => true, onSome: (previous) => previous === view });
  const setLocked = (value: boolean): void => {
    setBlocked(value);
    setRecovering(Option.none());
  };
  const selected = selectedItem({ selection, view });
  const finished = (items: ReadonlyArray<Detail>, skipped: boolean): void => {
    items.forEach((item) => barrier.delete(item.item.id));
    setLocked(false);
    setChecked([]);
    setFeedback(skipped ? `${items.length} elementos omitidos.` : "Cambio guardado.");
    if (skipped) setUndo(items);
    refresh();
  };
  const bulk = (restore: boolean, items: ReadonlyArray<Item>): void =>
    submitBulk({ restore, items, locked, send, finished, setLocked, setFeedback, barrier });
  return {
    barrier,
    selected,
    checked,
    undo,
    feedback,
    locked,
    finished,
    bulk,
    choose: (item) => setSelection(Option.some(item.id)),
    toggle: (item) =>
      setChecked((current) =>
        current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]
      ),
    recover: () => {
      setRecovering(Option.some(view));
      refresh();
    },
    undoSkip: () => {
      bulk(
        true,
        undo.map((value) => ({ ...value.item, revision: value.revision }))
      );
      setUndo([]);
    },
  };
};

const submitBulk = ({
  restore,
  items,
  locked,
  send,
  finished,
  setLocked,
  setFeedback,
  barrier,
}: Readonly<{
  barrier: DraftBarrier;
  restore: boolean;
  items: ReadonlyArray<Item>;
  locked: boolean;
  send: (input: ReviewWrite) => void;
  finished: InboxControl["finished"];
  setLocked: (value: boolean) => void;
  setFeedback: (value: string) => void;
}>): void => {
  if (locked || items.length === 0) return;
  setLocked(true);
  flushReviewSelection({ barrier, items })
    .then((saved) => {
      if (Option.isNone(saved)) {
        setFeedback("No pudimos guardar el borrador. Actualiza antes de continuar.");
        return;
      }
      const first = saved.value[0];
      if (first === undefined) return;
      send({
        command: {
          _tag: restore ? "Restore" : "Skip",
          items: [
            { id: first.id, revision: first.revision },
            ...saved.value.slice(1).map((value) => ({ id: value.id, revision: value.revision })),
          ],
        },
        saved: (values) => finished(values, !restore),
        failed: () => setFeedback("No pudimos confirmar el cambio. Actualiza antes de continuar."),
      });
    })
    .catch(() => setFeedback("No pudimos confirmar el guardado. Actualiza antes de continuar."));
};

const selectedItem = ({
  selection,
  view,
}: Readonly<{ selection: Option.Option<Item["id"]>; view: Workspace }>): Option.Option<
  Item["id"]
> =>
  Option.orElse(
    Option.filter(selection, (id) => view.items.some((item) => item.id === id)),
    () => Option.fromUndefinedOr(view.items[0]?.id)
  );
