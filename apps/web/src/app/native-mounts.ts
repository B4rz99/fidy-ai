import { Effect, Schema, type Scope } from "effect";
import { Mount } from "foldkit";
import { Message } from "./native-model";
import { AppRoute } from "./native-routes";
import type { ApplicationOwner } from "./native-lifetime";
import { mountPersistentAgent, mountRoutePage } from "./native-pages";
import type { ApplicationMounts } from "./native-view";

const scoped = (
  acquire: () => () => void
): Effect.Effect<Extract<Message, { _tag: "Mounted" }>, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(acquire), (release) => Effect.sync(release)).pipe(
    Effect.as(Message.Mounted())
  );
const dismiss = (element: HTMLElement): (() => void) => {
  const click = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest("a") !== null) {
      element.querySelector<HTMLElement>("[popover]")?.hidePopover();
    }
  };
  element.addEventListener("click", click);
  return (): void => element.removeEventListener("click", click);
};
/** Each embedded feature belongs to both its DOM scope and its authentication lifetime. */
export const makeApplicationMounts = (owner: ApplicationOwner): ApplicationMounts => ({
  page: Mount.define("ApplicationPage", {
    args: { route: AppRoute, epoch: Schema.Int },
    messages: [Message.Mounted],
    execute: ({ element, route, epoch }) =>
      scoped(() =>
        element instanceof HTMLElement
          ? owner.retain({
              epoch,
              mount: (lifetime) => mountRoutePage({ container: element, route, lifetime, owner }),
            })
          : (): void => undefined
      ),
  }),
  agent: Mount.define("ApplicationConversation", {
    args: { epoch: Schema.Int },
    messages: [Message.Mounted],
    execute: ({ element, epoch }) =>
      scoped(() =>
        element instanceof HTMLElement
          ? owner.retain({
              epoch,
              mount: (lifetime) => mountPersistentAgent({ container: element, lifetime }),
            })
          : (): void => undefined
      ),
  }),
  navigation: Mount.define("ApplicationNavigation", {
    messages: [Message.Mounted],
    execute: ({ element }) =>
      scoped(() => (element instanceof HTMLElement ? dismiss(element) : (): void => undefined)),
  }),
  closePopup: Mount.define("ProviderReturnPopup", {
    messages: [Message.Mounted],
    execute: () =>
      Effect.sync(() => {
        window.close();
        return Message.Mounted();
      }),
  }),
});
