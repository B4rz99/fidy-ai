import { Option } from "effect";
import type { JSX } from "react";
import {
  Link,
  Outlet,
  type RouterHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { FidyClient } from "./api-client";
import policyHtml from "./policy/policy.html?raw";

const RootLayout = (): JSX.Element => (
  <div className="min-h-svh bg-background text-foreground">
    <header className="border-b">
      <nav
        className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5"
        aria-label="Principal"
      >
        <Link className="font-heading text-xl font-semibold" to="/">
          fidy
        </Link>
        <Link className="text-sm text-muted-foreground hover:text-foreground" to="/politica">
          Política de privacidad
        </Link>
      </nav>
    </header>
    <Outlet />
  </div>
);

const Home = (): JSX.Element => (
  <main className="mx-auto flex min-h-[70svh] max-w-3xl items-center px-6 py-16">
    <div className="flex flex-col gap-4">
      <p className="text-sm font-medium text-muted-foreground">
        Finanzas personales, con claridad.
      </p>
      <h1 className="font-heading text-5xl font-semibold tracking-tight">Fidy</h1>
    </div>
  </main>
);

const Policy = (): JSX.Element => (
  <main className="mx-auto max-w-3xl px-6 py-12">
    {/* The fragment is immutable, source-controlled legal copy; it contains no caller input. */}
    <article
      className="policy flex flex-col gap-4"
      dangerouslySetInnerHTML={{ __html: policyHtml }}
    />
  </main>
);

const NotFound = (): JSX.Element => (
  <main className="mx-auto flex min-h-[70svh] max-w-3xl items-center px-6 py-16">
    <div className="flex flex-col gap-4">
      <h1 className="font-heading text-4xl font-semibold tracking-tight">Página no encontrada</h1>
      <Link className="text-muted-foreground underline underline-offset-4" to="/">
        Volver al inicio
      </Link>
    </div>
  </main>
);

type WebRouterContext = Readonly<{ apiClient: FidyClient }>;

const rootRoute = createRootRouteWithContext<WebRouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
});
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });
const policyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/politica",
  component: Policy,
});
const routeTree = rootRoute.addChildren([homeRoute, policyRoute]);

type WebRouterOptions = WebRouterContext & Readonly<{ history: Option.Option<RouterHistory> }>;

/** Builds the same route tree for browser startup and isolated memory-history tests. */
export const createWebRouter = (options: WebRouterOptions): ReturnType<typeof createRouter> =>
  createRouter({
    routeTree,
    context: { apiClient: options.apiClient },
    history: Option.getOrUndefined(options.history),
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createWebRouter>;
  }
}
