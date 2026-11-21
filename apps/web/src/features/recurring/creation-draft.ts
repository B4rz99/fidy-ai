import { Option, Schema } from "effect";
import { type RefCallback, createContext, useCallback, useRef, useState } from "react";
import type { PlanInput } from "./model";
import { restoredPlan } from "./plan-fields";

type Initial = Partial<PlanInput> & Pick<PlanInput, "timeZone">;

export type CreationDraftControl = Readonly<{
  track: RefCallback<HTMLElement>;
  discard: () => void;
}>;

export const CreationDraftContext = createContext<CreationDraftControl>({
  track: () => undefined,
  discard: () => undefined,
});

const snapshot = (form: HTMLFormElement): string =>
  JSON.stringify(
    Array.from(new FormData(form), ([key, entry]) => [
      key,
      Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(entry), () => ""),
    ])
  );

const noForm: Option.Option<HTMLFormElement> = Option.none();

export type CreationDraft = Readonly<{
  kept: Option.Option<Initial>;
  track: RefCallback<HTMLElement>;
  keep: () => void;
  clear: () => void;
}>;

export const useCreationDraft = (timeZone: PlanInput["timeZone"]): CreationDraft => {
  const form = useRef(noForm);
  const baseline = useRef("");
  const [kept, setKept] = useState<Option.Option<Initial>>(() => Option.none());

  const track = useCallback<RefCallback<HTMLElement>>((node) => {
    form.current = Option.fromNullishOr(
      node?.querySelector<HTMLFormElement>('[data-recurring-slot="plan-form"]')
    );
    Option.map(form.current, (found) => {
      baseline.current = snapshot(found);
    });
  }, []);

  const keep = (): void =>
    Option.match(
      Option.filter(form.current, (found) => snapshot(found) !== baseline.current),
      {
        onNone: () => undefined,
        onSome: (found) =>
          setKept(Option.some(restoredPlan({ form: new FormData(found), timeZone }))),
      }
    );

  return { kept, track, keep, clear: () => setKept(Option.none()) };
};
