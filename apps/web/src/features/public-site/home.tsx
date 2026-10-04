import { HomeContent } from "@/features/public-site/landing/home-content";
import { Registration } from "@/features/public-site/landing/registration";
import { mountMotion } from "@/features/public-site/landing/motion";
import "@/features/public-site/landing/landing.css";

/** Presents the approved public landing and local-only product demonstrations. */
export const PublicHome = (): React.JSX.Element => (
  <div className="fidy-landing variant-a" ref={mountMotion}>
    <title>Fidy — Tu plata, más clara</title>
    <meta
      name="description"
      content="Tus registros financieros, presupuestos y hallazgos en un mismo sistema. Usa Fidy conversando, desde la web o con tus propios agentes. Hecho para Colombia."
    />
    <Registration>
      <HomeContent />
    </Registration>
  </div>
);
