import { type ReactNode, createContext, useCallback, useContext, useState } from "react";

const RegistrationContext = createContext(() => {});

/** Keeps the approved registration placeholder local; it never submits account data. */
export const Registration = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const showRegistration = useCallback(() => setOpen(true), []);
  return (
    <RegistrationContext value={showRegistration}>
      {children}
      {open && (
        <dialog
          ref={(node) => {
            node?.showModal();
          }}
          onClose={() => setOpen(false)}
          aria-labelledby="registration-title"
        >
          <h3 id="registration-title">Registro de Fidy</h3>
          <p>Aquí irá el registro de la web app. Por ahora es un placeholder.</p>
          <button
            className="btn"
            onClick={(event) => event.currentTarget.closest("dialog")?.close()}
          >
            Seguir explorando ↗
          </button>
        </dialog>
      )}
    </RegistrationContext>
  );
};

/** Opens the shared registration placeholder from any landing section. */
export const LaunchButton = ({ dark }: { dark: boolean }): React.JSX.Element => {
  const open = useContext(RegistrationContext);
  return (
    <button className={dark ? "btn" : "btn green"} onClick={open}>
      Empezar con Fidy <span aria-hidden="true">↗</span>
    </button>
  );
};
