import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import type { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

export const ClickKind = Schema.Literals(["Feature", "Phone", "Replay", "Story", "Price"]);
export type ClickKind = typeof ClickKind.Type;
export const Model = Schema.Struct({
  page: Schema.String,
  theme: Schema.Literals(["light", "dark", "system"]),
  systemDark: Schema.Boolean,
  feature: Schema.Int,
  featureInstant: Schema.Boolean,
  scenario: Schema.Int,
  corrected: Schema.Boolean,
  recorded: Schema.Boolean,
  storyInstant: Schema.Boolean,
  price: Schema.Int,
  priceInstant: Schema.Boolean,
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
  Clicked: {
    kind: ClickKind,
    index: Schema.Int,
    instant: Schema.Boolean,
  },
  SelectFeature: {
    index: Schema.Int,
  },
  Correct: {},
  ToggleTheme: {},
  SystemTheme: {
    dark: Schema.Boolean,
  },
  Mounted: {},
  Completed: {},
});
export type Message = typeof Message.Type;
export type ViewContent = ReadonlyArray<Html | string>;
export type PublicMounts = Readonly<{
  click: (
    args: Readonly<{
      kind: ClickKind;
      index: number;
    }>
  ) => Mount.MountAction<Message>;
  motion: () => Mount.MountAction<Message>;
  channels: () => Mount.MountAction<Message>;
  conversation: () => Mount.MountAction<Message>;
  preview: () => Mount.MountAction<Message>;
  indicator: () => Mount.MountAction<Message>;
  navigation: () => Mount.MountAction<Message>;
  disclosure: () => Mount.MountAction<Message>;
}>;
export type ViewConfiguration = Readonly<{
  headOwnership: "Feature" | "Application";
  html: HtmlBuilder<Message>;
  model: Model;
  mounts: PublicMounts;
}>;
export const isDark = (model: Model): boolean =>
  model.theme === "dark" || (model.theme === "system" && model.systemDark);
