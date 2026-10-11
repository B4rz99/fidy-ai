import { Effect, Option } from "effect";
import type { AuthenticationLifetime } from "@/session/lifetime";
import { apiResources } from "./native-lifetime";

/** Loads Dashboard only when requested and drops acquisition after route/account teardown. */
export const mountDashboardPage = ({
  container,
  lifetime,
}: Readonly<{ container: HTMLElement; lifetime: AuthenticationLifetime }>): (() => void) => {
  let active = true;
  let release = Option.none<() => void>();
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Cargando tablero…";
  container.replaceChildren(status);
  const fiber = Effect.runFork(
    Effect.tryPromise(() => import("@/features/dashboard/feature")).pipe(
      Effect.tap((feature) =>
        Effect.sync(() => {
          if (!active) return;
          container.replaceChildren();
          release = Option.some(
            feature.mountDashboard({
              container,
              client: lifetime.apiClient,
              registry: lifetime.registry,
              resources: apiResources(lifetime),
            })
          );
        })
      ),
      Effect.catch(() =>
        Effect.sync(() => {
          if (!active) return;
          status.setAttribute("role", "alert");
          status.textContent = "No pudimos cargar el tablero. Recarga la página para continuar.";
          container.replaceChildren(status);
        })
      )
    )
  );
  return (): void => {
    active = false;
    fiber.interruptUnsafe();
    Option.map(release, (dispose) => dispose());
    release = Option.none();
    container.replaceChildren();
  };
};
