import { Effect, Option } from "effect";
import type { AuthenticationLifetime } from "@/session/lifetime";
import { apiResources } from "./native-lifetime";

/** Drops lazy feature acquisition after its route or account closes. */
export const mountLazyFeature = <Feature>({
  container,
  load,
  mount,
  loading,
}: Readonly<{
  container: HTMLElement;
  load: () => Promise<Feature>;
  mount: (feature: Feature) => () => void;
  loading: string;
}>): (() => void) => {
  let active = true;
  let release = Option.none<() => void>();
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = loading;
  container.replaceChildren(status);
  const fiber = Effect.runFork(
    Effect.tryPromise(load).pipe(
      Effect.tap((feature) =>
        Effect.sync(() => {
          if (!active) return;
          container.replaceChildren();
          release = Option.some(mount(feature));
        })
      ),
      Effect.catch(() =>
        Effect.sync(() => {
          if (!active) return;
          status.setAttribute("role", "alert");
          status.textContent = "No pudimos cargar esta página. Recarga la página para continuar.";
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

/** Loads Dashboard on demand within the current authentication lifetime. */
export const mountDashboardPage = ({
  container,
  lifetime,
}: Readonly<{ container: HTMLElement; lifetime: AuthenticationLifetime }>): (() => void) =>
  mountLazyFeature({
    container,
    loading: "Cargando tablero…",
    load: () => import("@/features/dashboard/feature"),
    mount: (feature) =>
      feature.mountDashboard({
        container,
        client: lifetime.apiClient,
        registry: lifetime.registry,
        resources: apiResources(lifetime),
      }),
  });
