import { Effect, Layer, Queue, Stream } from "effect";
import { Runtime, Subscription, type Update } from "foldkit";
import { Message, Model } from "./reference-model";
import { referenceView } from "./reference-view";
import "./reference.css";

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    Theme: ({ theme }) => ({ model: { ...model, theme } }),
    Palette: ({ palette }) => ({ model: { ...model, palette, theme: "dark" } }),
    System: ({ dark }) => ({ model: { ...model, systemDark: dark } }),
    Field: ({ field, value }) => ({ model: { ...model, [field]: value } }),
  });
/** Mounts local examples using the same native controls and appearance tokens as Fidy. */
export const mountUIReference = (container: HTMLElement): (() => void) => {
  const events = Effect.runSync(Queue.unbounded<Message>());
  const preference = window.matchMedia("(prefers-color-scheme: dark)");
  const changed = (): void => {
    Queue.offerUnsafe(events, Message.System({ dark: preference.matches }));
  };
  preference.addEventListener("change", changed);
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources: Layer.empty,
      devTools: false,
      update,
      init: (): Update.Return<Model, Message> => ({
        model: {
          theme: "dark",
          palette: "graphite",
          systemDark: preference.matches,
          search: "",
          date: "2026-10-09",
          category: "restaurants",
        },
      }),
      subscriptions: Subscription.make<Model, Message>()(() => ({
        preference: Subscription.persistent(Stream.fromQueue(events)),
      })),
      view: (model, html) => referenceView({ model, html }),
    })
  );
  return (): void => {
    preference.removeEventListener("change", changed);
    handle.dispose();
    Effect.runSync(Queue.shutdown(events));
  };
};
