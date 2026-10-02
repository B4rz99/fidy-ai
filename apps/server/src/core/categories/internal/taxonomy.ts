import { CategoryLabel, categoryIds } from "~/core/categories/contract";

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
