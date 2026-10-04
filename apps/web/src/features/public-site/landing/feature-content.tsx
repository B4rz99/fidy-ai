export const features = [
  {
    label: "Transacciones",
    slug: "transacciones",
    content: (
      <>
        {" "}
        <div className="feature-copy">
          <h3>{"Cada transacción tiene su lugar."}</h3>
          <p>
            {
              "Revisa tus registros, consulta sus categorías y corrige los datos que necesites. El mismo registro está disponible para ti y tus agentes autorizados."
            }
          </p>
          <a className="textlink" href="/funciones/transacciones">
            {"Explorar transacciones ↗"}
          </a>
        </div>
        <div className="feature-art">
          <div className="feature-window">
            <div className="feature-window-head">
              {"Tus transacciones "}
              <span>{"Octubre · COP"}</span>
            </div>
            <div className="feature-record">
              <span>
                {"Crepes"}
                <small>{"Restaurantes · Hoy"}</small>
              </span>
              <strong>{"− $28.000"}</strong>
            </div>
            <div className="feature-record">
              <span>
                {"Mercado"}
                <small>{"Mercado · Ayer"}</small>
              </span>
              <strong>{"− $156.000"}</strong>
            </div>
            <div className="feature-record">
              <span>
                {"Transporte"}
                <small>{"Transporte · Ayer"}</small>
              </span>
              <strong>{"− $12.000"}</strong>
            </div>
            <div className="feature-foot">{"Los detalles hacen la diferencia."}</div>
          </div>
        </div>{" "}
      </>
    ),
  },
  {
    label: "Presupuestos",
    slug: "presupuestos",
    content: (
      <>
        {" "}
        <div className="feature-copy">
          <h3>{"Dale un plan a tu mes."}</h3>
          <p>
            {
              "Define un presupuesto mensual por categoría y consulta cuánto has registrado. Ten presente cuánto queda antes de tu próxima decisión."
            }
          </p>
          <a className="textlink" href="/funciones/presupuestos">
            {"Explorar presupuestos ↗"}
          </a>
        </div>
        <div className="feature-art">
          <div className="feature-window">
            <div className="feature-window-head">
              {"Tu presupuesto "}
              <span>{"Octubre · COP"}</span>
            </div>
            <div className="feature-budget">
              <span>{"Restaurantes"}</span>
              <strong>{"$216.000"}</strong>
              <span>{"disponibles de $600.000"}</span>
              <div className="feature-track">
                <i style={{ width: "64%" }}></i>
              </div>
              <div className="feature-record">
                <span>{"Registrado"}</span>
                <b>{"$384.000 · 64%"}</b>
              </div>
            </div>
            <div className="feature-foot">{"Basado en las transacciones registradas."}</div>
          </div>
        </div>{" "}
      </>
    ),
  },
  {
    label: "Asistente",
    slug: "asistente",
    content: (
      <>
        {" "}
        <div className="feature-copy">
          <h3>{"Pregúntalo como lo piensas."}</h3>
          <p>
            {
              "Conversa con Fidy desde la web app. Registra una transacción, consulta tus gastos o revisa cómo va tu presupuesto, en tus propias palabras."
            }
          </p>
          <a className="textlink" href="/funciones/asistente">
            {"Explorar asistente ↗"}
          </a>
        </div>
        <div className="feature-art">
          <div className="feature-window">
            <div className="feature-window-head">
              {"Tu asistente "}
              <span>{"fidy"}</span>
            </div>
            <div className="feature-conversation">
              <p>{"¿Cuánto llevo en restaurantes?"}</p>
              <div>
                <b>{"Vamos a verlo."}</b>
                <p>{"Has registrado $384.000 este mes. Te quedan $216.000 de tu presupuesto."}</p>
              </div>
              <span>{"Todo empieza con una pregunta."}</span>
            </div>
          </div>
        </div>{" "}
      </>
    ),
  },
  {
    label: "Tablero",
    slug: "tablero",
    content: (
      <>
        {" "}
        <div className="feature-copy">
          <h3>{"Tu panorama, a tu manera."}</h3>
          <p>
            {
              "Organiza tu tablero para tener a mano la información que te importa. Consulta tus cifras y encuentra perspectiva en lo que has registrado."
            }
          </p>
          <a className="textlink" href="/funciones/tablero">
            {"Explorar tablero ↗"}
          </a>
        </div>
        <div className="feature-art">
          <div className="feature-window">
            <div className="feature-window-head">
              {"Tu panorama "}
              <span>{"Octubre · COP"}</span>
            </div>
            <div className="feature-budget">
              <span>{"Gastos registrados"}</span>
              <strong>{"$1.084.000"}</strong>
              <div className="feature-chart" aria-label="Gráfico ilustrativo de gastos semanales">
                <i style={{ height: "38%" }}></i>
                <i style={{ height: "66%" }}></i>
                <i style={{ height: "49%" }}></i>
                <i style={{ height: "85%" }}></i>
              </div>
              <div className="feature-chart-labels">
                <span>{"Semana 1"}</span>
                <span>{"Semana 4"}</span>
              </div>
            </div>
          </div>
        </div>{" "}
      </>
    ),
  },
  {
    label: "Hallazgos",
    slug: "insights",
    content: (
      <>
        {" "}
        <div className="feature-copy">
          <h3>{"Encuentra lo que merece atención."}</h3>
          <p>
            {
              "Resúmenes semanales, avisos de presupuesto y patrones recurrentes convierten tus registros en contexto. Tu agente también puede consultar estos hallazgos."
            }
          </p>
          <a className="textlink" href="/funciones/insights">
            {"Explorar hallazgos ↗"}
          </a>
        </div>
        <div className="feature-art">
          <div className="feature-window">
            <div className="feature-window-head">
              {"Hallazgos "}
              <span>{"Ejemplo"}</span>
            </div>
            <div className="feature-budget">
              <span>{"Restaurantes · Este mes"}</span>
              <strong>{"80% registrado"}</strong>
              <p>{"$480.000 de $600.000. Quedan $120.000 en tu presupuesto."}</p>
              <div className="feature-track">
                <i style={{ width: "80%" }}></i>
              </div>
            </div>
            <div className="feature-foot">{"Disponible para consulta por tus agentes."}</div>
          </div>
        </div>{" "}
      </>
    ),
  },
  {
    label: "Tus agentes",
    slug: "agentes",
    content: (
      <>
        {" "}
        <div className="feature-copy">
          <h3>{"Tu agente también puede ayudarte."}</h3>
          <p>
            {
              "Conecta tu agente mediante MCP, CLI o API para consultar registros, revisar hallazgos y ayudarte a organizar tus finanzas. Tú autorizas su acceso."
            }
          </p>
          <a className="textlink" href="/funciones/agentes">
            {"Explorar tus agentes ↗"}
          </a>
        </div>
        <div className="feature-art">
          <div className="feature-window">
            <div className="feature-window-head">
              {"Mi agente "}
              <span>{"Acceso de ejemplo"}</span>
            </div>
            <div className="feature-budget">
              <span>{"Consulta tus registros y hallazgos"}</span>
              <strong>{"Solo lectura"}</strong>
              <p>
                {"MCP · CLI · API"}
                <br />
                {"Acceso autorizado por ti."}
              </p>
            </div>
            <div className="feature-foot">
              {"La misma información. Los permisos que tú defines."}
            </div>
          </div>
        </div>{" "}
      </>
    ),
  },
];
