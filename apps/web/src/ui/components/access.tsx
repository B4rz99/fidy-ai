import {
  ArrowLeft01Icon,
  Copy01Icon,
  Mail01Icon,
  Moon02Icon,
  Sun03Icon,
  WhatsappIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ComponentProps, type JSX, type ReactNode, type RefCallback, useState } from "react";
import { Effect, Option } from "effect";
import { writeClipboardText } from "@/browser/clipboard";
import { fidyLogoUrl } from "@/ui/brand";
import { Button } from "./button";
import { Input } from "./input";
import { useTheme } from "./theme";
import "./access.css";

const mascot = new URL("../assets/access/mascot.png", import.meta.url).href;
const habitat = new URL("../assets/access/habitat-ceiba.png", import.meta.url).href;
const google = new URL("../assets/access/google.svg", import.meta.url).href;
const microsoft = new URL("../assets/access/microsoft.svg", import.meta.url).href;
export type AccessMethod = "google" | "microsoft" | "email" | "whatsapp";
export const AccessMethodIcon = ({ method }: Readonly<{ method: AccessMethod }>): JSX.Element =>
  method === "google" || method === "microsoft" ? (
    <img src={method === "google" ? google : microsoft} alt="" aria-hidden="true" />
  ) : (
    <HugeiconsIcon
      aria-hidden="true"
      icon={method === "email" ? Mail01Icon : WhatsappIcon}
      strokeWidth={1.5}
    />
  );

export const AccessAction = ({
  kind,
  ...props
}: ComponentProps<typeof Button> &
  Readonly<{
    kind: "primary" | "provider" | "alternative" | "icon" | "back" | "link" | "theme" | "outline";
  }>): JSX.Element => <Button variant="ghost" data-access-action={kind} {...props} />;
export const AccessConsent = ({
  accepted,
  onAcceptedChange,
  policyUrl,
}: Readonly<{
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
  policyUrl: string;
}>): JSX.Element => (
  <label data-access-consent-check="">
    <input
      type="checkbox"
      checked={accepted}
      onChange={(event) => onAcceptedChange(event.target.checked)}
    />
    <span>
      Acepto el tratamiento de datos descrito en la{" "}
      <a href={policyUrl} target="_blank" rel="noopener noreferrer">
        Política de privacidad
      </a>
      .
    </span>
  </label>
);
export const AccessInput = (props: ComponentProps<typeof Input>): JSX.Element => (
  <Input data-access-input="" {...props} />
);
export const AccessBack = ({ onClick }: Readonly<{ onClick: () => void }>): JSX.Element => (
  <AccessAction kind="back" onClick={onClick}>
    <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.5} aria-hidden="true" />
    Opciones de inicio de sesión
  </AccessAction>
);
type AccessHeadingProps =
  | Readonly<{ children: ReactNode }>
  | Readonly<{ children: ReactNode; method: AccessMethod }>;
const focusAccessHeading: RefCallback<HTMLHeadingElement> = (heading) => {
  heading?.focus({ preventScroll: true });
};
export const AccessHeading = (props: AccessHeadingProps): JSX.Element => (
  <h1 data-access-heading="" tabIndex={-1} ref={focusAccessHeading}>
    {props.children}
    {"method" in props ? <AccessMethodIcon method={props.method} /> : null}
  </h1>
);

const methodLabels: Readonly<Record<AccessMethod, string>> = {
  google: "Google",
  microsoft: "Microsoft",
  email: "correo verificado",
  whatsapp: "WhatsApp",
};
const methodTitles: Readonly<Record<AccessMethod, string>> = {
  ...methodLabels,
  email: "Correo verificado",
};
export const AccessAlternatives = ({
  exclude,
  choose,
}: Readonly<{ exclude: AccessMethod; choose: (method: AccessMethod) => void }>): JSX.Element => (
  <nav data-access-alternatives="" aria-label="Otros métodos de inicio de sesión">
    {(["google", "microsoft", exclude === "email" ? "whatsapp" : "email"] as const).map(
      (method) => (
        <AccessAction
          key={method}
          kind="icon"
          aria-label={`Continuar con ${methodLabels[method]}`}
          title={methodTitles[method]}
          onClick={() => choose(method)}
        >
          <AccessMethodIcon method={method} />
        </AccessAction>
      )
    )}
  </nav>
);

export const AccessCode = ({
  code,
  expired,
}: Readonly<{ code: string; expired: boolean }>): JSX.Element => {
  const [feedback, setFeedback] = useState("");
  const copy = (): void => {
    Effect.runCallback(writeClipboardText(Option.fromUndefinedOr(navigator.clipboard), code), {
      onExit: (outcome): void =>
        setFeedback(
          outcome._tag === "Success"
            ? "Código copiado"
            : "No pudimos copiarlo. Selecciona el código para copiarlo."
        ),
    });
  };
  return (
    <>
      <div data-access-code="" data-expired={expired}>
        <span>{code}</span>
        {expired ? null : (
          <AccessAction kind="icon" aria-label="Copiar código" title="Copiar código" onClick={copy}>
            <HugeiconsIcon aria-hidden="true" icon={Copy01Icon} strokeWidth={1.5} />
          </AccessAction>
        )}
      </div>
      <output data-access-copy-status="" aria-live="polite">
        {feedback}
      </output>
    </>
  );
};

const AccessBackground = (): JSX.Element => (
  <>
    <svg width="0" height="0" aria-hidden="true">
      <defs>
        <filter id="access-logo-knockout" colorInterpolationFilters="sRGB">
          <feColorMatrix
            in="SourceGraphic"
            type="matrix"
            values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 3 3 3 0 0"
            result="visible-logo"
          />
          <feComposite in="SourceGraphic" in2="visible-logo" operator="in" />
        </filter>
      </defs>
    </svg>
    <img data-access-habitat="" src={habitat} alt="" aria-hidden="true" />
    <div data-access-ambient="" aria-hidden="true" />
    <svg
      data-access-lines=""
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <path d="M-130 660C80 350 240 810 580 632S1000 175 1580 300" />
      <path d="M-130 684C80 374 240 834 580 656S1000 199 1580 324" />
    </svg>
  </>
);

export const AccessLayout = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => {
  const { theme, toggle, mounted } = useTheme();
  return (
    <div ref={mounted} data-access-root="" className={theme === "dark" ? "dark" : ""}>
      <AccessBackground />
      <div data-access-page="">
        <header data-access-header="">
          <img data-access-logo="" src={fidyLogoUrl} alt="Fidy" />
          <AccessAction
            kind="theme"
            aria-label={theme === "dark" ? "Activar tema claro" : "Activar tema oscuro"}
            title={theme === "dark" ? "Activar tema claro" : "Activar tema oscuro"}
            onClick={toggle}
          >
            <HugeiconsIcon
              aria-hidden="true"
              icon={theme === "dark" ? Sun03Icon : Moon02Icon}
              strokeWidth={1.5}
            />
          </AccessAction>
        </header>
        <div data-access-layout="">
          <section data-access-brand="" aria-label="Fidy">
            <p data-access-slogan="">
              Tu plata,
              <br />
              más clara.
              <br />
              <span>
                Tu vida,
                <br />
                más tranquila.
              </span>
            </p>
            <div data-access-mascot-scene="">
              <img data-access-mascot="" src={mascot} alt="Fidy, el tití cabeciblanco" />
            </div>
          </section>
          <main data-access-content="">{children}</main>
        </div>
      </div>
    </div>
  );
};
