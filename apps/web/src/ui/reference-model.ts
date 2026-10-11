import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import type { HtmlBuilder } from "foldkit/html";

export const Model = Schema.Struct({
  theme: Schema.Literals(["light", "dark", "system"]),
  palette: Schema.Literals(["charcoal", "graphite", "olive", "espresso"]),
  systemDark: Schema.Boolean,
  search: Schema.String,
  date: Schema.String,
  category: Schema.String,
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
  Theme: { theme: Model.fields.theme },
  Palette: { palette: Model.fields.palette },
  System: { dark: Schema.Boolean },
  Field: { field: Schema.Literals(["search", "date", "category"]), value: Schema.String },
});
export type Message = typeof Message.Type;
export type ViewConfiguration = Readonly<{ html: HtmlBuilder<Message>; model: Model }>;
