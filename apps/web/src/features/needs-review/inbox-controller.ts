import { Option } from "effect";
import { useState } from "react";
import type { ReviewDecisions } from "./decisions";
import type { Item, Workspace } from "./model";

export type InboxControl = Readonly<{
  decisions: ReviewDecisions;
  selected: Option.Option<Item["id"]>;
  checked: ReadonlyArray<Item["id"]>;
  undoCount: number;
  feedback: string;
  locked: boolean;
  choose: (item: Item) => void;
  toggle: (item: Item) => void;
  clearChecked: () => void;
  bulk: ReviewDecisions["bulk"];
  recover: () => void;
  undoSkip: () => void;
}>;
export const useInboxControl = ({
  view,
  visibleItems,
  decisions,
}: Readonly<{
  view: Workspace;
  visibleItems: ReadonlyArray<Item>;
  decisions: ReviewDecisions;
}>): InboxControl => {
  const [selection, setSelection] = useState(() => Option.none<Item["id"]>());
  const [checked, setChecked] = useState<ReadonlyArray<Item["id"]>>([]);
  const [previous, setPrevious] = useState(decisions.completed);
  const selected = selectedItem({ selection, view: { ...view, items: visibleItems } });
  if (previous !== decisions.completed) {
    setPrevious(decisions.completed);
    if (Option.isSome(decisions.completed)) {
      setSelection(
        selectionAfterDecision({
          view: { ...view, items: visibleItems },
          selected,
          completed: decisions.completed.value.ids,
        })
      );
      setChecked([]);
    }
  }
  return {
    decisions,
    selected,
    checked,
    undoCount: decisions.undoCount,
    feedback: decisions.feedback,
    locked: decisions.locked,
    clearChecked: () => setChecked([]),
    bulk: decisions.bulk,
    recover: decisions.recover,
    undoSkip: decisions.undoSkip,
    choose: (item) => setSelection(Option.some(item.id)),
    toggle: (item) =>
      setChecked((current) =>
        current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]
      ),
  };
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

const selectionAfterDecision = ({
  view,
  selected,
  completed,
}: Readonly<{
  view: Workspace;
  selected: Option.Option<Item["id"]>;
  completed: ReadonlyArray<Item["id"]>;
}>): Option.Option<Item["id"]> => {
  const completedIds = new Set(completed);
  const position = view.items.findIndex((item) => Option.contains(selected, item.id));
  const active = view.items[position];
  if (active === undefined || !completedIds.has(active.id)) return selected;
  const following = [...view.items.slice(position + 1), ...view.items.slice(0, position)];
  return Option.fromUndefinedOr(following.find((item) => !completedIds.has(item.id))?.id);
};
