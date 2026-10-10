import { Option } from "effect";

/** Version of the installable CLI candidate; publishing remains a separate release action. */
export const cliVersion = "0.1.0";

/** Public installation diagnostics never open a credential store or make a network request. */
export const installationOutput = (args: ReadonlyArray<string>): Option.Option<string> => {
  if (args.length !== 1) return Option.none();
  if (args[0] === "--version") return Option.some(`fidy ${cliVersion}\n`);
  if (args[0] === "--license") {
    return Option.some(
      `Fidy CLI ${cliVersion}: licencias y código fuente.\n\n` +
        "Incluye código cubierto por Apple Public Source License 2.0.\n" +
        "Código fuente original, modificaciones y material para recompilar:\n" +
        `https://github.com/B4rz99/fidy-ai/releases/download/cli-v${cliVersion}/fidy-cli-v${cliVersion}-source.tar.gz\n\n` +
        "Los avisos completos acompañan al ejecutable: BUN-LICENSE.txt y THIRD-PARTY-NOTICES.txt.\n" +
        "El instalador añade el prefijo fidy- a esos dos archivos.\n"
    );
  }
  if (args[0] !== "--help") return Option.none();
  return Option.some(
    "Fidy — tus finanzas desde la terminal.\n\n" +
      "fidy login       Autoriza el acceso en tu navegador.\n" +
      "fidy status      Consulta el acceso guardado.\n" +
      "fidy logout      Elimina el acceso guardado en este equipo.\n" +
      "fidy commands    Lista operaciones según los permisos de tu acceso.\n" +
      "fidy --license   Consulta los avisos de licencia y el código fuente.\n" +
      "fidy GRUPO OPERACIÓN --help    Consulta la entrada de una operación.\n\n" +
      "Instalación y requisitos: docs/guides/cli-installation.md en B4rz99/fidy-ai.\n"
  );
};
