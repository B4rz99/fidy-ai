import type { EmailReplacementViewState } from "./view";
import { makeComplete, makeRequest } from "./commands";
import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import type { EmailAddress as EmailAddressType } from "@/transport/client";

type EmailReplacementController = Readonly<{
  state: EmailReplacementViewState;
  request: (candidateEmail: string) => void;
  complete: (candidateEmail: EmailAddressType, combinedCode: string) => void;
  restart: () => void;
}>;

export const useEmailReplacement = (): EmailReplacementController => {
  const router = useRouter();
  const [state, setState] = useState<EmailReplacementViewState>({ _tag: "Editing" });
  const [requestAtom] = useState(() =>
    makeRequest({ apiClient: router.options.context.apiClient })
  );
  const [completeAtom] = useState(() =>
    makeComplete({ apiClient: router.options.context.apiClient })
  );
  const request = useAtomSet(requestAtom.atom);
  const complete = useAtomSet(completeAtom.atom);
  return {
    state,
    request: (candidateEmail: string): void => {
      requestAtom.stage({ candidateEmail, onStateChange: setState });
      request(undefined);
    },
    complete: (candidateEmail: EmailAddressType, combinedCode: string): void => {
      completeAtom.stage({ candidateEmail, combinedCode, onStateChange: setState });
      complete(undefined);
    },
    restart: (): void => {
      requestAtom.clear();
      completeAtom.clear();
      request(Atom.Interrupt);
      complete(Atom.Interrupt);
      setState({ _tag: "Editing" });
    },
  } as const;
};
