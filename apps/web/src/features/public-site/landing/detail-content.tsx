import { logoUrl } from "./assets";
import { LaunchButton } from "./registration";
import { CorrectionDemo } from "./correction-demo";

export const detailViews = [
  <>
    <header className="wrap nav">
      <a className="logo" href="/" aria-label="Fidy, inicio">
        <img src={logoUrl} alt="fidy" />
      </a>
      <a className="textlink" href="/#funciones">
        {"← Todas las funciones"}
      </a>
      <LaunchButton dark={false} />
    </header>
    <main className="detail-page detail-transacciones">
      <section className="detail-hero wrap">
        <h1>
          {"De cada registro,"}
          <br />
          {"al detalle que importa."}
        </h1>
        <p>
          {
            "Una lista para seguir tus transacciones. Un lugar para revisar lo que pasó y corregir lo que haga falta."
          }
        </p>
        <div className="actions">
          <LaunchButton dark={false} />
          <a className="textlink" href="#vista">
            {"Ver el ejemplo ↓"}
          </a>
        </div>
      </section>
      <section
        className="detail-showcase"
        id="vista"
        aria-label="Vista ilustrativa de Transacciones"
      >
        <div className="wrap">
          <CorrectionDemo />
          <p className="detail-disclosure">
            {"Vista ilustrativa · Datos ficticios en COP · No modifica tu información."}
          </p>
        </div>
      </section>
      <section className="section wrap">
        <div className="section-head">
          <h2>{"Tus registros cuentan una historia."}</h2>
        </div>
        <div className="steps">
          <article className="step">
            <h3>{"Captura a tu ritmo."}</h3>
            <p>
              {
                "Registra una transacción desde la web app o cuéntasela al asistente en tus propias palabras."
              }
            </p>
          </article>
          <article className="step">
            <h3>{"Entiende cada dato."}</h3>
            <p>
              {
                "Consulta el monto, la fecha y la categoría de tus registros. Los detalles te ayudan a dar contexto a tus gastos."
              }
            </p>
          </article>
          <article className="step">
            <h3>{"Corrige y sigue."}</h3>
            <p>
              {
                "Si un monto o una categoría quedó mal, puedes corregir la misma transacción. No necesitas duplicarla."
              }
            </p>
          </article>
        </div>
      </section>
      <section className="detail-explore wrap">
        <h2>{"Sigue explorando."}</h2>
        <div>
          <a href="/funciones/presupuestos">
            <span>{"Presupuestos"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/asistente">
            <span>{"Asistente"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/tablero">
            <span>{"Tablero"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/insights">
            <span>{"Hallazgos"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/agentes">
            <span>{"Tus agentes"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
        </div>
      </section>
      <section className="closing">
        <h2>
          {"Tu plata, más clara."}
          <br />
          {"Con la ayuda que tú eliges."}
        </h2>
        <p>{"Conversa con Fidy, explora la web o trabaja con tu propio agente."}</p>
        <LaunchButton dark />
      </section>
      <footer className="footer">
        <div className="wrap">
          <img src={logoUrl} alt="fidy" />
          <span>{"Finanzas personales para ti y tus agentes."}</span>
          <small>{"Prototipo de diseño · No es un servicio activo."}</small>
        </div>
      </footer>
    </main>
  </>,
  <>
    <header className="wrap nav">
      <a className="logo" href="/" aria-label="Fidy, inicio">
        <img src={logoUrl} alt="fidy" />
      </a>
      <a className="textlink" href="/#funciones">
        {"← Todas las funciones"}
      </a>
      <LaunchButton dark={false} />
    </header>
    <main className="detail-page detail-presupuestos">
      <section className="detail-hero wrap">
        <h1>
          {"Un presupuesto que"}
          <br />
          {"puedes tener presente."}
        </h1>
        <p>
          {
            "Ponle un monto mensual a cada categoría y consulta cuánto has registrado. Decidir es más fácil cuando tienes los números a mano."
          }
        </p>
        <div className="actions">
          <LaunchButton dark={false} />
          <a className="textlink" href="#vista">
            {"Ver el ejemplo ↓"}
          </a>
        </div>
      </section>
      <section
        className="detail-showcase"
        id="vista"
        aria-label="Vista ilustrativa de Presupuestos"
      >
        <div className="wrap">
          <div className="detail-budget-grid">
            <article className="detail-budget-card">
              <h3>{"Restaurantes"}</h3>
              <span>{"Disponible · COP"}</span>
              <strong>{"$216.000"}</strong>
              <div className="feature-track">
                <i style={{ width: "64%" }}></i>
              </div>
              <div className="detail-budget-numbers">
                <span>
                  {"Registrado"}
                  <b>{"$384.000"}</b>
                </span>
                <span>
                  {"Presupuesto"}
                  <b>{"$600.000"}</b>
                </span>
              </div>
              <p>{"64% del presupuesto mensual registrado"}</p>
            </article>
            <article className="detail-budget-card">
              <h3>{"Mercado"}</h3>
              <span>{"Disponible · COP"}</span>
              <strong>{"$280.000"}</strong>
              <div className="feature-track">
                <i style={{ width: "65%" }}></i>
              </div>
              <div className="detail-budget-numbers">
                <span>
                  {"Registrado"}
                  <b>{"$520.000"}</b>
                </span>
                <span>
                  {"Presupuesto"}
                  <b>{"$800.000"}</b>
                </span>
              </div>
              <p>{"65% del presupuesto mensual registrado"}</p>
            </article>
            <article className="detail-budget-card">
              <h3>{"Transporte"}</h3>
              <span>{"Disponible · COP"}</span>
              <strong>{"$120.000"}</strong>
              <div className="feature-track">
                <i style={{ width: "60%" }}></i>
              </div>
              <div className="detail-budget-numbers">
                <span>
                  {"Registrado"}
                  <b>{"$180.000"}</b>
                </span>
                <span>
                  {"Presupuesto"}
                  <b>{"$300.000"}</b>
                </span>
              </div>
              <p>{"60% del presupuesto mensual registrado"}</p>
            </article>
          </div>
          <p className="detail-disclosure">
            {"Vista ilustrativa · Datos ficticios en COP · No modifica tu información."}
          </p>
        </div>
      </section>
      <section className="section wrap">
        <div className="section-head">
          <h2>{"Del monto que eliges, a cómo vas."}</h2>
        </div>
        <div className="steps">
          <article className="step">
            <h3>{"Una categoría, un presupuesto."}</h3>
            <p>{"Define cuánto quieres destinar a restaurantes, mercado o transporte cada mes."}</p>
          </article>
          <article className="step">
            <h3>{"Lo registrado cuenta."}</h3>
            <p>
              {
                "El progreso refleja las transacciones de esa categoría y moneda. Lo que aún no has registrado no se incluye."
              }
            </p>
          </article>
          <article className="step">
            <h3>{"Ajústalo cuando lo necesites."}</h3>
            <p>
              {
                "Puedes actualizar el monto de tu presupuesto y seguir consultando cuánto llevas desde el asistente."
              }
            </p>
          </article>
        </div>
      </section>
      <section className="detail-explore wrap">
        <h2>{"Sigue explorando."}</h2>
        <div>
          <a href="/funciones/transacciones">
            <span>{"Transacciones"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/asistente">
            <span>{"Asistente"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/tablero">
            <span>{"Tablero"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/insights">
            <span>{"Hallazgos"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/agentes">
            <span>{"Tus agentes"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
        </div>
      </section>
      <section className="closing">
        <h2>
          {"Tu plata, más clara."}
          <br />
          {"Con la ayuda que tú eliges."}
        </h2>
        <p>{"Conversa con Fidy, explora la web o trabaja con tu propio agente."}</p>
        <LaunchButton dark />
      </section>
      <footer className="footer">
        <div className="wrap">
          <img src={logoUrl} alt="fidy" />
          <span>{"Finanzas personales para ti y tus agentes."}</span>
          <small>{"Prototipo de diseño · No es un servicio activo."}</small>
        </div>
      </footer>
    </main>
  </>,
  <>
    <header className="wrap nav">
      <a className="logo" href="/" aria-label="Fidy, inicio">
        <img src={logoUrl} alt="fidy" />
      </a>
      <a className="textlink" href="/#funciones">
        {"← Todas las funciones"}
      </a>
      <LaunchButton dark={false} />
    </header>
    <main className="detail-page detail-asistente">
      <section className="detail-hero wrap">
        <h1>
          {"Tu plata también"}
          <br />
          {"se puede conversar."}
        </h1>
        <p>
          {
            "Escribe como hablas. Fidy te ayuda a registrar transacciones y consultar tus cifras desde la web app."
          }
        </p>
        <div className="actions">
          <LaunchButton dark={false} />
          <a className="textlink" href="#vista">
            {"Ver el ejemplo ↓"}
          </a>
        </div>
      </section>
      <section className="detail-showcase" id="vista" aria-label="Vista ilustrativa de Asistente">
        <div className="wrap">
          <div className="detail-assistant">
            <aside>
              <b>{"fidy"}</b>
              <span>{"Tu asistente"}</span>
              <p>{"Una conversación que te ayuda a entender lo que registras."}</p>
              <a className="textlink" href="/funciones/transacciones">
                {"Explorar transacciones ↗"}
              </a>
            </aside>
            <div className="detail-transcript">
              <div className="detail-user">{"Pagué $28.000 de almuerzo en Crepes."}</div>
              <div className="detail-answer">
                <b>{"Listo, quedó registrado."}</b>
                <p>{"Crepes · Restaurantes · $28.000 COP"}</p>
              </div>
              <div className="detail-user">{"¿Y cómo va mi presupuesto?"}</div>
              <div className="detail-answer">
                <b>{"Te quedan $216.000 en Restaurantes."}</b>
                <p>{"Has registrado $384.000 de los $600.000 que definiste para este mes."}</p>
                <div className="feature-track">
                  <i style={{ width: "64%" }}></i>
                </div>
              </div>
              <div className="detail-composer">
                {"Escribe en tus propias palabras… "}
                <span aria-hidden="true">{"↑"}</span>
              </div>
            </div>
          </div>
          <p className="detail-disclosure">
            {"Vista ilustrativa · Datos ficticios en COP · No modifica tu información."}
          </p>
        </div>
      </section>
      <section className="section wrap">
        <div className="section-head">
          <h2>{"De una pregunta, a algo útil."}</h2>
        </div>
        <div className="steps">
          <article className="step">
            <h3>{"Registra con tus palabras."}</h3>
            <p>
              {"“Pagué $28.000 de almuerzo en Crepes”. Dale a Fidy el contexto de la transacción."}
            </p>
          </article>
          <article className="step">
            <h3>{"Haz la siguiente pregunta."}</h3>
            <p>
              {"Consulta cuánto llevas en una categoría o cómo va el presupuesto que definiste."}
            </p>
          </article>
          <article className="step">
            <h3>{"Respuestas con contexto."}</h3>
            <p>
              {
                "El asistente se basa en la información disponible en Fidy. Sus respuestas no son una visión completa de todas tus finanzas."
              }
            </p>
          </article>
        </div>
      </section>
      <section className="detail-explore wrap">
        <h2>{"Sigue explorando."}</h2>
        <div>
          <a href="/funciones/transacciones">
            <span>{"Transacciones"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/presupuestos">
            <span>{"Presupuestos"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/tablero">
            <span>{"Tablero"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/insights">
            <span>{"Hallazgos"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/agentes">
            <span>{"Tus agentes"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
        </div>
      </section>
      <section className="closing">
        <h2>
          {"Tu plata, más clara."}
          <br />
          {"Con la ayuda que tú eliges."}
        </h2>
        <p>{"Conversa con Fidy, explora la web o trabaja con tu propio agente."}</p>
        <LaunchButton dark />
      </section>
      <footer className="footer">
        <div className="wrap">
          <img src={logoUrl} alt="fidy" />
          <span>{"Finanzas personales para ti y tus agentes."}</span>
          <small>{"Prototipo de diseño · No es un servicio activo."}</small>
        </div>
      </footer>
    </main>
  </>,
  <>
    <header className="wrap nav">
      <a className="logo" href="/" aria-label="Fidy, inicio">
        <img src={logoUrl} alt="fidy" />
      </a>
      <a className="textlink" href="/#funciones">
        {"← Todas las funciones"}
      </a>
      <LaunchButton dark={false} />
    </header>
    <main className="detail-page detail-tablero">
      <section className="detail-hero wrap">
        <h1>
          {"Lo importante para ti,"}
          <br />
          {"a primera vista."}
        </h1>
        <p>
          {
            "Organiza tu tablero con las cifras y los registros que quieres tener cerca. Una vista personal de tu información en Fidy."
          }
        </p>
        <div className="actions">
          <LaunchButton dark={false} />
          <a className="textlink" href="#vista">
            {"Ver el ejemplo ↓"}
          </a>
        </div>
      </section>
      <section className="detail-showcase" id="vista" aria-label="Vista ilustrativa de Tablero">
        <div className="wrap">
          <div className="detail-dashboard">
            <div className="detail-app-title">
              <b>{"Mi panorama"}</b>
              <span>{"Octubre · COP"}</span>
            </div>
            <div className="detail-widget-grid">
              <article>
                <span>{"Gastos registrados"}</span>
                <strong>{"$1.084.000"}</strong>
                <small>{"A partir de tus transacciones"}</small>
              </article>
              <article>
                <span>{"Restaurantes disponible"}</span>
                <strong>{"$216.000"}</strong>
                <div className="feature-track">
                  <i style={{ width: "64%" }}></i>
                </div>
              </article>
              <article className="detail-spending">
                <h3>{"Gastos por categoría"}</h3>
                <div className="detail-category">
                  <span>{"Mercado"}</span>
                  <b>{"$520.000"}</b>
                  <div className="feature-track">
                    <i style={{ width: "100%" }}></i>
                  </div>
                </div>
                <div className="detail-category">
                  <span>{"Restaurantes"}</span>
                  <b>{"$384.000"}</b>
                  <div className="feature-track">
                    <i style={{ width: "74%" }}></i>
                  </div>
                </div>
                <div className="detail-category">
                  <span>{"Transporte"}</span>
                  <b>{"$180.000"}</b>
                  <div className="feature-track">
                    <i style={{ width: "35%" }}></i>
                  </div>
                </div>
              </article>
              <article>
                <h3>{"Últimas transacciones"}</h3>
                <div className="feature-record">
                  <span>
                    {"Crepes"}
                    <small>{"Restaurantes"}</small>
                  </span>
                  <b>{"− $28.000"}</b>
                </div>
                <div className="feature-record">
                  <span>
                    {"Mercado"}
                    <small>{"Mercado"}</small>
                  </span>
                  <b>{"− $156.000"}</b>
                </div>
                <div className="feature-record">
                  <span>
                    {"Transporte"}
                    <small>{"Transporte"}</small>
                  </span>
                  <b>{"− $12.000"}</b>
                </div>
              </article>
            </div>
          </div>
          <p className="detail-disclosure">
            {"Vista ilustrativa · Datos ficticios en COP · No modifica tu información."}
          </p>
        </div>
      </section>
      <section className="section wrap">
        <div className="section-head">
          <h2>{"Un espacio que puedes organizar."}</h2>
        </div>
        <div className="steps">
          <article className="step">
            <h3>{"Elige qué ver."}</h3>
            <p>
              {
                "Combina métricas, gastos por categoría, presupuestos y listas de transacciones en tu tablero."
              }
            </p>
          </article>
          <article className="step">
            <h3>{"Dale tu orden."}</h3>
            <p>
              {"Reorganiza los widgets para que la información que más consultas tenga su lugar."}
            </p>
          </article>
          <article className="step">
            <h3>{"Conserva la perspectiva."}</h3>
            <p>
              {
                "Cada cifra parte de tus registros. Consulta el detalle para entender qué hay detrás del total."
              }
            </p>
          </article>
        </div>
      </section>
      <section className="detail-explore wrap">
        <h2>{"Sigue explorando."}</h2>
        <div>
          <a href="/funciones/transacciones">
            <span>{"Transacciones"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/presupuestos">
            <span>{"Presupuestos"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/asistente">
            <span>{"Asistente"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/insights">
            <span>{"Hallazgos"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/agentes">
            <span>{"Tus agentes"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
        </div>
      </section>
      <section className="closing">
        <h2>
          {"Tu plata, más clara."}
          <br />
          {"Con la ayuda que tú eliges."}
        </h2>
        <p>{"Conversa con Fidy, explora la web o trabaja con tu propio agente."}</p>
        <LaunchButton dark />
      </section>
      <footer className="footer">
        <div className="wrap">
          <img src={logoUrl} alt="fidy" />
          <span>{"Finanzas personales para ti y tus agentes."}</span>
          <small>{"Prototipo de diseño · No es un servicio activo."}</small>
        </div>
      </footer>
    </main>
  </>,
  <>
    <header className="wrap nav">
      <a className="logo" href="/" aria-label="Fidy, inicio">
        <img src={logoUrl} alt="fidy" />
      </a>
      <a className="textlink" href="/#funciones">
        {"← Todas las funciones"}
      </a>
      <LaunchButton dark={false} />
    </header>
    <main className="detail-page detail-insights">
      <section className="detail-hero wrap">
        <h1>
          {"De tus registros,"}
          <br />
          {"a lo que importa."}
        </h1>
        <p>
          {
            "Los hallazgos de Fidy ponen tus cifras en contexto: cómo fue tu semana, cuánto llevas de un presupuesto y qué patrones aparecen en tus transacciones."
          }
        </p>
        <div className="actions">
          <LaunchButton dark={false} />
          <a className="textlink" href="#vista">
            {"Ver el ejemplo ↓"}
          </a>
        </div>
      </section>
      <section className="detail-showcase" id="vista" aria-label="Vista ilustrativa de Hallazgos">
        <div className="wrap">
          <div className="insight-stream">
            <article>
              <span>{"Presupuesto · Restaurantes"}</span>
              <h3>{"Llegaste al 80% de tu presupuesto."}</h3>
              <p>{"Has registrado $480.000 de $600.000 este mes. Quedan $120.000."}</p>
              <div className="feature-track">
                <i style={{ width: "80%" }}></i>
              </div>
            </article>
            <article>
              <span>{"Resumen semanal"}</span>
              <h3>{"Tu semana, con contexto."}</h3>
              <p>
                {
                  "$312.000 registrados esta semana frente a $280.000 la anterior. Una diferencia de $32.000."
                }
              </p>
              <div className="insight-compare">
                <div>
                  <i style={{ width: "90%" }}></i>
                  <span>{"Anterior · $280.000"}</span>
                </div>
                <div>
                  <i style={{ width: "100%" }}></i>
                  <span>{"Esta semana · $312.000"}</span>
                </div>
              </div>
            </article>
            <article>
              <span>{"Patrón recurrente"}</span>
              <h3>{"Un cobro que se repite."}</h3>
              <p>
                {
                  "Varios registros de $24.900 con la misma contraparte muestran un patrón. Es una señal en tu historial, no una confirmación de una suscripción activa."
                }
              </p>
            </article>
          </div>
          <p className="detail-disclosure">
            {"Vista ilustrativa · Datos ficticios en COP · No modifica tu información."}
          </p>
        </div>
      </section>
      <section className="section wrap">
        <div className="section-head">
          <h2>{"Señales para revisar, con contexto."}</h2>
        </div>
        <div className="steps">
          <article className="step">
            <h3>{"Sigue tus presupuestos."}</h3>
            <p>
              {
                "Los avisos identifican cuándo lo registrado alcanza el 80% o el 100% del presupuesto mensual de una categoría."
              }
            </p>
          </article>
          <article className="step">
            <h3>{"Mira tu semana."}</h3>
            <p>
              {
                "Los resúmenes semanales reúnen información de tus registros y permiten comparar períodos. La cobertura depende de los datos disponibles."
              }
            </p>
          </article>
          <article className="step">
            <h3>{"Compártelos con tu agente."}</h3>
            <p>
              {
                "Tu agente autorizado puede consultar los hallazgos pendientes y usarlos para ayudarte a revisar tus finanzas."
              }
            </p>
          </article>
        </div>
      </section>
      <section className="detail-explore wrap">
        <h2>{"Sigue explorando."}</h2>
        <div>
          <a href="/funciones/transacciones">
            <span>{"Transacciones"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/presupuestos">
            <span>{"Presupuestos"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/asistente">
            <span>{"Asistente"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/tablero">
            <span>{"Tablero"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/agentes">
            <span>{"Tus agentes"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
        </div>
      </section>
      <section className="closing">
        <h2>
          {"Tu plata, más clara."}
          <br />
          {"Con la ayuda que tú eliges."}
        </h2>
        <p>{"Conversa con Fidy, explora la web o trabaja con tu propio agente."}</p>
        <LaunchButton dark />
      </section>
      <footer className="footer">
        <div className="wrap">
          <img src={logoUrl} alt="fidy" />
          <span>{"Finanzas personales para ti y tus agentes."}</span>
          <small>{"Prototipo de diseño · No es un servicio activo."}</small>
        </div>
      </footer>
    </main>
  </>,
  <>
    <header className="wrap nav">
      <a className="logo" href="/" aria-label="Fidy, inicio">
        <img src={logoUrl} alt="fidy" />
      </a>
      <a className="textlink" href="/#funciones">
        {"← Todas las funciones"}
      </a>
      <LaunchButton dark={false} />
    </header>
    <main className="detail-page detail-agentes">
      <section className="detail-hero wrap">
        <h1>
          {"Tus finanzas también"}
          <br />
          {"hablan con tus agentes."}
        </h1>
        <p>
          {
            "Fidy está construido para que tus propios agentes sean una forma de usar el producto. Conéctalos mediante MCP, CLI o API para trabajar con tus registros, presupuestos y hallazgos."
          }
        </p>
        <div className="actions">
          <LaunchButton dark={false} />
          <a className="textlink" href="#vista">
            {"Ver el ejemplo ↓"}
          </a>
        </div>
      </section>
      <section className="detail-showcase" id="vista" aria-label="Vista ilustrativa de Tus agentes">
        <div className="wrap">
          <div className="own-agent-layout">
            <div className="own-agent-task">
              <span>{"Tu petición a tu agente"}</span>
              <h3>{"“Revisa mi semana en Fidy y ayúdame a entender qué cambió.”"}</h3>
              <div className="agent-task-step">
                <b>{"Consulta tus registros"}</b>
                <p>{"Revisa transacciones y presupuestos con los permisos que autorizaste."}</p>
              </div>
              <div className="agent-task-step">
                <b>{"Lee tus hallazgos"}</b>
                <p>{"Consulta los avisos y resúmenes pendientes del mismo sistema."}</p>
              </div>
              <div className="agent-task-step">
                <b>{"Te devuelve contexto"}</b>
                <p>{"Relaciona esa información para ayudarte a decidir qué revisar."}</p>
              </div>
            </div>
            <aside className="agent-grant">
              <h3>{"Tú defines el acceso."}</h3>
              <dl>
                <dt>{"Destinatario"}</dt>
                <dd>{"Mi agente"}</dd>
                <dt>{"Permiso del ejemplo"}</dt>
                <dd>{"Solo lectura"}</dd>
                <dt>{"Vigencia"}</dt>
                <dd>{"7 días"}</dd>
              </dl>
              <div className="agent-scope-note">
                {"Puede consultar. Este acceso no le permite modificar tus registros."}
              </div>
              <p>
                {
                  "Puedes revocar el acceso desde Fidy. Para registrar o modificar información necesita permisos de escritura."
                }
              </p>
              <span>{"Ejemplo de autorización"}</span>
            </aside>
          </div>
          <p className="detail-disclosure">
            {"Vista ilustrativa · Datos ficticios en COP · No modifica tu información."}
          </p>
        </div>
      </section>
      <section className="section wrap">
        <div className="section-head">
          <h2>{"Agent-first, en la práctica."}</h2>
        </div>
        <div className="steps">
          <article className="step">
            <h3>{"El mismo sistema."}</h3>
            <p>
              {
                "El asistente de Fidy y tus agentes acceden a las mismas capacidades financieras mediante la API, sujetos a los permisos y condiciones de cada acceso."
              }
            </p>
          </article>
          <article className="step">
            <h3>{"Permisos concretos."}</h3>
            <p>
              {
                "Elige acceso de lectura, escritura o tablero, y una vigencia de 7, 30, 90 o 365 días. Puedes revocarlo desde la web app."
              }
            </p>
          </article>
          <article className="step">
            <h3>{"Una base para tus flujos."}</h3>
            <p>
              {
                "Conecta un agente compatible mediante MCP, usa la CLI en tus flujos o integra la API. Tu agente puede consultar información, registrar transacciones o preparar tu tablero con el acceso que autorices."
              }
            </p>
          </article>
        </div>
      </section>
      <section className="detail-explore wrap">
        <h2>{"Sigue explorando."}</h2>
        <div>
          <a href="/funciones/transacciones">
            <span>{"Transacciones"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/presupuestos">
            <span>{"Presupuestos"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/asistente">
            <span>{"Asistente"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/tablero">
            <span>{"Tablero"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
          <a href="/funciones/insights">
            <span>{"Hallazgos"}</span>
            <span aria-hidden="true">{"↗"}</span>
          </a>
        </div>
      </section>
      <section className="closing">
        <h2>
          {"Tu plata, más clara."}
          <br />
          {"Con la ayuda que tú eliges."}
        </h2>
        <p>{"Conversa con Fidy, explora la web o trabaja con tu propio agente."}</p>
        <LaunchButton dark />
      </section>
      <footer className="footer">
        <div className="wrap">
          <img src={logoUrl} alt="fidy" />
          <span>{"Finanzas personales para ti y tus agentes."}</span>
          <small>{"Prototipo de diseño · No es un servicio activo."}</small>
        </div>
      </footer>
    </main>
  </>,
];
