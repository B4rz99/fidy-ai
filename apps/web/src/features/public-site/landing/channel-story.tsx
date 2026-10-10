import { mountChannels } from "./demo-motion";

/** One illustrative transaction, shown through each supported entry point. */
export const ChannelStory = (): React.JSX.Element => (
  <div
    className="channel-story"
    ref={mountChannels}
    aria-label="Una transacción de ejemplo, tres formas de consultarla"
  >
    <div className="channel-card">
      <span className="channel-label">01 · WhatsApp</span>
      <p className="channel-message">Pagué $28.000 de almuerzo en Crepes.</p>
      <small>Listo, quedó registrado. ✓</small>
    </div>
    <span className="channel-connector" aria-hidden="true">
      →
    </span>
    <div className="channel-card">
      <span className="channel-label">02 · Web app</span>
      <div className="channel-transaction">
        <strong>Crepes</strong>
        <strong>− $28.000</strong>
      </div>
      <small>Restaurantes · COP</small>
      <div className="channel-budget">
        <span />
      </div>
      <small>Una transacción. Tu presupuesto actualizado.</small>
    </div>
    <span className="channel-connector" aria-hidden="true">
      →
    </span>
    <div className="channel-card">
      <span className="channel-label">03 · Tu agente</span>
      <p>
        Tu último gasto en Restaurantes fue de <strong>$28.000 en Crepes.</strong>
      </p>
      <small>Ejemplo con acceso autorizado de solo lectura.</small>
    </div>
    <p className="channel-caption">Datos de ejemplo · El mismo contexto en cada canal.</p>
  </div>
);
