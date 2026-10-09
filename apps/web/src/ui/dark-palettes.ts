export const darkPalettes = [
  {
    id: "charcoal",
    name: "Carbón cálido",
    description: "Negros suaves con un toque cálido.",
  },
  {
    id: "graphite",
    name: "Grafito",
    description: "La paleta elegida para Fidy. Grises neutros; verde y pasteles como acentos.",
  },
  {
    id: "olive",
    name: "Oliva oscuro",
    description: "Un matiz vegetal discreto. Cercano al verde de la marca.",
  },
  {
    id: "espresso",
    name: "Espresso",
    description: "Marrones profundos y texto crema. Más cálido y expresivo.",
  },
] as const;
export type DarkPalette = (typeof darkPalettes)[number]["id"];
