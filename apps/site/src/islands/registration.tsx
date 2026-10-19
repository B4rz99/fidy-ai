export const LaunchButton = ({
  dark,
  arrow,
}: {
  dark: boolean;
  arrow: boolean;
}): React.JSX.Element => (
  <a className={dark ? "btn" : "btn green"} href="https://app.fidyapp.com/login">
    Crear mi cuenta {arrow && <span aria-hidden="true">↗</span>}
  </a>
);
