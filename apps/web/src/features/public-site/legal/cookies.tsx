import { PublicMetadata } from "@/features/public-site/metadata";
import { PublicPageLayout } from "@/features/public-site/page-layout";

/** Describes storage used by this release, without inferring provider tracking configuration. */
export const CookiesPolicy = (): React.JSX.Element => (
  <PublicPageLayout layout="document">
    <PublicMetadata
      title="Cookies y almacenamiento — Fidy"
      path="/cookies"
      description="Qué guarda Fidy en tu navegador, para qué sirve y cómo controlarlo."
    />
    <article className="flex flex-col gap-5">
      <h1 className="font-heading text-3xl font-semibold">Cookies y almacenamiento</h1>
      <p>
        Actualizada el 9 de octubre de 2026. Fidy usa almacenamiento necesario para la sesión y el
        pago, y una preferencia visual opcional. Esta versión de la aplicación no incorpora cookies
        publicitarias ni herramientas de remarketing.
      </p>
      {storage}
      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-xl font-semibold">Tú tienes el control</h2>
        <p>
          Puedes borrar o bloquear cookies y almacenamiento desde la configuración del navegador.
          Bloquear la cookie de sesión impide usar las funciones autenticadas. Borrar datos de un
          pago pendiente puede impedir recuperar su estado: comprueba el resultado antes de intentar
          pagarlo otra vez.
        </p>
        <p>
          Cerrar sesión elimina la cookie de Fidy; no revoca los permisos de tus agentes. El tema
          visual no es necesario para usar la página. Los servicios que abras por separado, como
          Google, Microsoft o Wompi, pueden usar tecnologías propias bajo sus políticas; la
          configuración de seguridad de Cloudflare también puede afectar el almacenamiento del
          navegador.
        </p>
        <p>
          Para más información, consulta la{" "}
          <a className="underline" href="/politica">
            política de privacidad
          </a>{" "}
          o escribe a{" "}
          <a className="underline" href="mailto:obarboza@fidyapp.com">
            obarboza@fidyapp.com
          </a>
          .
        </p>
      </section>
    </article>
  </PublicPageLayout>
);
const storage = (
  <section className="flex flex-col gap-4">
    <h2 className="font-heading text-xl font-semibold">Qué guarda Fidy</h2>
    <div>
      <h3 className="font-semibold">Sesión · cookie necesaria</h3>
      <p>
        <code>__Host-fidy_session</code>, en <code>api.fidyapp.com</code>, mantiene tu acceso
        autenticado. Contiene un identificador de sesión, no tus transacciones. Se envía por HTTPS y
        no puede leerla el JavaScript de la página. Dura hasta 30 días desde su emisión o
        renovación; cerrar sesión la elimina y revoca esa sesión.
      </p>
    </div>
    <div>
      <h3 className="font-semibold">Apariencia · almacenamiento local opcional</h3>
      <p>
        <code>fidy-landing-theme</code> guarda el tema que eliges. No tiene un vencimiento
        automático; permanece hasta que cambies la preferencia o borres los datos del sitio.
      </p>
    </div>
    <div>
      <h3 className="font-semibold">Pago · almacenamiento temporal de la pestaña</h3>
      <p>
        <code>fidy.payment-request.*</code> conserva un identificador para recuperar el mismo
        intento de pago; <code>fidy.billing-email.*</code>, el correo de facturación de ese intento.
        Se eliminan al alcanzar un resultado final o al terminar la sesión de la pestaña, según el
        navegador. No contienen números de tarjeta, códigos de seguridad ni códigos de un solo uso.
      </p>
    </div>
  </section>
);
