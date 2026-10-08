/** Opens the first-party account signup and returning-login surface. */
export const LaunchButton = ({ dark }: { dark: boolean }): React.JSX.Element => (
  <a className={dark ? "btn" : "btn green"} href="/auth/google">
    Empezar con Fidy <span aria-hidden="true">↗</span>
  </a>
);
