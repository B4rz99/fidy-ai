import { Effect, Schema } from "effect";
import { Mount } from "foldkit";
import { fidyLogoUrl } from "@/ui/brand";
import { Message, type ViewConfiguration, type ViewContent } from "./model";

const origin = "https://app.fidyapp.com";
type Metadata = Readonly<{
  title: string;
  path: string;
  description: string;
  noIndex: boolean;
}>;
const metadataFields = ({
  title,
  path,
  description,
  noIndex,
}: Metadata): ReadonlyArray<
  Readonly<{
    attribute: string;
    name: string;
    content: string;
  }>
> => [
  ...(noIndex === true ? [{ attribute: "name", name: "robots", content: "noindex" }] : []),
  {
    attribute: "name",
    name: "description",
    content: description,
  },
  ...Object.entries({
    type: "website",
    locale: "es_CO",
    site_name: "Fidy",
    title,
    description,
    url: `${origin}${path}`,
    image: new URL(fidyLogoUrl, origin).href,
    "image:alt": "Fidy",
  }).map(([name, content]) => ({
    attribute: "property",
    name: `og:${name}`,
    content,
  })),
  ...Object.entries({
    card: "summary",
    title,
    description,
    image: new URL(fidyLogoUrl, origin).href,
  }).map(([name, content]) => ({
    attribute: "name",
    name: `twitter:${name}`,
    content,
  })),
];
/** Owns only page metadata created by this mount, releasing it before the next page mounts. */
export const bindPublicMetadata = (metadata: Metadata): (() => void) => {
  const previousTitle = document.title;
  document.title = metadata.title;
  const nodes: Array<HTMLElement> = metadataFields(metadata).map(({ attribute, name, content }) => {
    const node = document.createElement("meta");
    node.setAttribute(attribute, name);
    node.content = content;
    return node;
  });
  const canonical = document.createElement("link");
  canonical.rel = "canonical";
  canonical.href = `${origin}${metadata.path}`;
  nodes.push(canonical);
  for (const node of nodes) document.head.append(node);
  return (): void => {
    for (const node of nodes) node.remove();
    if (document.title === metadata.title) document.title = previousTitle;
  };
};
const MetadataMount = Mount.define("PublicPageMetadata", {
  args: {
    title: Schema.String,
    path: Schema.String,
    description: Schema.String,
    noIndex: Schema.Boolean,
  },
  messages: [Message.Mounted],
  execute: (metadata) =>
    Effect.acquireRelease(
      Effect.sync(() => bindPublicMetadata(metadata)),
      (release) => Effect.sync(release)
    ).pipe(Effect.as(Message.Mounted())),
});
export const PublicMetadata = (configuration: ViewConfiguration & Metadata): ViewContent => {
  const html = configuration.html;
  return [
    html.span([
      html.Hidden(true),
      html.Key(configuration.path),
      html.OnMount(
        MetadataMount({
          title: configuration.title,
          path: configuration.path,
          description: configuration.description,
          noIndex: configuration.noIndex === true,
        })
      ),
    ]),
  ];
};
