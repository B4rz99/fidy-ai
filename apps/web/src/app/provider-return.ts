const providerReturnPaths = new Set(["/auth/google-return", "/auth/microsoft-return"]);

const closeProviderReturn = (): void => {
  const root = document.querySelector("#root") ?? document.body;
  const content = document.createElement("main");
  const message = document.createElement("p");
  message.textContent = "Puedes volver a la ventana de Fidy para continuar.";
  const link = document.createElement("a");
  link.href = "/login";
  link.textContent = "Iniciar sesión";
  content.append(message, link);
  root.replaceChildren(content);
  window.close();
};

/** The return document carries no completion state; the opener owns authenticated polling. */
export const tryMountProviderReturn = (): boolean => {
  if (!providerReturnPaths.has(window.location.pathname)) return false;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", closeProviderReturn, { once: true });
  } else closeProviderReturn();
  return true;
};
