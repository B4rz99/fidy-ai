import type { ReactNode } from "react";

export const PhoneContent = ({
  conversation,
  controls,
}: {
  conversation: ReactNode;
  controls: ReactNode;
}): React.JSX.Element => (
  <>
    {" "}
    <div className="demo-shell">
      <div className="hero-stage">
        <img
          className="brand-companion"
          src="/fidy-mascot.webp"
          srcSet="/fidy-mascot-small.webp 220w, /fidy-mascot.webp 420w"
          sizes="(max-width: 600px) 110px, (max-width: 1100px) 150px, 200px"
          alt="Tití cabeciblanco, compañero de Fidy"
          width={420}
          height={420}
        />
        <div className="halo"></div>
        <span className="coin" aria-hidden="true">
          {"$"}
        </span>
        <div className="phone">
          <div className="phone-top">
            <span>{"9:41"}</span>
            <span>{"●●● ▰"}</span>
          </div>
          <div className="chat-head">
            <span aria-hidden="true">{"‹"}</span>
            <span className="avatar">{"f"}</span>
            <div>
              <strong>{"fidy"}</strong>
              <small>{"Tu asistente · WhatsApp"}</small>
            </div>
          </div>
          {conversation}
          <div className="chat-input">
            <span>{"Escribe a Fidy…"}</span>
          </div>
        </div>
        <div className="floating-note">
          <span className="note-label">{"Restaurantes · Octubre"}</span>
          <br />
          <strong>{"$216.000"}</strong>
          {" disponibles"}
          <div className="mini-track">
            <span></span>
          </div>
          <span className="note-label">{"64% del presupuesto registrado"}</span>
        </div>
      </div>
      {controls}
    </div>{" "}
  </>
);
