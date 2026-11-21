import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option, Predicate } from "effect";
import { type JSX, useState } from "react";
import { HostedAgentFeature, HostedAgentProvider } from "@/features/agent/feature";
import { useSession } from "@/session/session-context";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";

const freshValue = <A,>(state: CanonicalQueryState<A, unknown>): Option.Option<A> =>
  Predicate.isTagged(state, "Ready") && !state.waiting && Option.isNone(state.refreshFailure)
    ? Option.some(state.value)
    : Option.none();

export const OAuthAgent = (): JSX.Element => {
  const router = useRouter();
  const client = router.options.context.webAuthClient;
  const { authentication } = useSession();

  const [consentQuery] = useState(() =>
    client.query("processingConsent", "status", {
      timeToLive: "0 seconds",
      reactivityKeys: ["processing-consent"],
    })
  );

  const [bindingQuery] = useState(() =>
    client.query("browserSession", "binding", { query: {}, timeToLive: "0 seconds" })
  );

  const consent = useAtomValue(consentQuery).pipe(presentCanonicalQuery, freshValue);
  const session = useAtomValue(bindingQuery).pipe(presentCanonicalQuery, freshValue);

  if (
    authentication === "expired" ||
    Option.isNone(consent) ||
    Option.isNone(session) ||
    session.value.binding === null ||
    consent.value.status !== "Granted"
  ) {
    return <></>;
  }

  return (
    <HostedAgentProvider client={router.options.context.hostedTurnClient}>
      <HostedAgentFeature />
    </HostedAgentProvider>
  );
};
