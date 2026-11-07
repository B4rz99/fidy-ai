import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { Option } from "effect";
import { emptyCaptureDraft } from "./capture-draft";
import { ManualCaptureContext, type ManualCaptureState } from "./manual-capture-context";

export const ManualCaptureProvider = ({
  timeZone,
  children,
}: Readonly<{ timeZone: string; children: ReactNode }>): JSX.Element => {
  const initial = (): ManualCaptureState => ({
    draft: emptyCaptureDraft(timeZone),
    status: "idle",
    attempt: Option.none(),
    check: Option.none(),
  });
  const [state, setState] = useState(initial);
  return (
    <ManualCaptureContext
      value={Option.some({
        ...state,
        change: (draft) => setState((current) => ({ ...current, draft })),
        onStatus: (status) =>
          setState((current) => ({
            ...current,
            status,
            ...(status === "uncertain"
              ? { attempt: Option.some(current.draft), check: Option.none() }
              : {}),
          })),
        clear: () => setState(initial()),
        checkHistory: (version) =>
          setState((current) => ({ ...current, check: Option.some(version) })),
        resume: () => setState((current) => ({ ...current, status: "idle", check: Option.none() })),
      })}
    >
      {children}
    </ManualCaptureContext>
  );
};
