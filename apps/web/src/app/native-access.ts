import { Effect, Layer, Option, Schema } from "effect";
import { Mount, Runtime } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import type { Html, HtmlBuilder } from "foldkit/html";
import { mountElementProgram } from "@/browser/element-program";
import { mountOAuthListing } from "@/features/oauth-connections/feature";
import { mountManualPAT, mountPATListing } from "@/features/pats/feature";
import type { AuthenticationLifetime } from "@/session/lifetime";
import type { OAuthConnectionId } from "@/transport/client";
import { apiResources, authResources } from "./native-lifetime";

const Model = Schema.Struct({});
const Message = defineMessageUnion({ Mounted: {} });

type Configuration = Readonly<{
  container: HTMLElement;
  lifetime: AuthenticationLifetime;
  after: Option.Option<OAuthConnectionId>;
}>;
type AccessMounts = Readonly<{
  listing: Mount.MountAction<typeof Message.Type>;
  connections: Mount.MountAction<typeof Message.Type>;
  manual: Mount.MountAction<typeof Message.Type>;
}>;

const mountChild = ({
  container,
  children,
  active,
  name,
  mount,
}: Readonly<{
  container: HTMLElement;
  children: Set<() => void>;
  active: () => boolean;
  name: string;
  mount: (target: HTMLElement) => () => void;
}>): Mount.MountAction<typeof Message.Type> =>
  Mount.define(name, {
    messages: [Message.Mounted],
    execute: ({ element }) => {
      if (!(element instanceof HTMLElement)) return Effect.succeed(Message.Mounted());
      return Effect.acquireRelease(
        Effect.sync(() => {
          if (!active()) return () => undefined;
          element.id = `${container.id}-${name}`;
          const release = mountElementProgram({ host: element, mount });
          let mounted = true;
          const dispose = (): void => {
            if (!mounted) return;
            mounted = false;
            release();
          };
          children.add(dispose);
          return dispose;
        }),
        (dispose) =>
          Effect.sync(() => {
            children.delete(dispose);
            dispose();
          })
      ).pipe(Effect.as(Message.Mounted()));
    },
  })();

const makeChildren = (
  { container, lifetime, after }: Configuration,
  children: Set<() => void>,
  active: () => boolean
): AccessMounts => {
  let tokens: Option.Option<ReturnType<typeof mountPATListing>> = Option.none();
  const listing = mountChild({
    container,
    children,
    active,
    name: "access-tokens",
    mount: (target): (() => void) => {
      const owner = mountPATListing({
        container: target,
        client: lifetime.apiClient,
        registry: lifetime.registry,
        resources: apiResources(lifetime),
      });
      tokens = Option.some(owner);
      return () => {
        tokens = Option.none();
        owner.dispose();
      };
    },
  });
  const connections = mountChild({
    container,
    children,
    active,
    name: "access-connections",
    mount: (target) =>
      mountOAuthListing({
        container: target,
        client: lifetime.webAuthClient,
        resources: authResources(lifetime),
        after,
      }),
  });
  const manual = mountChild({
    container,
    children,
    active,
    name: "access-create",
    mount: (target) =>
      mountManualPAT({
        container: target,
        client: lifetime.apiClient,
        resources: apiResources(lifetime),
        issued: () => {
          Option.map(tokens, (owner) => owner.refresh());
        },
      }),
  });
  return { listing, connections, manual };
};
const accessView = ({
  html,
  listing,
  connections,
  manual,
}: AccessMounts & Readonly<{ html: HtmlBuilder<typeof Message.Type> }>): Html =>
  html.main(
    [html.Class("flex min-h-svh min-w-0 flex-col")],
    [
      html.header(
        [html.Class("border-b p-5")],
        [
          html.h1([html.Class("font-heading text-2xl font-semibold")], ["Accesos"]),
          html.p(
            [html.Class("mt-1 text-sm text-muted-foreground")],
            ["Administra los tokens y las conexiones de tus agentes."]
          ),
        ]
      ),
      html.div(
        [html.Class("grid min-w-0 flex-1 items-stretch xl:grid-cols-[minmax(0,1fr)_340px]")],
        [
          html.div(
            [html.Class("min-w-0 p-5")],
            [
              html.div([html.Key("access-tokens"), html.OnMount(listing)]),
              html.div([
                html.Key("access-connections"),
                html.Class("mt-6 border-t pt-6"),
                html.OnMount(connections),
              ]),
            ]
          ),
          html.aside(
            [html.Class("min-w-0 border-t bg-card p-5 xl:border-t-0 xl:border-l")],
            [html.div([html.Key("access-create"), html.OnMount(manual)])]
          ),
        ]
      ),
    ]
  );

/** Composes independent token and MCP owners within the authenticated lifetime. */
export const mountAccessPage = (configuration: Configuration): (() => void) => {
  const { container } = configuration;
  const children = new Set<() => void>();
  let active = true;
  const mounts = makeChildren(configuration, children, () => active);
  const clear = (): void => {
    active = false;
    for (const dispose of children) dispose();
    children.clear();
  };
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources: Layer.empty,
      devTools: false,
      init: () => ({ model: {} }),
      update: (model) => ({ model }),
      view: (_, html) => accessView({ html, ...mounts }),
      crash: {
        report: clear,
        view: (_, html) =>
          html.p([html.Role("alert")], ["No pudimos cargar tus accesos. Recarga la página."]),
      },
    })
  );
  return () => {
    clear();
    handle.dispose();
  };
};
