import { logoUrl } from "./assets";
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
    <main>
      {hero}
      {marketStrip}
      {waysToUse}
      <FeatureTabs />
      <DashboardStory />
      <Pricing />
      {questions}
      {closing}
      {footer}
    </main>{" "}
  </>
);

const hero = (
  <section className="hero peach">
    <div className="wrap hero-grid">
      <div className="hero-copy">
        <h1>
          {"Tu plata,"}
          <br />
          {"más clara."}
          <br />
          <em>
            {"Tu vida,"}
            <br />
            {"más tranquila."}
          </em>
        </h1>
        <p>
          {
            "Fidy reúne tus registros financieros, presupuestos y hallazgos en un mismo sistema. Úsalo conversando, desde la web app o con tus propios agentes de IA."
          }
        </p>
        <div className="actions">
          <LaunchButton dark={false} />
          <a className="textlink" href="#como">
            {"Así funciona ↓"}
          </a>
        </div>
        <small className="fine">
          {"Finanzas personales para Colombia. Pensadas para ti y tus agentes."}
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
      <b>{"Hecho para tu día a día en Colombia"}</b>
      <span>{"Pesos colombianos"}</span>
      <span>{"Asistente y web app"}</span>
      <span>{"Tus propios agentes"}</span>
    </div>
  </div>
);

const waysToUse = (
  <section className="section wrap" id="como">
    <div className="section-head">
      <h2>
        {"Tus finanzas."}
        <br />
        {"Tres formas de usarlas."}
      </h2>
      <p>
        {
          "Fidy es agent-first: está pensado desde el inicio para que tú y tus agentes trabajen con la misma información financiera."
        }
      </p>
    </div>
    <div className="agent-system">
      <div className="agent-entry">
        <h3>{"Conversa con Fidy."}</h3>
        <p>
          {
            "Registra una transacción, consulta tus cifras o revisa un presupuesto con el asistente de la web app."
          }
        </p>
      </div>
      <div className="agent-entry">
        <h3>{"Explora la web app."}</h3>
        <p>
          {
            "Revisa los detalles, corrige tus registros y organiza un tablero con lo que quieres tener a mano."
          }
        </p>
      </div>
      <div className="agent-entry">
        <h3>{"Trae a tu propio agente."}</h3>
        <p>
          {
            "Conéctalo mediante MCP, CLI o API. Autoriza su acceso para consultar información o ayudarte a organizarla."
          }
        </p>
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
            "Sí. Puedes corregir los datos de una transacción si algo quedó mal registrado, como el monto o la categoría. La corrección actualiza ese registro."
          }
        </p>
      </details>
      <details>
        <summary>{"¿Qué pasa con mis datos?"}</summary>
        <p>
          {
            "Se usan para prestar el servicio y proteger tu acceso. Puedes consultar su uso, solicitar correcciones y pedir su eliminación cuando corresponda. Cierta información puede conservarse por obligaciones legales, contractuales o de seguridad."
          }
        </p>
      </details>
      <details>
        <summary>{"¿Necesito tener mi propio agente?"}</summary>
        <p>
          {
            "No. Puedes usar el asistente de Fidy y la web app. Si ya usas un agente compatible con MCP, la CLI o la API, puedes configurarlo y autorizarlo para trabajar con tu información."
          }
        </p>
      </details>
      <details>
        <summary>{"¿Qué puede hacer mi agente?"}</summary>
        <p>
          {
            "Depende de los permisos que le des: consultar registros y hallazgos, registrar o corregir transacciones y trabajar con tu tablero. El acceso tiene vencimiento y puedes revocarlo desde Fidy."
          }
        </p>
      </details>
      <details>
        <summary>{"¿Qué son los hallazgos?"}</summary>
        <p>
          {
            "Son señales basadas en tus registros, como resúmenes semanales, avisos de presupuesto o patrones de cobros recurrentes. Tus agentes también pueden consultarlos. No representan información que aún no hayas incorporado a Fidy."
          }
        </p>
      </details>
      <details>
        <summary>{"¿Cuánto cuesta?"}</summary>
        <p>
          {
            "Fidy Pro cuesta $28.900 COP al mes. También puedes elegir $9.900 COP por semana o $289.900 COP al año."
          }
        </p>
      </details>
      <details>
        <summary>{"¿Cómo empiezo?"}</summary>
        <p>
          {
            "El registro será desde la web app de Fidy. Por ahora, el botón “Empezar con Fidy” muestra un placeholder; el registro aún no está habilitado."
          }
        </p>
      </details>
    </div>
  </section>
);

const closing = (
  <section className="closing">
    <h2>
      {"Tu plata, más clara."}
      <br />
      {"Con la ayuda que tú eliges."}
    </h2>
    <p>{"Conversa con Fidy, explora la web o trabaja con tu propio agente."}</p>
    <LaunchButton dark />
  </section>
);

const footer = (
  <footer className="footer">
    <div className="wrap">
      <img src={logoUrl} alt="fidy" />
      <span>{"Finanzas personales para ti y tus agentes."}</span>
      <small>{"Prototipo de diseño · No es un servicio activo."}</small>
    </div>
  </footer>
);
