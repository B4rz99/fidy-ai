import { Refresh04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FidyClient } from "@/transport/client";
import type { Atom } from "effect/reactivity";
import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect } from "effect";
import { type JSX, useState } from "react";
import { Button } from "@/ui/components/button";
import type { Draft, Item } from "./model";

export const RetryExtraction = ({
  item,
  suggested,
  disabled,
}: Readonly<{ item: Item; suggested: (draft: Draft) => void; disabled: boolean }>): JSX.Element => {
  const apiClient = useRouter().options.context.apiClient;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry] = useState(() => makeRetry(apiClient, item.id));
  const run = useAtomSet(retry);
  return (
    <div className="mt-4 grid justify-items-start gap-2">
      <Button
        variant="outline"
        disabled={disabled || busy}
        onClick={() => {
          setBusy(true);
          setFailed(false);
          run({
            success: (draft) => {
              setBusy(false);
              suggested(draft);
            },
            failure: () => {
              setBusy(false);
              setFailed(true);
            },
          });
        }}
      >
        <HugeiconsIcon icon={Refresh04Icon} size={18} aria-hidden="true" />
        {busy ? "Procesando…" : "Reintentar procesamiento"}
      </Button>
      {failed ? (
        <p role="alert" className="text-sm text-muted-foreground">
          El procesamiento sigue sin estar disponible. Tus cambios se conservan; puedes completar
          los datos manualmente.
        </p>
      ) : null}
    </div>
  );
};

type RetryInput = Readonly<{ success: (draft: Draft) => void; failure: () => void }>;
const makeRetry = (
  apiClient: FidyClient,
  id: Item["id"]
): Atom.AtomResultFn<RetryInput, void, never> =>
  apiClient.runtime.fn<RetryInput>()((input) =>
    Effect.gen(function* () {
      const client = yield* apiClient;
      const result = yield* client.ingestion.getReviewSuggestions({ params: { id } });
      yield* Effect.sync(() => input.success(result.data));
    }).pipe(Effect.catchCause(() => Effect.sync(input.failure)))
  );
