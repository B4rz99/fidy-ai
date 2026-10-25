import { Cancel01Icon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type JSX,
  type ReactNode,
  type RefCallback,
  useCallback,
  useState,
  useSyncExternalStore,
} from "react";
import { Option } from "effect";
import { Button } from "./button";
import "./recurring.css";

// Base UI exposes an extensionless ESM entrypoint.
const { Dialog } = await import("@base-ui/react/dialog");

const desktopQuery = "(min-width: 1280px)";
const isDesktop = (): boolean => window.matchMedia(desktopQuery).matches;
const subscribe = (notify: () => void): (() => void) => {
  const media = window.matchMedia(desktopQuery);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
export const RecurringSurface = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => (
  <div data-recurring-slot="workspace">{children}</div>
);
export const RecurringColumns = ({
  children,
  panel,
  open,
}: Readonly<{ children: ReactNode; panel: ReactNode; open: boolean }>): JSX.Element => (
  <div data-recurring-slot="columns" data-panel-open={open}>
    {children}
    {panel}
  </div>
);
type PanelProps = Readonly<{
  children: ReactNode;
  themeControl: ReactNode;
  title: string;
  open: boolean;
  onClose: () => void;
}>;
export const RecurringThemeControl = ({
  theme,
  toggle,
}: Readonly<{ theme: "light" | "dark"; toggle: () => void }>): JSX.Element => (
  <Button
    variant="ghost"
    size="icon"
    onClick={toggle}
    aria-label={theme === "dark" ? "Activar tema claro" : "Activar tema oscuro"}
  >
    <HugeiconsIcon icon={theme === "dark" ? Sun03Icon : Moon02Icon} strokeWidth={1.5} />
  </Button>
);
const PanelActions = ({
  desktop,
  onClose,
  themeControl,
}: Readonly<{ desktop: boolean; onClose: () => void; themeControl: ReactNode }>): JSX.Element => (
  <div data-recurring-slot="panel-actions">
    {!desktop ? themeControl : null}
    <Button variant="ghost" size="icon" onClick={onClose} aria-label="Cerrar">
      <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.5} />
    </Button>
  </div>
);
export const RecurringContextPanel = ({
  children,
  title,
  open,
  onClose,
  themeControl,
}: PanelProps): JSX.Element => {
  const desktop = useSyncExternalStore(subscribe, isDesktop);
  const [container, setContainer] = useState<Option.Option<HTMLDivElement>>(() => Option.none());
  const mounted = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setContainer(node === null ? Option.none() : Option.some(node));
  }, []);
  return (
    <div ref={mounted} data-recurring-slot="panel-mount" hidden={!open}>
      <Dialog.Root
        open={open}
        modal={!desktop}
        disablePointerDismissal={desktop}
        onOpenChangeComplete={(opened) => {
          if (!opened) onClose();
        }}
        onOpenChange={(value) => {
          if (!value) onClose();
        }}
      >
        <Dialog.Portal container={Option.getOrNull(container)}>
          {!desktop ? <Dialog.Backdrop data-recurring-slot="panel-backdrop" /> : null}
          <Dialog.Popup
            aria-hidden={!open}
            data-recurring-slot={desktop ? "context-panel" : "mobile-panel"}
            className="signed-in-theme"
          >
            <div data-recurring-slot="panel-body">
              <div data-recurring-slot="panel-heading">
                <Dialog.Title>{title}</Dialog.Title>
                <PanelActions desktop={desktop} onClose={onClose} themeControl={themeControl} />
              </div>
              {children}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
};
