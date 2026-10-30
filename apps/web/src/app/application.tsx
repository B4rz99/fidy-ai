import { BrowserSessionBoundary } from "@/session/browser-session-boundary";
import { useAtomValue } from "@effect/atom-react";
import { Data, Effect, Result } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { type JSX } from "react";
import { SessionRegistryProvider } from "@/session/session";
import { parseApiOrigin } from "@/transport/origin";
import type { BrowserSessionLifetime } from "@/transport/session-binding";

// Code loading overlaps discovery; authenticated clients still mount inside the binding boundary.
const applicationModule = import("./bound-application").then(Result.succeed, (cause: unknown) =>
  Result.fail(cause)
);
class ApplicationCodeUnavailable extends Data.TaggedError("ApplicationCodeUnavailable")<{}> {}
const applicationCode = Atom.make(
  Effect.tryPromise({
    try: () => applicationModule,
    catch: () => new ApplicationCodeUnavailable(),
  })
);
const BoundApplication = ({
  apiOrigin,
  session,
}: Readonly<{
  apiOrigin: string;
  session: BrowserSessionLifetime;
}>): JSX.Element => {
  const loaded = useAtomValue(applicationCode);
  if (AsyncResult.isFailure(loaded)) throw new ApplicationCodeUnavailable();
  if (!AsyncResult.isSuccess(loaded)) return <output>Cargando…</output>;
  return Result.match(loaded.value, {
    onSuccess: (module) => <module.BoundApplication apiOrigin={apiOrigin} session={session} />,
    onFailure: (cause) => {
      throw cause;
    },
  });
};
const RoutedApplication = (): JSX.Element => {
  const apiOrigin = parseApiOrigin(import.meta.env.VITE_API_ORIGIN);
  return (
    <BrowserSessionBoundary apiOrigin={apiOrigin}>
      {(session) => <BoundApplication apiOrigin={apiOrigin} session={session} />}
    </BrowserSessionBoundary>
  );
};

export const WebApplication = (): JSX.Element => (
  <SessionRegistryProvider>
    <RoutedApplication />
  </SessionRegistryProvider>
);
