import type { KeyboardEvent, MouseEvent } from "react";
import { logoUrl } from "./assets";
import { LaunchButton } from "./registration";
import { ThemeToggle } from "./theme";

const links = [
  ["como", "Cómo funciona"],
  ["funciones", "Funciones"],
  ["precios", "Precios"],
  ["preguntas", "Preguntas frecuentes"],
] as const;

const prepareMenuMotion = (event: MouseEvent<HTMLButtonElement>): void => {
  const panel = event.currentTarget
    .closest("header")
    ?.querySelector<HTMLElement>(".compact-navigation");
  if (panel !== null && panel !== undefined) {
    panel.dataset.motion = event.detail === 0 ? "instant" : "pointer";
  }
};

const instantOnEscape = (event: KeyboardEvent<HTMLElement>): void => {
  if (event.key !== "Escape") return;
  const panel = event.currentTarget
    .closest("header")
    ?.querySelector<HTMLElement>(".compact-navigation");
  if (panel !== null && panel !== undefined) panel.dataset.motion = "instant";
};

/** Uses native light dismissal and Escape handling for compact navigation. */
export const Header = (): React.JSX.Element => (
  <header className="wrap nav main-nav">
    <a className="logo" href="/" aria-label="Fidy, inicio">
      <img src={logoUrl} alt="fidy" />
    </a>
    <nav className="navlinks" aria-label="Principal">
      {links.map(([id, label]) => (
        <a key={id} href={`#${id}`}>
          {label}
        </a>
      ))}
    </nav>
    <div className="navend">
      <a className="textlink" href="#demo">
        Ver una conversación
      </a>
      <LaunchButton dark={false} arrow={false} />
      <ThemeToggle />
      <button
        className="nav-toggle"
        type="button"
        popoverTarget="compact-navigation"
        onClick={prepareMenuMotion}
        onKeyDown={instantOnEscape}
        aria-label="Menú de navegación"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path className="menu-bars" d="M4 6h16M4 12h16M4 18h16" />
          <path className="menu-close" d="M6 6l12 12M6 18 18 6" />
        </svg>
      </button>
    </div>
    <nav
      id="compact-navigation"
      className="compact-navigation"
      popover="auto"
      aria-label="Navegación compacta"
    >
      {links.map(([id, label]) => (
        <a
          key={id}
          href={`#${id}`}
          onKeyDown={instantOnEscape}
          onClick={(event) => event.currentTarget.closest<HTMLElement>("nav")?.hidePopover()}
        >
          {label}
        </a>
      ))}
    </nav>
  </header>
);
