import { mountMotion } from "../islands/motion";

type Theme = "system" | "light" | "dark";
const storedTheme = (): Theme => {
  try {
    const saved = localStorage.getItem("fidy-landing-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "system";
};

const mountTheme = (root: HTMLDivElement): void => {
  const preference = window.matchMedia("(prefers-color-scheme: dark)");
  let theme = storedTheme();
  const isDark = (): boolean => theme === "dark" || (theme === "system" && preference.matches);
  const updateTheme = (): void => {
    root.dataset.theme = theme;
    const canvasColor = getComputedStyle(document.documentElement).backgroundColor;
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = canvasColor;
    }
    const label = isDark() ? "Activar tema claro" : "Activar tema oscuro";
    for (const button of document.querySelectorAll<HTMLButtonElement>(".theme-toggle")) {
      button.setAttribute("aria-label", label);
      button.title = label;
    }
  };
  updateTheme();
  preference.addEventListener("change", updateTheme);
  for (const button of document.querySelectorAll<HTMLButtonElement>(".theme-toggle")) {
    button.addEventListener("click", () => {
      theme = isDark() ? "light" : "dark";
      try {
        localStorage.setItem("fidy-landing-theme", theme);
      } catch {}
      updateTheme();
    });
  }
};

const root = document.querySelector<HTMLDivElement>(".fidy-landing");
if (root !== null) {
  mountTheme(root);
  if (!root.classList.contains("feature-detail-open")) {
    const stopMotion = mountMotion(root);
    window.addEventListener("pagehide", stopMotion, { once: true });
  }
}
for (const summary of document.querySelectorAll("summary")) {
  summary.addEventListener("click", (event) => {
    const disclosure = summary.closest("details");
    if (disclosure !== null) disclosure.dataset.instant = String(event.detail === 0);
  });
}
const menu = document.querySelector<HTMLElement>(".compact-navigation");
document.querySelector(".nav-toggle")?.addEventListener("click", (event) => {
  if (menu !== null) {
    menu.dataset.motion = event instanceof MouseEvent && event.detail !== 0 ? "pointer" : "instant";
  }
});
menu?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") menu.dataset.motion = "instant";
});
for (const link of menu?.querySelectorAll("a") ?? []) {
  link.addEventListener("click", () => menu?.hidePopover());
}
