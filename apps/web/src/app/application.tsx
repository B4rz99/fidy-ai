import { BrowserSessionBoundary } from "@/session/browser-session-boundary";
import { Result } from "effect";
import { type JSX, Suspense, lazy } from "react";
import { SessionRegistryProvider } from "@/session/session";
import { parseApiOrigin } from "@/transport/origin";

// Code loading overlaps discovery; authenticated clients still mount inside the binding boundary.
const applicationModule = import("./bound-application").then(Result.succeed, (cause: unknown) =>
  Result.fail(cause)
);
const BoundApplication = lazy(() =>
  applicationModule.then((loaded) =>
    Result.match(loaded, {
      onSuccess: (module) => ({ default: module.BoundApplication }),
      onFailure: (cause) => {
        throw cause;
      },
    })
  )
);
const RoutedApplication = (): JSX.Element => {
  const apiOrigin = parseApiOrigin(import.meta.env.VITE_API_ORIGIN);
  return (
    <BrowserSessionBoundary apiOrigin={apiOrigin}>
      {(session) => (
        <Suspense fallback={<output>Cargando…</output>}>
          <BoundApplication apiOrigin={apiOrigin} session={session} />
        </Suspense>
      )}
    </BrowserSessionBoundary>
  );
};

export const WebApplication = (): JSX.Element => (
  <SessionRegistryProvider>
    <RoutedApplication />
  </SessionRegistryProvider>
);
