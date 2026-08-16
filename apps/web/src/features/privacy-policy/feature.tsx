import policyHtml from "./policy.html?raw";
import { PublicPage } from "@/ui/public-page";

/** Renders the immutable public privacy policy feature from its source-controlled legal copy. */
export const PrivacyPolicyFeature = (): React.JSX.Element => (
  <PublicPage layout="document">
    {/* The fragment is immutable, source-controlled legal copy; it contains no caller input. */}
    <article
      className="policy flex flex-col gap-4"
      dangerouslySetInnerHTML={{ __html: policyHtml }}
    />
  </PublicPage>
);
