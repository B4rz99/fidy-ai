import { PublicMetadata } from "./metadata";
import { HomeContent } from "@/features/public-site/landing/home-content";
import { LandingTheme } from "@/features/public-site/landing/theme";
import "@/features/public-site/landing/landing.css";

/** Presents the approved public landing and local-only product demonstrations. */
export const PublicHome = (): React.JSX.Element => (
  <LandingTheme detail={false}>
    <PublicMetadata
      title="Fidy — Tu plata, más clara"
      path="/"
      description="Entiende en qué se va tu plata y planea lo que viene. Lleva tus finanzas desde WhatsApp, la web o tu agente de IA."
    />
    <HomeContent />
  </LandingTheme>
);
