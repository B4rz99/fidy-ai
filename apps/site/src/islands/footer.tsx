export const Footer = (): React.JSX.Element => (
  <footer className="footer">
    <div className="wrap">
      <div className="footer-brand">
        <a className="logo" href="/" aria-label="Fidy, inicio">
          <img src="/fidy-logo.webp" alt="fidy" width={160} height={102} />
        </a>
        <p>Finanzas personales para ti y tus agentes.</p>
      </div>
      <nav className="footer-links" aria-label="Información y ayuda">
        <a href="/politica">Política de privacidad</a>
        <a href="/cookies">Cookies y almacenamiento</a>
        <a href="/terminos">Términos de servicio (borrador)</a>
        <a href="/about">Acerca de Fidy</a>
        <a href="/contact">Contacto y soporte</a>
        <a href="/docs">Documentación para agentes</a>
        <a href="/funciones/agentes#conectar">Conecta tu agente</a>
      </nav>
    </div>
  </footer>
);
