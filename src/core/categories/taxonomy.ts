import { CategoryId } from "~/core/_shared/category";
import { CategoryLabel } from "./model";

/** Stable identities for the Colombian Categories. */
export const categoryIds = {
  restaurantes: CategoryId.make("10000000-0000-4000-8000-000000000001"),
  domicilios: CategoryId.make("10000000-0000-4000-8000-000000000002"),
  mercado: CategoryId.make("10000000-0000-4000-8000-000000000003"),
  transporte: CategoryId.make("10000000-0000-4000-8000-000000000004"),
  vivienda: CategoryId.make("10000000-0000-4000-8000-000000000005"),
  servicios: CategoryId.make("10000000-0000-4000-8000-000000000006"),
  salud: CategoryId.make("10000000-0000-4000-8000-000000000007"),
  educacion: CategoryId.make("10000000-0000-4000-8000-000000000008"),
  compras: CategoryId.make("10000000-0000-4000-8000-000000000009"),
  entretenimiento: CategoryId.make("10000000-0000-4000-8000-000000000010"),
  viajes: CategoryId.make("10000000-0000-4000-8000-000000000011"),
  impuestos: CategoryId.make("10000000-0000-4000-8000-000000000012"),
  transferencias: CategoryId.make("10000000-0000-4000-8000-000000000013"),
  retirosDeEfectivo: CategoryId.make("10000000-0000-4000-8000-000000000014"),
  ingresos: CategoryId.make("10000000-0000-4000-8000-000000000015"),
  otros: CategoryId.make("10000000-0000-4000-8000-000000000016"),
} as const;

/** Seed-ready Colombian Categories in presentation order. */
export const categoryRows = [
  {
    id: categoryIds.restaurantes,
    label: CategoryLabel.make("Restaurantes"),
    displayOrder: 0,
  },
  { id: categoryIds.domicilios, label: CategoryLabel.make("Domicilios"), displayOrder: 1 },
  { id: categoryIds.mercado, label: CategoryLabel.make("Mercado"), displayOrder: 2 },
  { id: categoryIds.transporte, label: CategoryLabel.make("Transporte"), displayOrder: 3 },
  { id: categoryIds.vivienda, label: CategoryLabel.make("Vivienda"), displayOrder: 4 },
  { id: categoryIds.servicios, label: CategoryLabel.make("Servicios"), displayOrder: 5 },
  { id: categoryIds.salud, label: CategoryLabel.make("Salud"), displayOrder: 6 },
  { id: categoryIds.educacion, label: CategoryLabel.make("Educación"), displayOrder: 7 },
  { id: categoryIds.compras, label: CategoryLabel.make("Compras"), displayOrder: 8 },
  {
    id: categoryIds.entretenimiento,
    label: CategoryLabel.make("Entretenimiento"),
    displayOrder: 9,
  },
  { id: categoryIds.viajes, label: CategoryLabel.make("Viajes"), displayOrder: 10 },
  { id: categoryIds.impuestos, label: CategoryLabel.make("Impuestos"), displayOrder: 11 },
  {
    id: categoryIds.transferencias,
    label: CategoryLabel.make("Transferencias"),
    displayOrder: 12,
  },
  {
    id: categoryIds.retirosDeEfectivo,
    label: CategoryLabel.make("Retiros de efectivo"),
    displayOrder: 13,
  },
  { id: categoryIds.ingresos, label: CategoryLabel.make("Ingresos"), displayOrder: 14 },
  { id: categoryIds.otros, label: CategoryLabel.make("Otros"), displayOrder: 15 },
] as const;
