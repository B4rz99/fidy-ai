import type { EmailReplacementViewState } from "./view";
import { type ReplacementActions, makeReplacement } from "./commands";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { type RefCallback, useCallback, useState } from "react";

const incompleteReplacement = Atom.make(false).pipe(Atom.keepAlive);

export const useEmailReplacement = (): ReplacementActions &
  Readonly<{ state: EmailReplacementViewState; lifecycleRef: RefCallback<HTMLElement> }> => {
  const { apiClient, webAuthClient, sessionBinding: binding } = useRouter().options.context;
  const uncertain = useAtomValue(incompleteReplacement);
  const onUncertain = useAtomSet(incompleteReplacement);
  const [state, setState] = useState<EmailReplacementViewState>(
    uncertain ? { _tag: "Uncertain" } : { _tag: "Editing", feedback: "none" }
  );
  const [interaction] = useState(() =>
    makeReplacement({
      apiClient,
      webAuthClient,
      publish: setState,
      uncertain,
      onUncertain,
      binding,
    })
  );
  const dispatch = useAtomSet(interaction.atom);
  const lifecycleRef = useCallback<RefCallback<HTMLElement>>(
    (node) => {
      if (node === null) return;
      return interaction.mount(dispatch);
    },
    [interaction, dispatch]
  );
  return { state, lifecycleRef, ...interaction.actions(dispatch) };
};
