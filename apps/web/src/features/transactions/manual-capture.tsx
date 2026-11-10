import { useState } from "react";
import type { JSX, ReactNode, RefCallback } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import type { Atom } from "effect/reactivity";
import { emptyCaptureDraft } from "./capture-draft";
import {
  type CaptureRetention,
  type TransactionCaptureTask,
  makeCaptureRetention,
} from "./capture-task";
import { type CaptureHistoryVersion, ManualCaptureContext } from "./manual-capture-context";

export const ManualCaptureProvider = ({
  timeZone,
  children,
}: Readonly<{ timeZone: string; children: ReactNode }>): JSX.Element => {
  const [retentionResource] = useState(() => makeCaptureRetention());
  const retention = useAtomValue(retentionResource);
  return Option.match(retention.resource, {
    onNone: () => (
      <ManualCaptureAttachment retention={retention} timeZone={timeZone}>
        {null}
      </ManualCaptureAttachment>
    ),
    onSome: (resource) => (
      <ManualCaptureTask resource={resource} retention={retention} timeZone={timeZone}>
        {children}
      </ManualCaptureTask>
    ),
  });
};
const ManualCaptureAttachment = ({
  timeZone,
  retention,
  children,
}: Readonly<{
  timeZone: string;
  retention: CaptureRetention;
  children: ReactNode;
}>): JSX.Element => {
  const { apiClient } = useRouter().options.context;
  const [mounted] = useState<RefCallback<HTMLDivElement>>(
    () =>
      (node: Parameters<RefCallback<HTMLDivElement>>[0]): ReturnType<RefCallback<HTMLDivElement>> =>
        node === null
          ? undefined
          : retention.mount(
              { client: apiClient, timeZone, initial: emptyCaptureDraft(timeZone) },
              timeZone
            )
  );
  return (
    <div className="contents" ref={mounted}>
      {children}
    </div>
  );
};
const ManualCaptureTask = ({
  resource,
  retention,
  timeZone,
  children,
}: Readonly<{
  resource: Atom.Atom<TransactionCaptureTask>;
  retention: CaptureRetention;
  timeZone: string;
  children: ReactNode;
}>): JSX.Element => {
  const task = useAtomValue(resource);
  const [check, setCheck] = useState<Option.Option<CaptureHistoryVersion>>(() => Option.none());
  const identity = task.locked || Option.isSome(task.attempt) ? task.timeZone : timeZone;
  return (
    <ManualCaptureAttachment key={identity} timeZone={timeZone} retention={retention}>
      <ManualCaptureContext
        value={Option.some({
          ...task,
          check,
          clear: () => {
            task.restart({ draft: emptyCaptureDraft(timeZone), timeZone });
            setCheck(Option.none());
          },
          checkHistory: (version) => setCheck(Option.some(version)),
          resumeAfterInspection: (version) => {
            if (
              !Option.exists(
                check,
                (previous) =>
                  previous.month === version.month &&
                  previous.timeZone === version.timeZone &&
                  previous.generation < version.generation
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
    </ManualCaptureAttachment>
  );
};
