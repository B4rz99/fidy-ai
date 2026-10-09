/** Opens the first-party account signup and returning-login surface. */
export const LaunchButton = ({
  dark,
  arrow,
}: {
  dark: boolean;
  arrow: boolean;
}): React.JSX.Element => (
  <a className={dark ? "btn" : "btn green"} href="/auth/google">
    Crear mi cuenta {arrow && <span aria-hidden="true">↗</span>}
  </a>
);
