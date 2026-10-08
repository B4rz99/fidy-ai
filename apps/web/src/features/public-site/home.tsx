import { HomeContent } from "@/features/public-site/landing/home-content";
import { LandingTheme } from "@/features/public-site/landing/theme";
import "@/features/public-site/landing/landing.css";

/** Presents the approved public landing and local-only product demonstrations. */
export const PublicHome = (): React.JSX.Element => (
  <LandingTheme detail={false}>
    <title>Fidy — Tu plata, más clara</title>
    <meta
      name="description"
      content="Tus registros financieros, presupuestos y hallazgos en un mismo sistema. Usa Fidy conversando, desde la web o con tus propios agentes. Hecho para Colombia."
    />
    <HomeContent />
  </LandingTheme>
);
