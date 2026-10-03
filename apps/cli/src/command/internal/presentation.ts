import type { CliFailure } from "../../credential/contract";
import type { PublicOutput } from "../contract";

export const messages: Readonly<Record<PublicOutput["_tag"], string>> = {
  ApprovalRequired: "Aprueba este código en https://fidyapp.com/settings/pats.",
  PollingDelayed:
    "El servidor pide esperar más antes de comprobar la aprobación; los permisos no cambian.",
  LoggedIn: "Acceso guardado en el almacén nativo.",
  LocalStatus: "Estado local; no verifica autorización, revocación ni disponibilidad remota.",
  LoggedOut:
    "Acceso local eliminado. El PAT NO fue revocado; revócalo en https://fidyapp.com/settings/pats si lo necesitas.",
};
const recovery =
  "Comprueba el acceso local con fidy status. Si no hay acceso local utilizable, revisa y revoca el permiso en https://fidyapp.com/settings/pats; después usa fidy logout e inicia una nueva vinculación. No se repite una consulta privada consumida.";
export const failures: Readonly<Record<CliFailure["reason"], string>> = {
  Cancelled: "Proceso interrumpido. Si aprobaste un permiso, " + recovery,
  UnsupportedRuntime:
    "Este CLI requiere el Bun verificado bb35d1b81. Ejecuta bash scripts/install-bun.sh y usa ese ejecutable.",
  InvalidInput:
    "Uso: fidy login [--recipient NOMBRE --scopes read,write,dashboard --lifetime DÍAS] | status | logout [--json]. Selecciona solo los permisos que necesitas.",
  StorageUnavailable:
    "No se puede usar el almacén nativo. Desbloquea Keychain (macOS), inicia Secret Service/GNOME Keyring/KWallet (Linux) o habilita Credential Manager (Windows). No hay alternativa en texto plano. Si persiste, revisa permisos locales y elimina un login.lock abandonado solo cuando no haya otra instancia activa.",
  StorageInconsistent:
    "El acceso local está incompleto o no coincide. Ejecuta logout para limpiarlo. " + recovery,
  AlreadyLoggedIn:
    "Ya existe un acceso local. Ejecuta status o logout antes de iniciar otra vinculación.",
  PairingInvalid: "Esta vinculación es inválida o venció. Comienza una nueva vinculación.",
  SourceLimited:
    "El servidor rechazó la admisión de solicitudes. Espera antes de comenzar otra vinculación. Si ya aprobaste, " +
    recovery,
  DependencyUnavailable:
    "La vinculación no está disponible temporalmente. Inténtalo más tarde. Si ya aprobaste, " +
    recovery,
  TransportUnavailable: "No se pudo iniciar la vinculación de forma segura. Inténtalo más tarde.",
  ClaimAmbiguous: "No se puede confirmar si el servidor entregó el permiso. " + recovery,
  ClaimStorageFailed:
    "El servidor entregó el permiso, pero no se pudo guardar. Ejecuta logout para limpiar el acceso parcial. " +
    recovery,
  Expired:
    "La vinculación venció. Inicia login de nuevo; usar un PAT nunca renueva su vencimiento.",
};
