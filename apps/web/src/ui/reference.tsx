import { useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
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
import { cn } from "./class-names";
import { type DarkPalette, darkPalettes } from "./dark-palettes";
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

const DarkPaletteReference = ({
  selected,
  onSelect,
}: Readonly<{ selected: DarkPalette; onSelect: (palette: DarkPalette) => void }>): JSX.Element => (
  <section aria-labelledby="dark-options-heading" className="flex flex-col gap-4">
    <div className="flex flex-col gap-2">
      <h2 id="dark-options-heading" className="text-2xl font-semibold tracking-tight">
        Cuatro formas de ver la noche
      </h2>
      <p className="max-w-2xl text-muted-foreground">
        Compara los mismos elementos en cuatro paletas sin azul. Elige una para verla en toda esta
        página.
      </p>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      {darkPalettes.map(({ id, name, description }) => (
        <article
          key={id}
          data-dark-palette={id}
          aria-label={name}
          className="dark flex flex-col gap-5 rounded-xl border bg-background p-5 text-foreground"
        >
          <div className="flex flex-col gap-2">
            <h3 className="text-lg font-semibold">{name}</h3>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-card p-4 text-card-foreground">
            <div>
              <p className="font-semibold">La Cocina</p>
              <p className="text-sm text-muted-foreground">Restaurantes</p>
            </div>
            <p className="font-semibold tabular-nums">− $28.000 COP</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Badge variant="success">Registrada</Badge>
            <Button
              aria-label={`Probar ${name}`}
              aria-pressed={selected === id}
              variant={selected === id ? "default" : "outline"}
              onClick={() => onSelect(id)}
            >
              {selected === id ? "Viendo esta opción" : "Probar esta opción"}
            </Button>
          </div>
        </article>
      ))}
    </div>
  </section>
);

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
  { name: "Guardado", fill: "bg-success", ink: "text-on-pastel" },
  { name: "Atención", fill: "bg-warning", ink: "text-on-pastel" },
  { name: "Error", fill: "bg-destructive", ink: "text-destructive-foreground" },
  { name: "Información", fill: "bg-information", ink: "text-on-pastel" },
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

/** Local design reference composed from the same tokens and primitives as the application. */
export const UIReference = (): JSX.Element => {
  const [theme, setTheme] = useState<Theme>("dark");
  const [darkPalette, setDarkPalette] = useState<DarkPalette>("graphite");
  const prefersDark = useSyncExternalStore(subscribeToTheme, systemDark);
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  return (
    <div
      data-dark-palette={darkPalette}
      className={cn("ui-reference min-h-svh bg-background text-foreground", dark && "dark")}
    >
      <main className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-8 sm:px-6 lg:px-12">
        <ReferenceHeader theme={theme} onTheme={setTheme} />
        <DarkPaletteReference
          selected={darkPalette}
          onSelect={(palette) => {
            setDarkPalette(palette);
            setTheme("dark");
          }}
        />
        <PaletteReference />
        <div className="grid gap-6 lg:grid-cols-2">
          <ActionReference />
          <FieldReference />
        </div>
        <FeedbackReference />
        <div className="grid gap-6 lg:grid-cols-2">
          <TransactionReference />
          <EmptyReference />
        </div>
        <p className="border-t pt-6 text-sm text-muted-foreground">
          Poppins · Texto de lectura de 16 px · Controles principales de 44–48 px
        </p>
      </main>
    </div>
  );
};
