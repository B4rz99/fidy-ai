---
title: Instalar y conectar la CLI
description: Instala Fidy para agentes que trabajan desde una terminal.
---

La CLI permite que una persona o su agente use Fidy desde una terminal. No necesitas clonar el repositorio ni instalar Bun o Node.

## Instala

En macOS Apple Silicon o Linux x64 con glibc:

```sh
curl -fsSL https://fidyapp.com/install.sh | bash
```

En Windows x64, desde PowerShell:

```powershell
& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://fidyapp.com/install.ps1).Content))
```

Abre una terminal nueva si el instalador lo indica. Linux requiere AVX2 y un servicio de credenciales Secret Service, como GNOME Keyring o KWallet. macOS usa Keychain. Los binarios actuales no están firmados; el instalador no evita los controles de seguridad del sistema.

## Conecta

Para consultar:

```sh
fidy login --recipient 'Mi agente' --scopes read --lifetime 7
```

Para consultar, registrar y corregir, usa `--scopes read,write`. Revisa `fidy login --help` para las opciones del ejecutable instalado. El navegador abre la aprobación en `app.fidyapp.com`; comprueba el código mostrado en la terminal, los permisos y el vencimiento antes de aprobar. Usa `--no-browser` si necesitas abrir el enlace manualmente.

La CLI guarda el acceso en el almacén de credenciales del sistema. No copies tokens al chat ni los pases como argumentos.

```sh
fidy status --json
fidy commands --json
fidy transactions listTransactions --help
fidy transactions listTransactions --currency COP --json
```

`status` informa el estado local: no comprueba en ese instante que el servidor conserve el acceso. `commands` descubre las operaciones disponibles con tu permiso.

## Actualiza o desconecta

Vuelve a ejecutar el instalador cuando decidas actualizar. No hay actualizador en segundo plano.

```sh
fidy logout
```

`logout` elimina el acceso local; no revoca el PAT del servidor. Para impedir su uso posterior, revócalo en [Configuración → Tokens personales](https://app.fidyapp.com/settings/access). Eliminar el ejecutable tampoco revoca el acceso.
