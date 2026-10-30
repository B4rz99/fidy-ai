import { TransactionPrivacyNotice } from "@/ui/components/transaction-privacy-notice";
import { LoadingPreviewFrame as PreviewFrame } from "@/ui/components/loading-preview-frame";
import {
  HistoricalSuggestionsSkeleton,
  RecurringSkeleton,
} from "@/ui/components/recurring-loading";
import {
  AccessListSkeleton,
  BankRequestSkeleton,
  ConsentDisclosureSkeleton,
  ConsentRenewalSkeleton,
  PATCreationSkeleton,
  PairingRequestSkeleton,
  PrivacyAuthorizationSkeleton,
} from "@/ui/components/settings-loading";
import { ApplicationSkeleton } from "@/ui/components/application-loading";
import { SelectionListSkeleton, TextSkeleton } from "@/ui/components/loading-skeletons";
import { DashboardCatalogSkeleton, DashboardSkeleton } from "@/ui/components/dashboard-loading";
import { ReportSkeleton } from "@/ui/components/report-loading";
import { AuthorizationSkeleton } from "@/ui/components/authorization-loading";
import { BudgetSkeleton } from "@/ui/components/budget-loading";
import {
  ReviewDetailSkeleton,
  ReviewInboxSkeleton,
  ReviewPageSkeleton,
} from "@/ui/components/review-loading";
import { TransactionRowsSkeleton, TransactionsSkeleton } from "@/ui/components/transaction-loading";
import { Button } from "@/ui/components/button";
import {
  OffersSkeleton,
  PaymentFormSkeleton,
  PaymentMethodsSkeleton,
  SubscriptionStandingSkeleton,
} from "@/ui/components/subscription-loading";
import { type JSX, type RefCallback, useCallback, useState } from "react";

const previews = [
  {
    name: "Transacciones · entrada",
    frame: "plain",
    context: "Comprobación de acceso antes de mostrar datos.",
    render: (): JSX.Element => <TransactionsSkeleton readOnly={false} notice={null} />,
  },
  {
    name: "Transacciones · primera consulta",
    frame: "plain",
    context: "Primera lectura y preparación del espacio de trabajo.",
    render: (): JSX.Element => <TransactionsSkeleton readOnly={false} notice={null} />,
  },
  {
    name: "Transacciones · solo lectura",
    frame: "plain",
    context: "Historial guardado después de retirar la autorización.",
    render: (): JSX.Element => (
      <TransactionsSkeleton
        readOnly={true}
        notice={
          <TransactionPrivacyNotice
            privacyLink={<span className="underline">contacta a Fidy</span>}
          />
        }
      />
    ),
  },
  {
    name: "Transacciones · página siguiente",
    frame: "transaction-rows",
    context: "Se añade al final del historial; las filas cargadas permanecen visibles.",
    render: (): JSX.Element => <TransactionRowsSkeleton />,
  },
  {
    name: "Por revisar · entrada",
    frame: "plain",
    context: "Preparación del espacio de trabajo antes de la primera visita.",
    render: (): JSX.Element => <ReviewPageSkeleton />,
  },
  {
    name: "Por revisar · bandeja",
    frame: "review-inbox",
    context: "Las pestañas y los filtros permanecen; se cargan los elementos.",
    render: (): JSX.Element => <ReviewInboxSkeleton />,
  },
  {
    name: "Por revisar · elemento",
    frame: "review-detail",
    context: "El encabezado conocido permanece mientras se prepara el editor.",
    render: (): JSX.Element => <ReviewDetailSkeleton />,
  },
  {
    name: "Por revisar · original",
    frame: "review-original",
    context: "Solo el material original pendiente cambia a este esqueleto.",
    render: (): JSX.Element => <TextSkeleton label="Cargando original" lines={6} />,
  },
  {
    name: "Por revisar · recuperación",
    frame: "plain",
    context: "Se consulta la versión guardada; la opción de reintentar permanece disponible.",
    render: (): JSX.Element => <TextSkeleton label="Actualizando la versión guardada" lines={2} />,
  },
  {
    name: "Recurrentes · entrada",
    frame: "plain",
    context: "Preparación del código y del perfil de presentación.",
    render: (): JSX.Element => <RecurringSkeleton />,
  },
  {
    name: "Recurrentes · planificación",
    frame: "plain",
    context: "Primera lectura del mes y de las categorías.",
    render: (): JSX.Element => <RecurringSkeleton />,
  },
  {
    name: "Recurrentes · elegir transacción",
    frame: "plain",
    context: "Consulta de transacciones al abrir el selector.",
    render: (): JSX.Element => <SelectionListSkeleton label="Cargando transacciones" />,
  },
  {
    name: "Recurrentes · sugerencias históricas",
    frame: "plain",
    context: "Solo se consulta al abrir las sugerencias; la planificación permanece visible.",
    render: (): JSX.Element => <HistoricalSuggestionsSkeleton />,
  },
  {
    name: "Presupuestos",
    frame: "plain",
    context: "Carga inicial, datos del mes y preparación de la vista.",
    render: (): JSX.Element => <BudgetSkeleton />,
  },
  {
    name: "Tablero",
    frame: "plain",
    context: "Preparación de la vista y primera lectura de los paneles.",
    render: (): JSX.Element => <DashboardSkeleton />,
  },
  {
    name: "Tablero · catálogo",
    frame: "plain",
    context: "Solo el catálogo pendiente del editor de paneles.",
    render: (): JSX.Element => <DashboardCatalogSkeleton />,
  },
  {
    name: "Reporte de recurrentes",
    frame: "plain",
    context: "Patrones históricos y contexto del informe.",
    render: (): JSX.Element => <ReportSkeleton />,
  },
  {
    name: "Agentes · solicitud de acceso",
    frame: "authorization",
    context: "Permisos y duración antes de habilitar la aprobación.",
    render: (): JSX.Element => <AuthorizationSkeleton />,
  },
  {
    name: "Agentes · conexiones",
    frame: "settings",
    context: "Lista de agentes conectados en Ajustes.",
    render: (): JSX.Element => <AccessListSkeleton kind="agents" />,
  },
  {
    name: "Tokens · lista",
    frame: "settings",
    context: "Consulta inicial de tokens activos en Ajustes.",
    render: (): JSX.Element => <AccessListSkeleton kind="tokens" />,
  },
  {
    name: "Tokens · confirmar identidad",
    frame: "settings-panel",
    context: "Comprobación de identidad antes de recuperar el formulario.",
    render: (): JSX.Element => <PATCreationSkeleton />,
  },
  {
    name: "CLI · solicitud",
    frame: "plain",
    context: "Consulta de la solicitud antes de habilitar la aprobación.",
    render: (): JSX.Element => <PairingRequestSkeleton />,
  },
  {
    name: "Conexión bancaria · solicitud",
    frame: "plain",
    context: "Consulta del intento antes de mostrar sus controles.",
    render: (): JSX.Element => <BankRequestSkeleton />,
  },
  {
    name: "Conexión bancaria · estado",
    frame: "plain",
    context: "Lectura del estado de la conexión.",
    render: (): JSX.Element => <TextSkeleton label="Consultando conexión" lines={3} />,
  },
  {
    name: "Conexión bancaria · cuentas",
    frame: "plain",
    context: "Consulta de las cuentas autorizadas de una conexión activa.",
    render: (): JSX.Element => <TextSkeleton label="Cargando cuentas autorizadas" lines={1} />,
  },
  {
    name: "Registro · Consentimiento",
    frame: "plain",
    context: "Aviso de Consentimiento; los proveedores permanecen deshabilitados.",
    render: (): JSX.Element => <ConsentDisclosureSkeleton />,
  },
  {
    name: "Privacidad · autorización",
    frame: "privacy",
    context: "Consulta de autorización antes de ofrecer decisiones.",
    render: (): JSX.Element => <PrivacyAuthorizationSkeleton />,
  },
  {
    name: "Privacidad · renovación",
    frame: "privacy",
    context: "Aviso guardado antes de ofrecer su renovación explícita.",
    render: (): JSX.Element => <ConsentRenewalSkeleton />,
  },
  {
    name: "Suscripción · autorización",
    frame: "subscription",
    context: "Comprobación de acceso antes de montar consultas y pagos.",
    render: (): JSX.Element => <OffersSkeleton />,
  },
  {
    name: "Suscripción · ofertas",
    frame: "subscription",
    context: "Períodos disponibles y resumen de selección.",
    render: (): JSX.Element => <OffersSkeleton />,
  },
  {
    name: "Suscripción · estado",
    frame: "subscription",
    context: "Lectura del estado de suscripción y acceso.",
    render: (): JSX.Element => <SubscriptionStandingSkeleton />,
  },
  {
    name: "Suscripción · métodos",
    frame: "subscription",
    context: "Lectura de los métodos habilitados por el servidor.",
    render: (): JSX.Element => <PaymentMethodsSkeleton />,
  },
  {
    name: "Suscripción · formulario",
    frame: "subscription",
    context: "Preparación del formulario de pago elegido.",
    render: (): JSX.Element => <PaymentFormSkeleton method="card" />,
  },
  {
    name: "Suscripción · formulario Nequi",
    frame: "subscription",
    context: "Campos de correo y teléfono para el método seleccionado.",
    render: (): JSX.Element => <PaymentFormSkeleton method="nequi" />,
  },
  {
    name: "Suscripción · formulario DaviPlata",
    frame: "subscription",
    context: "Campos de correo, teléfono y documento para el método seleccionado.",
    render: (): JSX.Element => <PaymentFormSkeleton method="daviplata" />,
  },
  {
    name: "Acceso · sesión y código",
    frame: "application",
    context: "Estructura inicial del acceso antes de preparar el código de la aplicación.",
    render: (): JSX.Element => <ApplicationSkeleton surface="access" />,
  },
  {
    name: "Aplicación · sesión y código",
    frame: "application",
    context: "Primera comprobación de sesión y preparación del código de la aplicación.",
    render: (): JSX.Element => <ApplicationSkeleton surface="application" />,
  },
] as const;

const PreviewHeader = ({
  paused,
  dark,
  setPaused,
  setDark,
}: Readonly<{
  paused: boolean;
  dark: boolean;
  setPaused: (value: boolean) => void;
  setDark: (value: boolean) => void;
}>): JSX.Element => (
  <header className="flex flex-wrap items-center justify-between gap-5 border-b px-6 py-5">
    <div className="grid gap-2">
      <h1 className="text-3xl font-semibold">Estados de carga</h1>
      <p className="text-sm text-muted-foreground">
        {previews.length} casos · componentes reales · sin datos personales
      </p>
    </div>
    <div className="flex gap-3">
      <Button variant="outline" aria-pressed={paused} onClick={() => setPaused(!paused)}>
        {paused ? "Reanudar animación" : "Pausar animación"}
      </Button>
      <Button variant="outline" aria-pressed={dark} onClick={() => setDark(!dark)}>
        {dark ? "Tema claro" : "Tema oscuro"}
      </Button>
    </div>
  </header>
);

export const LoadingReference = (): JSX.Element => {
  const [selected, select] = useState<number>(0);
  const [dark, setDark] = useState(false);
  const [paused, setPaused] = useState(false);
  const preview = previews[selected] ?? previews[0];
  const themeScope = useCallback<RefCallback<HTMLDivElement>>(
    (element) => {
      if (element === null) return;
      const root = element.ownerDocument.documentElement;
      const previous = root.classList.contains("dark");
      root.classList.toggle("dark", dark);
      return (): void => {
        root.classList.toggle("dark", previous);
      };
    },
    [dark]
  );
  return (
    <div ref={themeScope} className="min-h-svh bg-background text-foreground">
      <PreviewHeader paused={paused} dark={dark} setPaused={setPaused} setDark={setDark} />
      <div className="grid lg:grid-cols-4">
        <nav
          aria-label="Casos de carga"
          className="grid content-start gap-1 border-r p-4 lg:sticky lg:top-0 lg:max-h-svh lg:overflow-y-auto"
        >
          {previews.map((entry, index) => (
            <Button
              key={entry.name}
              variant={selected === index ? "secondary" : "ghost"}
              contentLayout="wrap"
              aria-pressed={selected === index}
              onClick={() => select(index)}
            >
              {entry.name}
            </Button>
          ))}
        </nav>
        <main className="min-w-0 lg:col-span-3">
          <div className="grid gap-3 border-b p-6">
            <h2 className="text-2xl font-semibold">{preview.name}</h2>
            <p className="text-muted-foreground">{preview.context}</p>
            <p className="text-sm text-muted-foreground">
              La vista previa mantiene la carga pendiente para poder revisarla. En la aplicación se
              reemplaza por la información en cuanto llega.
            </p>
          </div>
          <section
            aria-label="Vista previa del esqueleto"
            className={paused ? "[&_*]:animate-none" : ""}
          >
            <PreviewFrame frame={preview.frame}>{preview.render()}</PreviewFrame>
          </section>
        </main>
      </div>
    </div>
  );
};
