import { useState } from "react";
import type { JSX, ReactNode, RefCallback } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { emptyCaptureDraft } from "./capture-draft";
import { makeTransactionCapture } from "./capture-task";
import { type CaptureHistoryVersion, ManualCaptureContext } from "./manual-capture-context";

export const ManualCaptureProvider = ({
  timeZone,
  children,
}: Readonly<{ timeZone: string; children: ReactNode }>): JSX.Element => {
  const { apiClient } = useRouter().options.context;
  const [resource] = useState(() =>
    makeTransactionCapture({ client: apiClient, timeZone, initial: emptyCaptureDraft(timeZone) })
  );
  const task = useAtomValue(resource);
  const [mounted] = useState<RefCallback<HTMLDivElement>>(
    () =>
      (node: Parameters<RefCallback<HTMLDivElement>>[0]): ReturnType<RefCallback<HTMLDivElement>> =>
        node === null ? undefined : task.mount()
  );
  const [check, setCheck] = useState<Option.Option<CaptureHistoryVersion>>(() => Option.none());
  return (
    <div className="contents" ref={mounted}>
      <ManualCaptureContext
        value={Option.some({
          ...task,
          check,
          clear: () => {
            task.restart(emptyCaptureDraft(timeZone));
            setCheck(Option.none());
          },
          checkHistory: (version) => setCheck(Option.some(version)),
          resumeAfterInspection: (version) => {
            if (
              !Option.exists(
                check,
                (previous) =>
                  previous.month === version.month && previous.generation < version.generation
              )
            ) {
              return;
            }
            task.resume();
            setCheck(Option.none());
          },
        })}
      >
        {children}
      </ManualCaptureContext>
    </div>
  );
};
