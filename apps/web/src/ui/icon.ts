import { type CreditCardIcon } from "@hugeicons/core-free-icons";
import { Option, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

export type IconData = typeof CreditCardIcon;
const svgTag = Schema.decodeUnknownOption(
  Schema.Literals(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "g"])
);
/** Renders the upstream static icon geometry directly as decorative native SVG. */
export const icon = <Message>({
  html,
  data,
  size,
  className,
}: Readonly<{
  html: HtmlBuilder<Message>;
  data: IconData;
  size: number;
  className: string;
}>): Html =>
  html.svg(
    [
      html.ViewBox("0 0 24 24"),
      html.Width(String(size)),
      html.Height(String(size)),
      html.Fill("none"),
      html.Stroke("currentColor"),
      html.StrokeWidth("1.5"),
      html.AriaHidden(true),
      html.Class(className),
    ],
    data.map(([tag, attributes]) => {
      const name = Option.getOrThrow(svgTag(tag));
      return html[name](
        Object.entries(attributes).map(([key, value]) =>
          key === "key"
            ? html.Key(String(value))
            : html.Attribute(
                key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`),
                String(value)
              )
        )
      );
    })
  );
