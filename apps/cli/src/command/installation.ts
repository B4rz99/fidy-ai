import { Option } from "effect";

/** Version of the installable CLI candidate; publishing remains a separate release action. */
export const cliVersion = "0.1.0";

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
      "Instalación y requisitos: docs/guides/cli-installation.md en B4rz99/fidy-ai.\n"
  );
};
