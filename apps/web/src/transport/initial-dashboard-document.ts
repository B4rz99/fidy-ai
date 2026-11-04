type InitialDocumentHtml =
  | Readonly<{ _tag: "Missing" }>
  | Readonly<{ _tag: "Captured"; binding: string; status: string; html: string }>;
type InitialDocumentBootstrap =
  | Readonly<{ _tag: "Missing" }>
  | Readonly<{ _tag: "Captured"; body: string }>;
let bootstrap: InitialDocumentBootstrap = { _tag: "Missing" };
let initial: InitialDocumentHtml = { _tag: "Missing" };

const captureBootstrap = (): InitialDocumentBootstrap => {
  const context = document.getElementById("dashboard-bootstrap");
  const body = context?.textContent;
  context?.remove();
  return body === null || body === undefined ? { _tag: "Missing" } : { _tag: "Captured", body };
};

/** Capture raw document bytes before React replaces them; ordinary codecs validate their claims. */
export const captureInitialDashboardHtml = (): void => {
  bootstrap = captureBootstrap();
  const element = document.getElementById("dashboard-initial");
  const binding = element?.dataset.binding;
  const status = element?.dataset.status;
  initial =
    element === null || binding === undefined || status === undefined
      ? { _tag: "Missing" }
      : { _tag: "Captured", binding, status, html: element.innerHTML };
};

export const takeInitialDocumentHtml = (): InitialDocumentHtml => {
  const available = initial;
  initial = { _tag: "Missing" };
  return available;
};

export const takeInitialDocumentBootstrap = (): InitialDocumentBootstrap => {
  const available = bootstrap;
  bootstrap = { _tag: "Missing" };
  return available;
};
