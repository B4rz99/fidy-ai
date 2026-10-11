import { Option } from "effect";

declare const FIDY_CLI_VERSION: string;

/** Release builds embed their assigned version; source execution reports the initial candidate version. */
export const cliVersion = typeof FIDY_CLI_VERSION === "undefined" ? "0.1.0" : FIDY_CLI_VERSION;

/** Public installation diagnostics never open a credential store or make a network request. */
export const installationOutput = (args: ReadonlyArray<string>): Option.Option<string> => {
  if (args.length !== 1) return Option.none();
  if (args[0] === "--version") return Option.some(`fidy ${cliVersion}\n`);
  if (args[0] !== "--help") return Option.none();
  return Option.some(
    "Fidy — tus finanzas desde la terminal.\n\n" +
      "fidy login       Autoriza el acceso en tu navegador.\n" +
      "fidy status      Consulta el acceso guardado.\n" +
      "fidy logout      Elimina el acceso guardado en este equipo.\n" +
      "fidy commands    Lista operaciones según los permisos de tu acceso.\n" +
      "fidy GRUPO OPERACIÓN --help    Consulta la entrada de una operación.\n\n" +
      "Instalación: https://fidyapp.com/install.sh (macOS/Linux), https://fidyapp.com/install.ps1 (Windows).\n"
  );
};
