# Research 007: Kapso, Meta y el número de WhatsApp de Fidy

- **Fecha:** 2026-08-04
- **Pregunta:** si Kapso entrega el número que será la interfaz de Fidy, qué hace realmente el sandbox, qué exige Meta para producción y si los issues contemplan constituir la empresa.
- **Método:** revisión de todos los issues del repositorio con `gh issue list --state all --limit 100`, lectura de los issues relacionados y consulta de documentación oficial de Kapso, Meta y Wompi.
- **Convención de evidencia:** **Hecho** = consta en una fuente enlazada; **Conclusión** = aplicación de esos hechos a Fidy. Los issues de GitHub se citan por número y sección; las páginas web, por título/sección, porque no tienen rangos de línea estables.

## Veredicto

1. **El sandbox no es la conexión de producción.** El sandbox de Kapso crea una sesión de prueba con un número de Kapso y autoriza únicamente los números de prueba que se agreguen. No permite plantillas, sincronización desde WhatsApp ni múltiples destinatarios. [Hecho: Kapso, [“Use Kapso Sandbox”, “Limitations”](https://docs.kapso.ai/docs/how-to/whatsapp/use-sandbox-for-testing)]
2. **Para producción sí necesitas activos de Meta**, concretamente un Meta Business Portfolio y un WhatsApp Business Account (WABA). Pero **no tienes que tenerlos creados antes de entrar al flujo de Kapso**: su Embedded Signup permite crear el Portfolio y el WABA durante el proceso, siempre que tengas una cuenta de Facebook/Meta con la que iniciar sesión. [Hecho: [Kapso, “Connect WhatsApp”, “Before you connect”](https://docs.kapso.ai/docs/how-to/whatsapp/connect-whatsapp); [Meta, “About the WhatsApp Business Platform”](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform)]
3. **Kapso no entrega normalmente un número colombiano dedicado por el solo hecho de instalarlo.** Tiene un modo **Instant setup** con un número digital estadounidense pre-verificado de Kapso/BSP, pero para un número colombiano la ruta normal es aportar una SIM/línea propia (**Bring your own SIM**) o usar coexistencia con un número que ya opere en WhatsApp Business. [Hecho: [Kapso, “Connect WhatsApp”, “Connection options”](https://docs.kapso.ai/docs/how-to/whatsapp/connect-whatsapp); [Kapso, “Provide local numbers”](https://docs.kapso.ai/docs/platform/phone-numbers/provide-local-numbers)]
4. **No encontré un issue dedicado a constituir la empresa legal de Fidy** —SAS, persona natural, NIT/RUT, Cámara de Comercio o equivalente. El issue #1 sí contiene decisiones de cumplimiento y deja como puerta de lanzamiento la revisión de un abogado colombiano y el KYB de Wompi, pero no decide la entidad jurídica. [Hecho: [todos los issues del repositorio](https://github.com/B4rz99/fidy-ai/issues); [issue #1, “Compliance posture” y “Further Notes”](https://github.com/B4rz99/fidy-ai/issues/1)]
5. **No se puede concluir que debas constituir una SAS antes de probar la integración.** Meta exige activos empresariales y puede exigir verificación, pero su documentación no dice que la constitución de una sociedad colombiana sea un prerrequisito universal para crear el Portfolio/WABA. Cuando se inicia una verificación, Meta sí pide que los datos coincidan con la entidad legal y puede pedir licencia comercial o documentos de constitución. Wompi, por separado, dice que una persona natural no necesita Cámara de Comercio para registrarse. [Hecho: [Meta, “Verify Your Business on Meta”](https://business.facebook.com/business/help/2058515294227817); [Wompi, “Soy persona natural, ¿Necesito Cámara de comercio para registrarme?”](https://soporte.wompi.co/hc/es-419/articles/360021056453-Soy-persona-natural-Necesito-C%C3%A1mara-de-comercio-para-registrarme)]
6. **Conclusión práctica:** puedes seguir desarrollando y probando con el sandbox. Para probar la experiencia real de Fidy en Colombia, el siguiente bloqueo no es “instalar Kapso”, sino decidir el propietario de los activos, conseguir un número de producción y completar el onboarding de Meta; la decisión persona natural versus sociedad debe abrirse como un issue separado antes del lanzamiento comercial.

## 1. Qué dicen los issues actuales

### Hallazgo: falta la decisión de entidad jurídica

La búsqueda de títulos y cuerpos de los issues actuales no encontró una tarea explícita sobre constituir la empresa. Los asuntos más cercanos son:

| Issue                                                                                            | Qué sí cubre                                                                                                                                                                                                      | Qué no decide                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [#1 — Spec: Agent-first personal finance MVP](https://github.com/B4rz99/fidy-ai/issues/1)        | WhatsApp/Kapso como canal, “no KYC (no funds held)”, postura de “no SFC license needed” para el PFM de solo lectura, política de tratamiento, revisión legal colombiana y KYB de Wompi como gates de lanzamiento. | Persona natural vs. SAS, propietario legal de Fidy, NIT/RUT, Cámara de Comercio, documentos para Meta o titularidad de la WABA. |
| [#8 — Consent gate & in-chat onboarding](https://github.com/B4rz99/fidy-ai/issues/8)             | Consentimiento y política de tratamiento antes de procesar datos.                                                                                                                                                 | Constitución de la entidad.                                                                                                     |
| [#9 — Product name, domain & external endpoints](https://github.com/B4rz99/fidy-ai/issues/9)     | Nombre, dominio, DNS, MX y URLs públicas; está cerrado.                                                                                                                                                           | Registro de la empresa o verificación de Meta.                                                                                  |
| [#10 — WhatsApp channel adapter (Kapso)](https://github.com/B4rz99/fidy-ai/issues/10)            | La implementación espera un teléfono real, E.164, `WhatsAppIdentity`, webhooks y el adaptador Kapso.                                                                                                              | Quién posee el número, el Portfolio/WABA y la cuenta de Meta.                                                                   |
| [#36 — Wompi checkout & tier activation](https://github.com/B4rz99/fidy-ai/issues/36)            | Checkout, precios, KYB de Wompi y activación asíncrona de Pro.                                                                                                                                                    | La entidad jurídica de Fidy; solo cubre el proveedor de pagos.                                                                  |
| [#38 — Data rights, re-consent & the asesoría line](https://github.com/B4rz99/fidy-ai/issues/38) | Derechos de datos, re-consentimiento y línea de asesoría.                                                                                                                                                         | Registro societario y onboarding de Meta.                                                                                       |

**Conclusión:** #1 describe el producto y sus gates legales, pero no resuelve la creación de la empresa. Conviene añadir una decisión explícita, no mezclarla dentro del adaptador Kapso.

## 2. Sandbox de Kapso frente a producción

### Sandbox de Kapso

**Hecho:** el flujo de Kapso es:

1. Ir a `WhatsApp → Sandbox`.
2. Agregar el número desde el que se probará.
3. Activar la sesión enviando un código de seis caracteres al número sandbox de Kapso.
4. Enlazar esa configuración con el agente, flujo o webhook.

Kapso lista estas diferencias: texto e interactivos funcionan; plantillas, sincronización desde WhatsApp y múltiples destinatarios no funcionan. [Fuente: [Kapso, “Use Kapso Sandbox for Testing”](https://docs.kapso.ai/docs/how-to/whatsapp/use-sandbox-for-testing)].

**Conclusión:** que la integración funcione en sandbox demuestra que el adaptador puede probarse, pero no demuestra que Fidy ya tenga un número propio ni que esté lista para recibir usuarios reales.

### Personalizar el nombre y la foto

**Hecho:** el endpoint de perfil de negocio de Kapso permite modificar `about`, descripción, sitios web, categoría y `profile_picture_handle`; este último se obtiene mediante el flujo de carga resumible de Meta. La propia documentación del endpoint indica expresamente: **“Sandbox configurations are blocked (returns 403)”**. Por tanto, el perfil del número sandbox no puede cambiarse desde ese endpoint, ni para el nombre ni para la foto. [Fuentes: [Kapso, “Update business profile”](https://docs.kapso.ai/api/meta/whatsapp/business-profile/update-business-profile); [Kapso, “Upload media”](https://docs.kapso.ai/api/platform/v1/media/upload-media)]

**Hecho:** para un número de producción, Kapso ofrece cambiar el nombre desde `Connected numbers → seleccionar número → Profile → Display name`. Meta revisa el nombre; Kapso indica que debe representar el negocio y coincidir con la marca externa. Meta documenta que, después de aprobar un cambio, hay que volver a registrar el número para que se aplique. [Fuentes: [Kapso, “Display names”](https://docs.kapso.ai/docs/whatsapp/display-names); [Meta, “Display names”](https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names)]

**Conclusión:** para que aparezca **Fidy** y el logo de Fidy, hay que dejar el sandbox y conectar un número de producción —puede ser el número estadounidense pre-verificado de Kapso para una prueba E2E, o un número propio—. Después se configura el nombre y el logo del **perfil empresarial de WhatsApp**. No es un cambio del nombre del agente ni del proyecto Kapso.

### Opciones de producción de Kapso

| Ruta                                    | Número                                                                                   | ¿Se conserva WhatsApp Business App?       | Para Fidy                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| **Bring your own SIM**                  | Una línea que controlas y verificas por SMS/llamada.                                     | No: queda dedicada a Cloud API.           | Ruta recomendada para un número colombiano propio.                             |
| **WhatsApp Business App / coexistence** | Un número ya activo en la app WhatsApp Business.                                         | Sí, mediante el flujo QR/Embedded Signup. | Útil si quieres seguir atendiendo desde la app; no aplica a WhatsApp personal. |
| **Instant setup**                       | Número digital estadounidense pre-verificado de Kapso/BSP; requiere un pequeño depósito. | No es el número colombiano de Fidy.       | Bueno para una demo E2E rápida; mala elección como identidad local definitiva. |
| **Manual setup**                        | Número dedicado, WABA y credenciales administrados por ti en Meta.                       | No, salvo la modalidad de coexistencia.   | Más control, pero exige Meta App, permisos, token permanente y webhooks.       |

**Hechos:** Kapso indica que el Embedded Signup puede crear el Meta Business Portfolio y el WABA si faltan; para `Bring your own SIM` pide un número que pueda recibir SMS o voz y señala que queda dedicado a la conexión Cloud API; para coexistencia exige WhatsApp Business App; para `Instant setup` ofrece un número estadounidense pre-verificado. [Fuente: [Kapso, “Connect WhatsApp”](https://docs.kapso.ai/docs/how-to/whatsapp/connect-whatsapp)].

Kapso también documenta números locales mediante una cuenta propia de Twilio. Esa opción es un add-on de **US$400/mes** para determinados planes, por lo que no parece la ruta inicial razonable para Fidy. [Fuente: [Kapso, “Provide local numbers”](https://docs.kapso.ai/docs/platform/phone-numbers/provide-local-numbers)].

## 3. Qué significa “tener una cuenta en Meta”

Hay cuatro cosas distintas que suelen llamarse “cuenta de Meta”:

1. **Cuenta personal de Facebook/Meta:** Kapso la pide para iniciar el Embedded Signup. No es la empresa legal de Fidy.
2. **Meta Business Portfolio:** contenedor de activos empresariales. Meta dice que es obligatorio para usar WhatsApp Business Platform.
3. **WABA:** cuenta de WhatsApp Business que vive dentro del Portfolio y contiene los números de negocio.
4. **Meta App / credenciales:** necesarias si eliges la configuración manual; no es lo mismo que el Portfolio ni que la WABA.

**Hechos:** Meta describe el Portfolio como contenedor de WABAs y dice que debe existir para usar la plataforma. En su guía de inicio permite seleccionar un Portfolio existente o crear uno nuevo, y permite seleccionar o crear una WABA. Meta crea recursos de prueba al iniciar el uso de Cloud API. [Fuentes: [Meta, “About the WhatsApp Business Platform”](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform); [Meta, “Get started with Cloud API”](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started)].

**Conclusión:**

- Para el **sandbox propio de Kapso**, puedes seguir sin montar una cuenta empresarial de Meta.
- Para la **producción de Kapso**, sí tendrás que entrar a Meta y seleccionar o crear Portfolio + WABA.
- No necesitas necesariamente crear esos activos manualmente antes: el flujo normal de Kapso los puede crear durante el onboarding.
- Si eliges **Manual setup**, entonces sí tendrás que crear/configurar Meta App, asignar activos y generar un token permanente. [Fuente: [Kapso, “Manual phone number setup”](https://docs.kapso.ai/docs/platform/manual-phone-number-setup)].

## 4. Qué número puede ser la interfaz de Fidy

### Número colombiano propio

**Hechos de Meta:** un número apto para Cloud API debe ser tuyo, tener código de país y área, y poder recibir SMS o llamadas. Un número ya usado con WhatsApp Messenger no puede registrarse sin eliminarlo primero de WhatsApp; Meta también exige verificarlo y después registrarlo para Cloud API. [Fuentes: [Meta, “Business phone numbers”](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers); [Meta, “Register a business phone number”](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration)].

**Aplicación a Fidy:** compra o reserva una línea colombiana dedicada a Fidy, o migra una línea existente sabiendo que dejará de funcionar en WhatsApp Messenger. No uses tu número personal de WhatsApp como número de producción sin decidir primero la migración. La opción de coexistencia es distinta: conserva un número de **WhatsApp Business App** y lo conecta a Cloud API mediante el flujo de Meta/Kapso. [Fuentes: [Kapso, “Connect WhatsApp”](https://docs.kapso.ai/docs/how-to/whatsapp/connect-whatsapp); [Meta, “Onboard WhatsApp Business app users”](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)].

### Número estadounidense de Kapso

**Hecho:** Kapso ofrece un número estadounidense digital pre-verificado en `Instant setup`, con un depósito pequeño que va a los créditos del proyecto. [Fuente: [Kapso, “Connect WhatsApp”](https://docs.kapso.ai/docs/how-to/whatsapp/connect-whatsapp); [Kapso, “WhatsApp pricing FAQ”](https://docs.kapso.ai/docs/whatsapp/pricing-faq)].

**Conclusión:** sí existe una forma en la que Kapso te “da” un número, pero no es un número colombiano por defecto. Puede servir para probar el circuito completo; para un producto cuyo mercado de lanzamiento es Colombia, el número visible para usuarios debería ser una línea colombiana controlada por Fidy o una modalidad de coexistencia que decidas explícitamente.

## 5. ¿Hace falta constituir una empresa?

### Lo que sí está respaldado

- Meta separa el **Business Portfolio** de la verificación. Su ayuda dice que la verificación es necesaria para ciertas funciones, no que toda creación del Portfolio sea imposible sin ella. [Fuente: [Meta, “Verify Your Business on Meta”](https://business.facebook.com/business/help/2058515294227817)].
- Cuando se inicia la verificación, Meta pide nombre legal, dirección, teléfono y sitio web que coincidan con la entidad legal; si no encuentra coincidencia, puede pedir licencia comercial o artículos/documentos de constitución. [Fuente: [Meta, “Verify Your Business on Meta”, pasos 3–4](https://business.facebook.com/business/help/2058515294227817)].
- Wompi publica que una **persona natural** no necesita Cámara de Comercio para registrarse. [Fuente: [Wompi, “Soy persona natural…”](https://soporte.wompi.co/hc/es-419/articles/360021056453-Soy-persona-natural-Necesito-C%C3%A1mara-de-comercio-para-registrarme)].
- El issue #1 ya reconoce dos gates separados: revisión por abogado colombiano de la política/consentimiento y KYB de Wompi. [Fuente: [issue #1, “Further Notes”](https://github.com/B4rz99/fidy-ai/issues/1)].

### Lo que no está resuelto

No hay aquí base suficiente para afirmar que Meta aprobará, para este caso concreto en Colombia, una conexión de producción bajo persona natural sin pedir documentos adicionales. Tampoco la documentación de Kapso promete que una cuenta sin verificación pueda enviar indefinidamente sin límites: Kapso advierte que revisión del WABA, verificación del negocio, facturación, elegibilidad de pagos o revisión del nombre pueden bloquear el envío de producción. [Fuente: [Kapso, “Connect WhatsApp”, “Before you connect”](https://docs.kapso.ai/docs/how-to/whatsapp/connect-whatsapp)].

**Conclusión:** una SAS no parece necesaria para el sandbox ni puede afirmarse que sea un prerrequisito universal de Meta para comenzar. Sin embargo, para lanzar una aplicación de finanzas con cobros y datos personales conviene decidir antes de producción si Fidy operará como persona natural o sociedad, quién será el titular del dominio, del Portfolio, de la WABA, del número y de la cuenta Wompi. Esa decisión afecta verificación, contratos, impuestos, datos personales y continuidad del producto.

## 6. Plan recomendado

### Ahora, sin esperar la empresa

1. Mantener el sandbox de Kapso para desarrollar el adaptador y los webhooks.
2. Crear/terminar el dominio y la web pública HTTPS que ya exige el issue #9 y que Kapso pide en el onboarding.
3. Comprar una SIM/línea colombiana separada para Fidy; no reutilizar una línea personal sin plan de migración.
4. En Kapso, iniciar **Bring your own SIM** y dejar que Embedded Signup cree/seleccione Portfolio + WABA.
5. Probar primero mensajes iniciados por el usuario. Las plantillas para proactividad son una etapa posterior de Meta/Kapso.

### Antes del lanzamiento comercial

Abrir un issue nuevo, por ejemplo:

> **Decision: operating entity and Meta/Wompi production ownership**

Acceptance criteria sugeridos:

- decisión documentada: persona natural vs. sociedad (probablemente SAS, si el asesor lo confirma);
- titular de dominio, Meta Business Portfolio, WABA, número de WhatsApp, Kapso y Wompi;
- datos legales coherentes en Meta: nombre, dirección, teléfono y sitio HTTPS;
- documentos disponibles para verificación de Meta y KYB de Wompi;
- RUT/NIT, tratamiento tributario y facturación revisados por contador;
- política de tratamiento, aviso de privacidad y consentimiento revisados por abogado colombiano;
- procedimiento para migrar el número si Kapso deja de ser el proveedor.

## Preguntas sin resolver

1. ¿Meta aceptará el onboarding de producción de Fidy bajo persona natural en Colombia sin exigir documentación societaria? Hay que comprobarlo en el Business Suite concreto; la documentación pública no garantiza ese resultado.
2. ¿Se quiere un número dedicado que abandone WhatsApp Messenger o coexistencia con WhatsApp Business App? Es una decisión de operación, no de código.
3. ¿Kapso tiene disponible para este proyecto una opción local distinta a SIM/Twilio y cuál sería su coste real? Su documentación pública describe el add-on de Twilio, no una entrega gratuita de número colombiano.
4. ¿Quién será el titular legal de los activos si posteriormente se crea una sociedad? Cambiar esa titularidad después puede implicar migraciones de WABA, número, pagos y dominio.
5. La revisión legal/tributaria colombiana sigue pendiente, como ya reconoce el issue #1; este informe no sustituye asesoría profesional.
6. Kapso documenta el cambio de foto mediante API; queda por comprobar si el dashboard expone también ese control para el número de producción o si habrá que usar el endpoint de perfil.

## Fuentes primarias

### Repositorio

- [Repositorio de issues de B4rz99/fidy-ai](https://github.com/B4rz99/fidy-ai/issues)
- [Issue #1 — Spec](https://github.com/B4rz99/fidy-ai/issues/1)
- [Issue #8 — Consent gate](https://github.com/B4rz99/fidy-ai/issues/8)
- [Issue #9 — Product name, domain & external endpoints](https://github.com/B4rz99/fidy-ai/issues/9)
- [Issue #10 — WhatsApp channel adapter (Kapso)](https://github.com/B4rz99/fidy-ai/issues/10)
- [Issue #36 — Wompi checkout & tier activation](https://github.com/B4rz99/fidy-ai/issues/36)
- [Issue #38 — Data rights, re-consent & the asesoría line](https://github.com/B4rz99/fidy-ai/issues/38)

### Kapso

- [Connect WhatsApp](https://docs.kapso.ai/docs/how-to/whatsapp/connect-whatsapp)
- [Use Kapso Sandbox for Testing](https://docs.kapso.ai/docs/how-to/whatsapp/use-sandbox-for-testing)
- [Manual phone number setup](https://docs.kapso.ai/docs/platform/manual-phone-number-setup)
- [Provide local numbers](https://docs.kapso.ai/docs/platform/phone-numbers/provide-local-numbers)
- [WhatsApp pricing FAQ](https://docs.kapso.ai/docs/whatsapp/pricing-faq)
- [Display names](https://docs.kapso.ai/docs/whatsapp/display-names)
- [Update business profile](https://docs.kapso.ai/api/meta/whatsapp/business-profile/update-business-profile)
- [Upload media](https://docs.kapso.ai/api/platform/v1/media/upload-media)

### Meta

- [About the WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform)
- [Get started with Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started)
- [Business phone numbers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers)
- [Register a business phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration)
- [Onboard WhatsApp Business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)
- [Verify Your Business on Meta](https://business.facebook.com/business/help/2058515294227817)
- [Display names](https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names)
- [Business Profiles](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles/)

### Wompi

- [Soy persona natural, ¿Necesito Cámara de comercio para registrarme?](https://soporte.wompi.co/hc/es-419/articles/360021056453-Soy-persona-natural-Necesito-C%C3%A1mara-de-comercio-para-registrarme)
