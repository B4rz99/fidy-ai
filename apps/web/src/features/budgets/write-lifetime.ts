import { Option } from "effect";
import { useLayoutEffect, useRef, useState } from "react";
import type { BudgetDraft, SaveState, WorkspaceProps } from "./model";

export type BudgetWriteContext = Readonly<{
  editable: boolean;
  data: Option.Option<Omit<WorkspaceProps, "editing">>;
  saveState: SaveState;
  writeAction: "save" | "delete";
  draft: Option.Option<BudgetDraft>;
  refreshQueries: () => void;
}>;
/** Bridge committed read admission to retained event callbacks; disposal only retires local work. */
export const useBudgetWriteLifetime = (
  context: BudgetWriteContext
): Readonly<{
  current: () => Option.Option<BudgetWriteContext>;
  isCurrent: () => boolean;
  reset: () => void;
}> => {
  const latest = useRef(Option.none<BudgetWriteContext>());
  const [owner] = useState(() => {
    let generation = 0;
    return {
      version: (): number => generation,
      advance: (): void => {
        generation += 1;
      },
    };
  });
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
