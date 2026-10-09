import { logoUrl } from "@/features/public-site/landing/assets";

const origin = "https://app.fidyapp.com";

/** Describes one public page without claiming unverified ratings or product availability. */
export const PublicMetadata = ({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): React.JSX.Element => (
  <>
    <title>{title}</title>
    <meta name="description" content={description} />
    <link rel="canonical" href={`${origin}${path}`} />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="es_CO" />
    <meta property="og:site_name" content="Fidy" />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:url" content={`${origin}${path}`} />
    <meta property="og:image" content={new URL(logoUrl, origin).href} />
    <meta property="og:image:alt" content="Fidy" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content={title} />
    <meta name="twitter:description" content={description} />
    <meta name="twitter:image" content={new URL(logoUrl, origin).href} />
  </>
);
