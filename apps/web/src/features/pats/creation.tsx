import { PATCreationSkeleton } from "@/ui/components/settings-loading";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { type JSX, type RefCallback, useCallback, useRef, useState } from "react";
import type { SensitiveClipboard } from "@/browser/sensitive-clipboard";
import type { FidyClient } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { type PATDraft, resumePATDraft } from "./reauthentication-draft";
import { usePATIssuance } from "./issuance";
import { ManualPATView } from "./view";

type CreationProps = Readonly<{ apiClient: FidyClient; clipboard: SensitiveClipboard }>;
const FreshPATCreation = (
  props: CreationProps & Readonly<{ initialDraft: Option.Option<PATDraft> }>
): JSX.Element => {
  const issuance = usePATIssuance(props);
  return <ManualPATView {...issuance} />;
};
export const ManualPATCreation = ({
  resuming,
  ...props
}: CreationProps & Readonly<{ resuming: boolean }>): JSX.Element =>
  resuming ? (
    <ResumedPATCreation {...props} />
  ) : (
    <FreshPATCreation {...props} initialDraft={Option.none()} />
  );
const ResumedPATCreation = (props: CreationProps): JSX.Element => {
  const [userQuery] = useState(() => props.apiClient.query("identity", "getCurrentUser", {}));
  const result = useAtomValue(userQuery);
  const retry = useAtomRefresh(userQuery);
  const consumed = useRef(false);
  const user = presentCanonicalQuery(result);
  const [draft, setDraft] = useState<Option.Option<Option.Option<PATDraft>>>(() => Option.none());
  const userId = user._tag === "Ready" ? Option.some(user.value.data.id) : Option.none();
  const mounted = useCallback<RefCallback<HTMLElement>>(
    (node) => {
      if (node !== null && Option.isSome(userId) && !consumed.current) {
        consumed.current = true;
        setDraft(Option.some(resumePATDraft(userId.value)));
      }
    },
    [userId, setDraft]
  );
  if (user._tag === "Failure") {
    return (
      <div role="alert">
        <p>No pudimos comprobar tu identidad. El formulario sigue guardado en esta pestaña.</p>
        <Button type="button" onClick={retry}>
          Volver a intentar
        </Button>
      </div>
    );
  }
  if (Option.isNone(draft)) {
    return (
      <div ref={mounted}>
        <PATCreationSkeleton />
      </div>
    );
  }
  return <FreshPATCreation {...props} initialDraft={draft.value} />;
};
