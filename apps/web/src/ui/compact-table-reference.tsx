import type { JSX } from "react";
import { Badge } from "@/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";

const examples = [
  { name: "Mi agente personal para reportes mensuales", created: "01-10-2026", used: "10-10-2026" },
  { name: "Agente de prueba", created: "09-10-2026", used: "Nunca" },
];

/** Synthetic metadata demonstrates compact density and contained scrolling. */
export const CompactTableReference = (): JSX.Element => (
  <section aria-labelledby="compact-table-heading" className="flex min-w-0 flex-col gap-4">
    <h2 id="compact-table-heading" className="text-2xl font-semibold tracking-tight">
      Tablas de administración
    </h2>
    <p className="text-sm text-muted-foreground">
      Nombres largos se ajustan; las fechas permanecen legibles. En pantallas pequeñas, desplaza
      solo la tabla.
    </p>
    <Table className="min-w-96 table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead density="compact">Nombre</TableHead>
          <TableHead density="compact">Permisos</TableHead>
          <TableHead density="compact">Creado el</TableHead>
          <TableHead density="compact">Último uso</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {examples.map((example) => (
          <TableRow key={example.name}>
            <TableCell density="compact" className="break-words font-semibold">
              {example.name}
            </TableCell>
            <TableCell density="compact">
              <Badge variant="secondary">Lectura</Badge>
            </TableCell>
            <TableCell density="compact">{example.created}</TableCell>
            <TableCell density="compact">{example.used}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </section>
);
