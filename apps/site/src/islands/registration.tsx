const launchClass: Readonly<Record<"light" | "dark", string>> = { light: "btn green", dark: "btn" };

const launchMark: Readonly<Record<"arrow" | "none", React.JSX.Element>> = {
  arrow: <span aria-hidden="true">↗</span>,
  none: <></>,
};

export const LaunchButton = ({
  surface,
  mark,
}: {
  surface: keyof typeof launchClass;
  mark: keyof typeof launchMark;
}): React.JSX.Element => (
  <a className={launchClass[surface]} href="https://app.fidyapp.com/login">
    Crear mi cuenta {launchMark[mark]}
  </a>
);
