import { useCallback, useState, useSyncExternalStore } from "react";
import type { JSX, RefCallback } from "react";
import { CheckmarkCircle02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/ui/components/empty";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { Skeleton } from "@/ui/components/skeleton";
import { Spinner } from "@/ui/components/spinner";
import { CompactTableReference } from "./compact-table-reference";
import { cn } from "./class-names";
import { BudgetBalance, BudgetMeter } from "@/ui/components/budget-meter";
import { FinancialReference } from "./financial-reference";
import { PatternReference } from "./pattern-reference";
import { DashboardReference } from "./dashboard-reference";
import { AccessReference } from "./access-reference";
import { WorkspaceReference } from "./workspace-reference";
import { ReviewReference } from "./review-reference";
import "./reference.css";

const themes = ["light", "dark", "system"] as const;
type Theme = (typeof themes)[number];
const themeLabels: Record<Theme, string> = { light: "Claro", dark: "Oscuro", system: "Sistema" };
const systemDark = (): boolean => window.matchMedia("(prefers-color-scheme: dark)").matches;
const subscribeToTheme = (notify: () => void): (() => void) => {
  const preference = window.matchMedia("(prefers-color-scheme: dark)");
  preference.addEventListener("change", notify);
  return () => preference.removeEventListener("change", notify);
};

const ReferenceHeader = ({
  theme,
  onTheme,
}: Readonly<{ theme: Theme; onTheme: (theme: Theme) => void }>): JSX.Element => (
  <header className="flex flex-col gap-6 border-b pb-8 sm:flex-row sm:items-start sm:justify-between">
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">Fidy · Interfaz de la aplicación</p>
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        Tu plata, con claridad.
      </h1>
      <p className="max-w-xl text-muted-foreground">
        Una base cálida, legible y tranquila para registrar y entender tus transacciones.
      </p>
      <Badge variant="information">Referencia local · Datos de ejemplo</Badge>
    </div>
    <fieldset className="flex shrink-0 flex-wrap gap-2">
      <legend className="mb-2 text-sm font-semibold">Apariencia</legend>
      {themes.map((choice) => (
        <Button
          key={choice}
          variant={theme === choice ? "default" : "outline"}
          aria-pressed={theme === choice}
          onClick={() => onTheme(choice)}
        >
          {themeLabels[choice]}
        </Button>
      ))}
    </fieldset>
  </header>
);

const palette = [
  { name: "Acción principal", fill: "bg-primary", ink: "text-primary-foreground" },
  { name: "Superficie cálida", fill: "bg-secondary", ink: "text-secondary-foreground" },
  { name: "Guardado", fill: "bg-success-subtle", ink: "text-success-foreground" },
  { name: "Atención", fill: "bg-warning-subtle", ink: "text-warning-foreground" },
  { name: "Error", fill: "bg-error-subtle", ink: "text-error-foreground" },
  { name: "Información", fill: "bg-info-subtle", ink: "text-info-foreground" },
  { name: "Por revisar", fill: "bg-pending", ink: "text-on-pastel" },
];
const PaletteReference = (): JSX.Element => (
  <section aria-labelledby="palette-heading" className="flex flex-col gap-4">
    <h2 id="palette-heading" className="text-2xl font-semibold tracking-tight">
      Color con propósito
    </h2>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {palette.map(({ name, fill, ink }) => (
        <div
          key={name}
          className={cn(
            "flex min-h-24 items-end rounded-lg border p-4 text-sm font-semibold",
            fill,
            ink
          )}
        >
          {name}
        </div>
      ))}
    </div>
  </section>
);

const ActionReference = (): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>Acciones claras</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-5">
      <p className="text-muted-foreground">Una acción principal. El resto acompaña.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button>Registrar transacción</Button>
        <Button variant="outline">Cancelar</Button>
        <Button variant="link">Ver historial</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled>
          <Spinner />
          Guardando…
        </Button>
        <Button variant="outline" disabled>
          Acción no disponible
        </Button>
        <Button variant="destructive">Retirar autorización</Button>
        <Button variant="destructive" disabled>
          Retirar autorización
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Ejemplos visuales: estos botones no registran transacciones.
      </p>
    </CardContent>
  </Card>
);

const FieldReference = (): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>Campos que orientan</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="reference-amount">Monto en COP</Label>
        <Input
          id="reference-amount"
          inputMode="decimal"
          placeholder="28000"
          aria-describedby="reference-amount-help"
        />
        <p id="reference-amount-help" className="text-sm text-muted-foreground">
          Ejemplo: 28000 para una transacción de $28.000 COP.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="reference-error">Monto con error</Label>
        <Input
          id="reference-error"
          defaultValue="0"
          aria-invalid="true"
          aria-describedby="reference-error-help"
        />
        <p
          id="reference-error-help"
          className="rounded-lg bg-destructive p-3 text-sm text-destructive-foreground"
        >
          Ingresa un monto mayor que cero.
        </p>
      </div>
    </CardContent>
  </Card>
);

const feedback = [
  {
    variant: "success",
    title: "Transacción registrada",
    description: "Ya puedes verla en tu historial.",
  },
  {
    variant: "warning",
    title: "Revisa el historial antes de intentarlo de nuevo",
    description: "No pudimos confirmar si la transacción se guardó.",
  },
  {
    variant: "destructive",
    title: "No pudimos guardar la transacción",
    description: "Tus datos siguen en el formulario. Revísalos e intenta de nuevo.",
  },
  {
    variant: "information",
    title: "Estas cifras son un ejemplo",
    description: "Esta referencia no consulta ni cambia tus datos.",
  },
  {
    variant: "pending",
    title: "Transacción por revisar",
    description: "Hace falta confirmar los datos antes de registrarla.",
  },
] as const;
const FeedbackReference = (): JSX.Element => (
  <section aria-labelledby="feedback-heading" className="flex flex-col gap-4">
    <h2 id="feedback-heading" className="text-2xl font-semibold tracking-tight">
      Cada estado explica qué sigue
    </h2>
    <div className="grid gap-4 md:grid-cols-2">
      {feedback.map(({ variant, title, description }) => (
        <Alert key={variant} variant={variant} role="note">
          <HugeiconsIcon
            icon={variant === "success" ? CheckmarkCircle02Icon : InformationCircleIcon}
            size={20}
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{description}</AlertDescription>
        </Alert>
      ))}
    </div>
  </section>
);

const TransactionReference = (): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>Transacciones fáciles de leer</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
        <div>
          <p className="font-semibold">La Cocina</p>
          <p className="text-sm text-muted-foreground">Restaurantes · 9 de octubre de 2026</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <p className="font-semibold tabular-nums">− COP 28.000,00</p>
          <Badge variant="outline">Gasto</Badge>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        El signo y la etiqueta explican la dirección. Un gasto normal no es un error.
      </p>
    </CardContent>
  </Card>
);

const EmptyReference = (): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>Vacío y carga son estados distintos</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-6">
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Aún no hay transacciones este mes</EmptyTitle>
          <EmptyDescription>
            Registra tu primera transacción para empezar a ver tu historial.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
      <div aria-label="Ejemplo de carga" className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">Cargando transacciones…</p>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </CardContent>
  </Card>
);

const densityNotice = (
  <p className="border-t pt-6 text-sm text-muted-foreground">
    Poppins · Texto de lectura de 16 px · Controles principales de 44–48 px
  </p>
);

const BudgetReference = (): JSX.Element => (
  <section
    aria-label="Indicadores de presupuestos"
    className="flex flex-col gap-4 rounded-lg border bg-card p-5"
  >
    <h2 className="text-lg font-semibold">Presupuestos</h2>
    <div>
      <BudgetBalance over={false}>$ 120.000,00 disponibles</BudgetBalance>
      <BudgetMeter
        variant="default"
        value={60}
        over={false}
        label="Presupuesto con saldo disponible"
      />
    </div>
    <div>
      <BudgetBalance over>$ 30.000,00 excedidos</BudgetBalance>
      <BudgetMeter variant="default" value={100} over label="Presupuesto excedido" />
    </div>
  </section>
);

export const UIReference = (): JSX.Element => {
  const [theme, setTheme] = useState<Theme>("dark");
  const prefersDark = useSyncExternalStore(subscribeToTheme, systemDark);
  const dark = theme === "dark" || (theme === "system" && prefersDark);
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
    <div ref={themeScope} className="ui-reference min-h-svh bg-background text-foreground">
      <main className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-8 sm:px-6 lg:px-12">
        <ReferenceHeader theme={theme} onTheme={setTheme} />
        <PatternReference />
        <AccessReference dark={dark} />
        <PaletteReference />
        <div className="grid gap-6 lg:grid-cols-2">
          <ActionReference />
          <FieldReference />
        </div>
        <WorkspaceReference />
        <ReviewReference />
        <DashboardReference />
        <CompactTableReference />
        <FinancialReference />
        <BudgetReference />
        <FeedbackReference />
        <div className="grid gap-6 lg:grid-cols-2">
          <TransactionReference />
          <EmptyReference />
        </div>
        {densityNotice}
      </main>
    </div>
  );
};
