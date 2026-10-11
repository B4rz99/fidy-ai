import { Effect, Layer, Queue, Stream } from "effect";
import { Command, Runtime, Subscription, type Update } from "foldkit";
import { Message, Model, isDark } from "./model";
import { makePublicMounts } from "./mounts";
import { publicView } from "./view";
import "../landing/landing.css";

const storageKey = "fidy-landing-theme";
const readTheme = (): Model["theme"] => {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved === "dark" || saved === "light" ? saved : "system";
  } catch {
    return "system";
  }
};
const StoreTheme = Command.define("StorePublicTheme", {
  args: {
    theme: Model.fields.theme,
  },
  messages: [Message.Completed],
  execute: ({ theme }) =>
    Effect.sync(() => {
      try {
        localStorage.setItem(storageKey, theme);
      } catch {
        /* This visit still keeps its display preference. */
      }
      return Message.Completed();
    }),
});
const clicked = (
  model: Model,
  message: Extract<
    Message,
    {
      _tag: "Clicked";
    }
  >
): Model => {
  switch (message.kind) {
    case "Feature":
      return {
        ...model,
        feature: message.index,
        featureInstant: message.instant,
      };
    case "Phone":
      return {
        ...model,
        scenario: message.index,
      };
    case "Replay":
      return model;
    case "Story":
      return {
        ...model,
        recorded: !model.recorded,
        storyInstant: message.instant,
      };
    case "Price":
      return {
        ...model,
        price: message.index,
        priceInstant: message.instant,
      };
  }
};
const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    Clicked: (message) => ({
      model: clicked(model, message),
    }),
    SelectFeature: ({ index }) => ({
      model: {
        ...model,
        feature: index,
        featureInstant: true,
      },
    }),
    Correct: () => ({
      model: {
        ...model,
        corrected: !model.corrected,
      },
    }),
    ToggleTheme: () => {
      const theme = isDark(model) ? "light" : "dark";
      return {
        model: {
          ...model,
          theme,
        },
        commands: [
          StoreTheme({
            theme,
          }),
        ],
      };
    },
    SystemTheme: ({ dark }) => ({
      model: {
        ...model,
        systemDark: dark,
      },
    }),
    Mounted: () => ({
      model,
    }),
    Completed: () => ({
      model,
    }),
  });
/** Mounts public presentation and local demonstrations without any financial transport. */
export const mountPublicSite = ({
  container,
  page,
  headOwnership,
}: Readonly<{
  container: HTMLElement;
  page: string;
  headOwnership: "Feature" | "Application";
}>): (() => void) => {
  const queue = Effect.runSync(Queue.unbounded<Message>());
  let active = true;
  let current: Model = {
    page,
    theme: readTheme(),
    systemDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    feature: 0,
    featureInstant: false,
    scenario: 0,
    corrected: false,
    recorded: false,
    storyInstant: false,
    price: 1,
    priceInstant: false,
  };
  const mounts = makePublicMounts({
    current: () => current,
    dispatch: (message) => {
      if (active) Queue.offerUnsafe(queue, message);
    },
  });
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources: Layer.empty,
      devTools: false,
      update,
      init: (): Update.Return<Model, Message> => ({
        model: current,
      }),
      subscriptions: Subscription.make<Model, Message>()(() => ({
        interactions: Subscription.persistent(Stream.fromQueue(queue)),
      })),
      view: (model, html) => {
        current = model;
        return publicView({
          model,
          headOwnership,
          html,
          mounts,
        });
      },
    })
  );
  return (): void => {
    active = false;
    handle.dispose();
  };
};
