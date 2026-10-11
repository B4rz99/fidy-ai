import { Effect, Layer, Queue, Schema, Stream } from "effect";
import { Command, Runtime, Subscription, type Update } from "foldkit";
import { UrlRequest, load, pushUrl, replaceUrl } from "foldkit/navigation";
import { type Url, toString } from "foldkit/url";
import { makeAuthenticationLifetime } from "@/session/lifetime";
import { Message, Model } from "./native-model";
import { AppRoute, parseAppRoute } from "./native-routes";
import {
  type ApplicationOwner,
  type LifetimeFactory,
  authResources,
  makeApplicationOwner,
} from "./native-lifetime";
import { makeApplicationMounts } from "./native-mounts";
import { applicationView } from "./native-view";
import { restoreScroll } from "./native-navigation";

const Navigate = Command.define("NavigateApplication", {
  args: { href: Schema.String, replace: Schema.Boolean },
  messages: [Message.Completed],
  execute: ({ href, replace }) =>
    (replace ? replaceUrl(href) : pushUrl(href)).pipe(Effect.as(Message.Completed())),
});
const External = Command.define("OpenExternalDestination", {
  args: { href: Schema.String },
  messages: [Message.Completed],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.Completed())),
});
const makeLogout = (
  owner: ApplicationOwner
): ((args: Readonly<{ epoch: number }>) => Command.Command<Message>) =>
  Command.define("LogoutApplication", {
    args: { epoch: Schema.Int },
    messages: [Message.Completed, Message.FailedLogout],
    execute: ({ epoch }) =>
      Effect.gen(function* () {
        const snapshot = owner.current();
        if (!owner.isCurrent(epoch)) return Message.Completed();
        const resources = yield* Layer.build(authResources(snapshot.lifetime));
        yield* snapshot.lifetime.webAuthClient.pipe(
          Effect.flatMap((client) => client.browserLogin.logout()),
          Effect.provideContext(resources)
        );
        if (owner.isCurrent(epoch)) {
          owner.transition("signed-out");
          yield* pushUrl("/auth/pair");
        }
        return Message.Completed();
      }).pipe(
        Effect.scoped,
        Effect.catchCause(() => Effect.succeed(Message.FailedLogout({ epoch })))
      ),
  });
type Updated = Update.Return<Model, Message>;
const routed = (model: Model, route: AppRoute): Updated =>
  route._tag === "AppIndex"
    ? {
        model: { ...model, route: AppRoute.Dashboard() },
        commands: [Navigate({ href: "/app/dashboard", replace: true })],
      }
    : { model: { ...model, route } };
const makeUpdate = (owner: ApplicationOwner): ((model: Model, message: Message) => Updated) => {
  const Logout = makeLogout(owner);
  return (model, message) =>
    Message.match<Updated>(message, {
      RequestedUrl: ({ request }) =>
        UrlRequest.match<Updated>(request, {
          Internal: ({ url }) => ({
            model,
            commands: [Navigate({ href: toString(url), replace: false })],
          }),
          External: ({ href }) => ({ model, commands: [External({ href })] }),
        }),
      ChangedUrl: ({ url }) => {
        const route = parseAppRoute(url);
        const result = routed(model, route);
        return {
          ...result,
          commands: [
            ...(result.commands ?? []),
            restoreScroll({ url, reset: model.route._tag !== route._tag }),
          ],
        };
      },
      ChangedLifetime: ({ epoch, authentication }) =>
        epoch < model.epoch
          ? { model }
          : { model: { ...model, epoch, authentication, logout: "Idle" } },
      ClickedLogout: () =>
        model.logout === "Pending"
          ? { model }
          : { model: { ...model, logout: "Pending" }, commands: [Logout({ epoch: model.epoch })] },
      FailedLogout: ({ epoch }) =>
        epoch !== model.epoch ? { model } : { model: { ...model, logout: "Failed" } },
      Completed: () => ({ model }),
      Mounted: () => ({ model }),
    });
};
const initialModel = (url: Url): Updated => {
  const result = routed(
    { route: parseAppRoute(url), authentication: "signed-out", epoch: 0, logout: "Idle" },
    parseAppRoute(url)
  );
  return { ...result, commands: [...(result.commands ?? []), restoreScroll({ url, reset: true })] };
};
/** Runs the page-owning Foldkit router with private, replaceable authentication capabilities. */
export const mountWebApplication = ({
  container,
  createLifetime,
}: Readonly<{
  container: HTMLElement;
  createLifetime: LifetimeFactory;
}>): (() => void) => {
  const events = Effect.runSync(Queue.unbounded<Message>());
  let active = true;
  const owner = makeApplicationOwner({
    createLifetime,
    dispatch: (message) => {
      if (active) Queue.offerUnsafe(events, message);
    },
  });
  const mounts = makeApplicationMounts(owner);
  const handle = Runtime.embed(
    Runtime.makeApplication({
      Model,
      container,
      resources: Layer.empty,
      devTools: false,
      routing: {
        onUrlRequest: (request) => Message.RequestedUrl({ request }),
        onUrlChange: (url) => Message.ChangedUrl({ url }),
      },
      init: initialModel,
      update: makeUpdate(owner),
      subscriptions: Subscription.make<Model, Message>()(() => ({
        lifetime: Subscription.persistent(Stream.fromQueue(events)),
      })),
      view: (model, html) => applicationView({ model, html, mounts }),
      crash: {
        report: () => owner.dispose(),
        view: (_, html) => ({
          title: "Fidy",
          body: html.main(
            [],
            [
              html.p(
                [html.Role("alert")],
                ["No pudimos mostrar Fidy. Recarga la página para continuar."]
              ),
            ]
          ),
        }),
      },
    })
  );
  return (): void => {
    active = false;
    owner.dispose();
    handle.dispose();
    Effect.runSync(Queue.shutdown(events));
  };
};
/** Production supplies isolated generated clients, sharing no capability with a prior account. */
export const mountProductionApplication = ({
  container,
  apiOrigin,
}: Readonly<{ container: HTMLElement; apiOrigin: string }>): (() => void) =>
  mountWebApplication({
    container,
    createLifetime: (onExpired) => makeAuthenticationLifetime({ apiOrigin, onExpired }),
  });
