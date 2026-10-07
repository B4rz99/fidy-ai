import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import type { TokenShortId } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { PATActivityPicker, PATActivityResults } from "./activity-view";

const SelectedActivity = ({ shortId }: Readonly<{ shortId: TokenShortId }>): JSX.Element => {
  const router = useRouter();
  const [query] = useState(() =>
    router.options.context.apiClient.query("pats", "getPATActivity", {
      params: { shortId },
      timeToLive: "0 seconds",
    })
  );
  const result = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  const state = presentCanonicalQuery(result);
  return (
    <PATActivityResults
      state={state._tag === "Ready" ? { ...state, value: state.value.data } : state}
      onRetry={refresh}
    />
  );
};

/** Keep activity queries in the authentication registry; selecting a different grant resets the displayed query. */
export const PATActivityFeature = (): JSX.Element => {
  const [selected, setSelected] = useState<Option.Option<TokenShortId>>(() => Option.none());
  return (
    <>
      <PATActivityPicker onSelect={(shortId) => setSelected(Option.some(shortId))} />
      {Option.isSome(selected) ? (
        <SelectedActivity key={selected.value} shortId={selected.value} />
      ) : null}
    </>
  );
};
