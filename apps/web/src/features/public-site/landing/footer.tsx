import { fidyLogoUrl } from "@/ui/brand";

/** Keeps privacy, support and agent setup discoverable across marketing pages. */
export const Footer = (): React.JSX.Element => (
  <footer className="footer">
    <div className="wrap">
      <div className="footer-brand">
        <a className="logo" href="/" aria-label="Fidy, inicio">
          <img src={fidyLogoUrl} alt="fidy" />
        </a>
        <p>Finanzas personales para ti y tus agentes.</p>
      </div>
      <nav className="footer-links" aria-label="Información y ayuda">
        <a href="/politica">Política de privacidad</a>
        <a href="/cookies">Cookies y almacenamiento</a>
        <a href="/terminos">Términos de servicio (borrador)</a>
        <a href="mailto:obarboza@fidyapp.com">Contacto y soporte</a>
        <a href="/funciones/agentes#conectar">Conecta tu agente</a>
      </nav>
    </div>
  </footer>
);
