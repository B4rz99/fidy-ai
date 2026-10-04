import { useState } from "react";
import { logoUrl } from "./assets";
import { LaunchButton } from "./registration";

/** Keeps every section reachable when the full navigation no longer fits. */
export const Header = (): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const escape = (event: React.KeyboardEvent<HTMLAnchorElement | HTMLButtonElement>): void => {
    if (event.key === "Escape" && open) {
      setOpen(false);
      event.currentTarget
        .closest("header")
        ?.querySelector<HTMLButtonElement>(".nav-toggle")
        ?.focus();
    }
  };
  const blur = (event: React.FocusEvent<HTMLAnchorElement | HTMLButtonElement>): void => {
    if (event.currentTarget.closest("header")?.contains(event.relatedTarget) !== true) {
      setOpen(false);
    }
  };
  return (
    <header role="banner" className={`wrap nav main-nav${open ? " nav-open" : ""}`}>
      <a className="logo" href="/" aria-label="Fidy, inicio">
        <img src={logoUrl} alt="fidy" />
      </a>
      <nav className="navlinks" id="main-navigation" aria-label="Principal">
        {[
          ["como", "Cómo funciona"],
          ["funciones", "Funciones"],
          ["precios", "Precios"],
          ["preguntas", "Preguntas frecuentes"],
        ].map(([id, label]) => (
          <a
            onKeyDown={escape}
            onBlur={blur}
            key={id}
            href={`#${id}`}
            onClick={() => setOpen(false)}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="navend">
        <a className="textlink" href="#demo">
          Ver una conversación
        </a>
        <LaunchButton dark={false} />
        <button
          className="nav-toggle"
          onKeyDown={escape}
          onBlur={blur}
          aria-label={open ? "Cerrar menú" : "Abrir menú"}
          aria-expanded={open}
          aria-controls="main-navigation"
          onClick={() => setOpen(!open)}
        >
          <span aria-hidden="true">{open ? "×" : "☰"}</span>
        </button>
      </div>
    </header>
  );
};
