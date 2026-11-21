import { Option } from "effect";
import { useLayoutEffect, useRef, useState } from "react";
import type { BudgetDraft, BudgetEdit, SaveState, WorkspaceProps } from "./model";

export type BudgetWriteContext = Readonly<{
  editable: boolean;
  data: Option.Option<Omit<WorkspaceProps, "editing">>;
  saveState: SaveState;
  writeAction: "save" | "delete";
  draft: Option.Option<BudgetDraft>;
  inlineDraft: Option.Option<BudgetEdit>;
  refreshQueries: () => void;
}>;

type WriteOwner = Readonly<{ version: () => number; advance: () => void }>;

type BudgetWriteLifetime = Readonly<{
  current: () => Option.Option<BudgetWriteContext>;
  isCurrent: () => boolean;
  reset: () => void;
}>;

const makeWriteOwner = (): WriteOwner => {
  let generation = 0;

  return {
    version: (): number => generation,
    advance: (): void => {
      generation += 1;
    },
  };
};

const initialContext = Option.none<BudgetWriteContext>();

export const useBudgetWriteLifetime = (context: BudgetWriteContext): BudgetWriteLifetime => {
  const latest = useRef(initialContext);
  const [owner] = useState(makeWriteOwner);
  useLayoutEffect(() => {
    latest.current = Option.some(context);

    return (): void => {
      latest.current = Option.none();
    };
  });
  const version = owner.version();

  return {
    current: () => (owner.version() === version ? latest.current : Option.none()),
    isCurrent: () => owner.version() === version && Option.isSome(latest.current),
    reset: () => {
      owner.advance();
    },
  };
};
