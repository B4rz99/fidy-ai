const guideGroups = [
  { title: "Empieza aquí", links: [{ href: "/", label: "Guía de Fidy" }] },
  {
    title: "Conectar mi agente",
    links: [
      { href: "/conectar/mcp", label: "MCP", accessibleLabel: "Conectar mi agente con MCP" },
      { href: "/conectar/claude-code", label: "Claude Code" },
      { href: "/conectar/codex", label: "Codex" },
      { href: "/conectar/cli", label: "CLI" },
    ],
  },
  {
    title: "Tus transacciones",
    links: [
      { href: "/transacciones/registrar-corregir", label: "Registrar y corregir" },
      { href: "/consultar/finanzas", label: "Consultar mis finanzas" },
    ],
  },
  {
    title: "Acceso y ayuda",
    links: [
      { href: "/acceso/permisos", label: "Permisos y acceso" },
      { href: "/ayuda/problemas", label: "Solución de problemas" },
    ],
  },
  {
    title: "Uso avanzado",
    links: [
      { href: "/avanzado/api", label: "API avanzada" },
      { href: "/referencia/esquemas", label: "Esquemas del contrato" },
    ],
  },
  { title: "Referencia", links: [{ href: "/reference", label: "Todas las operaciones" }] },
] as const;

const pageGroup = (id: string): string =>
  guideGroups.find((group) => group.links.some((link) => link.href === `/${id}`))?.title ??
  "Referencia";

export { guideGroups, pageGroup };
