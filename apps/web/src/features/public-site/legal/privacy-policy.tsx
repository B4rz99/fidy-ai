import policyHtml from "./policy.html?raw";
import { PublicPageLayout } from "@/features/public-site/page-layout";

/** Renders the immutable privacy policy from its source-controlled legal copy. */
export const PrivacyPolicy = (): React.JSX.Element => (
  <PublicPageLayout layout="document">
    {/* The fragment is immutable, source-controlled legal copy; it contains no caller input. */}
    <article
      className="policy flex flex-col gap-4"
      dangerouslySetInnerHTML={{ __html: policyHtml }}
    />
  </PublicPageLayout>
);
