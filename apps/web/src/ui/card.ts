import type { Html, HtmlBuilder } from "foldkit/html";
import { cn } from "./class-names";

/** Presents a titled content group with optional actions, using the shared card appearance. */
export const card = <Message>({
  html,
  title,
  description,
  content,
  footer,
  className,
}: Readonly<{
  html: HtmlBuilder<Message>;
  title: string;
  description: string;
  content: ReadonlyArray<Html | string>;
  footer: ReadonlyArray<Html | string>;
  className: string;
}>): Html =>
  html.section(
    [
      html.Class(
        cn(
          "flex flex-col gap-4 overflow-hidden rounded-xl bg-card py-4 text-card-foreground ring-1 ring-foreground/10",
          className
        )
      ),
      html.DataAttribute("slot", "card"),
    ],
    [
      html.header(
        [html.Class("px-4")],
        [
          html.h1([html.Class("font-heading text-lg leading-snug font-semibold")], [title]),
          html.p([html.Class("text-sm text-muted-foreground")], [description]),
        ]
      ),
      html.div([html.Class("flex flex-col gap-3 px-4")], content),
      ...(footer.length === 0
        ? []
        : [
            html.footer(
              [html.Class("-mb-4 flex flex-wrap gap-2 border-t bg-muted/50 p-4")],
              footer
            ),
          ]),
    ]
  );
