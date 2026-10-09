import { AgentBrands } from "./agent-brands";
import { Footer } from "./footer";
import { LaunchButton } from "./registration";
import { Header } from "./navigation";
import { PhoneDemo } from "./phone-demo";
import { FeatureTabs } from "./feature-tabs";
import { DashboardStory } from "./dashboard-story";
import { Pricing } from "./pricing";

export const HomeContent = (): React.JSX.Element => (
  <>
    {" "}
    <Header />
    <main itemScope itemType="https://schema.org/SoftwareApplication">
      <meta itemProp="name" content="Fidy" />
      <meta itemProp="applicationCategory" content="FinanceApplication" />
      <meta itemProp="operatingSystem" content="Web" />
      <link itemProp="url" href="https://app.fidyapp.com/" />
      {hero}
      {marketStrip}
      {firstSteps}
      {waysToUse}
      <FeatureTabs />
      <DashboardStory />
      <Pricing />
      {questions}
      {closing}
      <Footer />
    </main>{" "}
  </>
);

const hero = (
  <section className="hero peach">
    <div className="wrap hero-grid">
      <div className="hero-copy">
        <h1>
          {"Tu plata,"} <br />
          {"más clara."} <br />
          <em>
            {"Tu vida,"} <br />
            {"más tranquila."}
          </em>
        </h1>
        <p>
          {
            "Entiende en qué se va tu plata y planea lo que viene. Lleva tus finanzas desde WhatsApp, la web o tu agente de IA."
          }
        </p>
        <div className="actions">
          <LaunchButton dark={false} arrow />
          <a className="textlink" href="#como">
            {"Así funciona ↓"}
          </a>
        </div>
        <small className="fine">
          {"7 días de Fidy Pro sin tarjeta. Tú eliges si te suscribes."}
        </small>
      </div>
      <div id="demo">
        <PhoneDemo />
      </div>
    </div>
  </section>
);

const marketStrip = (
  <div className="strip">
    <div className="wrap">
      <b>{"Hecho para tu día a día"}</b>
      <span>{"Gastos con contexto"}</span>
      <span>{"Presupuestos a tu medida"}</span>
      <span>{"Tus propios agentes"}</span>
    </div>
  </div>
);

const firstSteps = (
  <section className="section wrap first-steps" aria-labelledby="primeros-pasos">
    <div className="section-head">
      <h2 id="primeros-pasos">Empieza con lo que ya sabes.</h2>
      <p>No necesitas conectar un banco para empezar a organizar tus finanzas.</p>
    </div>
    <div className="steps">
      <article className="step">
        <h3>1. Crea tu cuenta.</h3>
        <p>
          Tu cuenta incluye una prueba de Fidy Pro de 7 días, sin tarjeta. Crear la cuenta no activa
          una suscripción de pago.
        </p>
      </article>
      <article className="step">
        <h3>2. Registra una transacción.</h3>
        <p>
          Escribe cuánto fue y en qué consistió, desde la web o por WhatsApp. También puedes
          adjuntar un CSV o XLSX por WhatsApp para incorporar transacciones, según tu plan. Nunca
          envíes claves bancarias ni números de tarjeta al chat.
        </p>
      </article>
      <article className="step">
        <h3>3. Decide cómo seguir.</h3>
        <p>
          Revisa tus cifras y presupuestos durante la prueba. Para continuar con las funciones Pro,
          elige y autoriza un plan en la sección de suscripción.
        </p>
        <a className="textlink" href="#precios">
          Ver planes y precios ↓
        </a>
      </article>
    </div>
    <p className="first-steps-note">
      Fidy refleja la información que registras. No obtiene automáticamente todos tus datos
      bancarios ni presenta un historial completo de tus finanzas.
    </p>
  </section>
);

const waysToUse = (
  <section className="section wrap" id="como">
    <div className="section-head">
      <h2>
        {"Tus finanzas."} <br />
        {"Tres formas de usarlas."}
      </h2>
      <p>
        {
          "Fidy es agent-first: está pensado desde el inicio para que tú y tus agentes trabajen de forma cohesiva y sin fricción con tus finanzas."
        }
      </p>
    </div>
    <div className="agent-system">
      <div className="agent-entry">
        <h3>{"Conversa con Fidy."}</h3>
        <p>
          {
            "Registra una transacción, consulta tus cifras o revisa un presupuesto conversando con Fidy en WhatsApp."
          }
        </p>
      </div>
      <div className="agent-entry">
        <h3>{"Explora la web app."}</h3>
        <p>
          {
            "Revisa los detalles, corrige tus transacciones y organiza un dashboard con lo que quieres tener a mano."
          }
        </p>
      </div>
      <div className="agent-entry">
        <h3>
          {"Conéctalo a "}
          <AgentBrands />
        </h3>
        <p>
          {
            "Revisa las opciones de MCP, CLI y API, su disponibilidad y los permisos antes de autorizar a tu agente."
          }
        </p>
        <a className="textlink" href="/funciones/agentes#conectar">
          Conecta tu agente ↗
        </a>
      </div>
    </div>
  </section>
);

const questions = (
  <section className="section wrap faq" id="preguntas">
    <div>
      <h2>{"Antes de empezar."}</h2>
    </div>
    <div>
      <details>
        <summary>{"¿Qué información tengo que compartir?"}</summary>
        <p>
          {
            "Para registrar una transacción, cuéntale a Fidy cuánto fue y en qué consistió. Por ejemplo: “Pagué $28.000 de almuerzo en Crepes”. Las respuestas se basan en lo que hayas registrado; no representan por sí solas todas tus finanzas."
          }
        </p>
      </details>
      <details>
        <summary>{"¿Puedo corregir una transacción?"}</summary>
        <p>
          {
            "Sí. Puedes corregir los datos de una transacción si algo quedó mal registrado, como el monto o la categoría. La corrección actualiza esa transacción."
          }
        </p>
      </details>
      <details>
        <summary>{"¿Qué pasa con mis datos?"}</summary>
        <p>
          {
            "Usamos los datos que compartes para organizar tus finanzas, responder tus solicitudes y proteger tu acceso. Cloudflare procesa el servicio y el asistente; Kapso y Meta intervienen al usar WhatsApp. Estos proveedores pueden tratar datos fuera de Colombia."
          }
        </p>
        <p>
          Puedes consultar, corregir o solicitar la eliminación de tus datos y revocar tu
          autorización. Algunas obligaciones legales y de seguridad pueden exigir conservar
          información específica. Consulta los plazos, proveedores y derechos en la{" "}
          <a className="textlink" href="/politica">
            política de privacidad
          </a>{" "}
          o escribe a{" "}
          <a className="textlink" href="mailto:obarboza@fidyapp.com">
            obarboza@fidyapp.com
          </a>
          .
        </p>
      </details>
      <details>
        <summary>{"¿Necesito tener mi propio agente?"}</summary>
        <p>
          {
            "No. Puedes conversar con Fidy en WhatsApp y usar la web app. Si quieres usar tu propio agente, consulta la guía de conexión y la disponibilidad de cada opción antes de configurarlo."
          }
        </p>
      </details>
      <details>
        <summary>{"¿Qué puede hacer mi agente?"}</summary>
        <p>
          {
            "Depende de los permisos que le des: consultar transacciones y hallazgos, registrar o corregir transacciones y trabajar con tu dashboard. El acceso tiene vencimiento y puedes revocarlo desde Fidy."
          }
        </p>
      </details>
      <details>
        <summary>{"¿Qué son los hallazgos?"}</summary>
        <p>
          {
            "Son señales basadas en tus transacciones, como resúmenes semanales, avisos de presupuesto o patrones de cobros recurrentes. Tus agentes también pueden consultarlos. No representan información que aún no hayas incorporado a Fidy."
          }
        </p>
      </details>
      <details>
        <summary>{"¿Cuánto cuesta?"}</summary>
        <p>
          {
            "Crear tu cuenta incluye una prueba de Fidy Pro de 7 días sin tarjeta. Después, Fidy Pro cuesta $28.900 COP al mes. También puedes elegir $9.900 COP por semana o $289.900 COP al año."
          }
        </p>
      </details>
      <details>
        <summary>{"¿Cómo empiezo?"}</summary>
        <p>
          {
            "Revisa la autorización de tratamiento de datos, crea tu cuenta y registra tu primera transacción. La prueba comienza al crear tu cuenta; no necesitas conectar un banco ni registrar una tarjeta."
          }
        </p>
        <div className="actions">
          <LaunchButton dark={false} arrow />
        </div>
      </details>
    </div>
  </section>
);

const closing = (
  <section className="closing">
    <h2>
      {"Tu plata, más clara."} <br />
      {"Con la ayuda que tú eliges."}
    </h2>
    <p>{"Conversa con Fidy, explora la web o trabaja con tu propio agente."}</p>
    <LaunchButton dark arrow />
  </section>
);
