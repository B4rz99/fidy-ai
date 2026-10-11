import { Effect, Schema, type Scope } from "effect";
import { Mount } from "foldkit";
import { mountMotion } from "@/features/public-site/landing/motion";
import {
  mountChannels,
  mountConversation,
  mountPreview,
} from "@/features/public-site/landing/demo-motion";
import { mountIndicator } from "@/features/public-site/landing/tab-indicator";
import { bindPublicClick, bindPublicDisclosure, bindPublicNavigation } from "./browser";
import { ClickKind, Message, type Model, type PublicMounts } from "./model";

type Configuration = Readonly<{
  current: () => Model;
  dispatch: (message: Message) => void;
}>;
const scoped = (
  acquire: () => () => void
): Effect.Effect<
  Extract<
    Message,
    {
      _tag: "Mounted";
    }
  >,
  never,
  Scope.Scope
> =>
  Effect.acquireRelease(Effect.sync(acquire), (release) => Effect.sync(release)).pipe(
    Effect.as(Message.Mounted())
  );
export const makePublicMounts = ({ current, dispatch }: Configuration): PublicMounts => {
  const basic = (
    name: string,
    bind: (element: HTMLElement) => () => void
  ): (() => Mount.MountAction<Message>) =>
    Mount.define(name, {
      messages: [Message.Mounted],
      execute: ({ element }) =>
        scoped(() => (element instanceof HTMLElement ? bind(element) : () => undefined)),
    });
  const div =
    (bind: (element: HTMLDivElement) => () => void): ((element: HTMLElement) => () => void) =>
    (element) =>
      element instanceof HTMLDivElement ? bind(element) : (): void => undefined;
  return {
    motion: basic("PublicSiteMotion", (element) => {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const change = (): void =>
        dispatch(
          Message.SystemTheme({
            dark: media.matches,
          })
        );
      media.addEventListener("change", change);
      const release =
        current().page === "/" && element instanceof HTMLDivElement
          ? mountMotion(element)
          : (): void => undefined;
      return (): void => {
        media.removeEventListener("change", change);
        release();
      };
    }),
    channels: basic("PublicChannelsMotion", div(mountChannels)),
    conversation: basic("PublicConversationMotion", div(mountConversation)),
    preview: basic("PublicPreviewMotion", div(mountPreview)),
    indicator: basic("PublicFeatureIndicator", div(mountIndicator)),
    navigation: basic("PublicNavigation", bindPublicNavigation),
    disclosure: basic("PublicDisclosure", bindPublicDisclosure),
    click: Mount.define("PublicInteraction", {
      args: {
        kind: ClickKind,
        index: Schema.Int,
      },
      messages: [Message.Mounted],
      execute: ({ kind, index, element }) =>
        scoped(() =>
          element instanceof HTMLElement
            ? bindPublicClick({
                element,
                kind,
                index,
                current,
                dispatch,
              })
            : () => undefined
        ),
    }),
  };
};
