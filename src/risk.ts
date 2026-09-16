// Niveles de riesgo y significado de cada orden. Sin dependencias: el panel lo
// importa como datos sin arrastrar zod ni nada del servidor. src/domain.ts lo
// reexporta, así que también se puede importar desde allí.
//
// El 16/09/2026 el agente llevaba 1 orden en 54 decisiones. Las instrucciones le
// dejaban esperar si lo justificaba, las noticias lo despertaban cada 30 minutos
// para repasar la misma posición y no podía vender en corto con el mercado
// bajando. Cada nivel cambia esas tres cosas a la vez, para poder comparar.
export const RISK_PROFILES = {
  prudent: {
    label: "Prudente",
    scanEveryMinutes: 30,
    newsWakesAgent: true,
    shorts: false,
    sizing: "small",
    exit: "tight",
    description:
      "Mira el mercado cada media hora, puede quedarse sin operar si nada le convence y usa operaciones pequeñas con salidas cercanas.",
  },
  balanced: {
    label: "Equilibrado",
    scanEveryMinutes: 20,
    newsWakesAgent: true,
    shorts: false,
    sizing: "medium",
    exit: "medium",
    description:
      "Mira el mercado cada 20 minutos y solo se queda sin operar si explica con cifras por qué no hay ninguna entrada. Operaciones de tamaño medio.",
  },
  active: {
    label: "Activo",
    scanEveryMinutes: 15,
    newsWakesAgent: false,
    shorts: false,
    sizing: "large",
    exit: "wide",
    description:
      "Mira el mercado cada 15 minutos y en cada revisión propone al menos una operación, salvo que algo concreto se lo impida. Operaciones grandes con más margen hasta la salida. Las noticias se comentan en la siguiente revisión.",
  },
  aggressive: {
    label: "Agresivo",
    scanEveryMinutes: 10,
    newsWakesAgent: false,
    shorts: true,
    sizing: "max",
    exit: "wide",
    description:
      "Mira el mercado cada 10 minutos, busca varias operaciones al día, usa todo lo que permiten los límites y apuesta a la baja (venta en corto) cuando el mercado cae.",
  },
} as const;
export type RiskProfile = keyof typeof RISK_PROFILES;
export const RISK_PROFILE_KEYS = Object.keys(RISK_PROFILES) as [
  RiskProfile,
  ...RiskProfile[],
];
export const DEFAULT_RISK_PROFILE: RiskProfile = "balanced";
// Parte de maxOrderUsd que usa una operación nueva.
export const SIZING_SHARE = {
  small: 0.25,
  medium: 0.5,
  large: 0.8,
  max: 1,
} as const;
// Distancia de las salidas, en veces el movimiento diario habitual (atr14).
export const EXIT_ATR = {
  tight: { min: 1, max: 1 },
  medium: { min: 1.5, max: 1.5 },
  wide: { min: 2, max: 3 },
} as const;
// Un nivel desconocido (un estado editado a mano, un nivel retirado) se trata
// como el de por defecto en lugar de romper la evaluación.
export function riskProfileOf(settings: { riskProfile?: string } | undefined) {
  const key = settings?.riskProfile;
  const profile: RiskProfile =
    key && Object.hasOwn(RISK_PROFILES, key)
      ? (key as RiskProfile)
      : DEFAULT_RISK_PROFILE;
  return { key: profile, ...RISK_PROFILES[profile] };
}
// Qué significa una orden según la posición que hay en ese momento. En Alpaca
// una posición corta tiene qty negativa.
export type OrderIntent =
  | "open_long"
  | "add_long"
  | "reduce_long"
  | "close_long"
  | "open_short"
  | "add_short"
  | "reduce_short"
  | "close_short";
// Las mismas etiquetas que usa el panel.
export const INTENT_LABELS: Record<OrderIntent, string> = {
  open_long: "Compra",
  add_long: "Amplía compra",
  reduce_long: "Venta parcial",
  close_long: "Venta",
  open_short: "Venta en corto",
  add_short: "Amplía corto",
  reduce_short: "Reduce corto",
  close_short: "Recompra",
};
// Nombre corto de la operación para los avisos: compra, venta, venta en corto o
// recompra. Una decisión anterior a la intención se nombra por su acción.
export function tradeName(
  intent: OrderIntent | undefined,
  action: "buy" | "sell" | "wait",
) {
  if (intent === "open_short" || intent === "add_short")
    return "Venta en corto";
  if (intent === "reduce_short" || intent === "close_short") return "Recompra";
  return action === "buy" ? "Compra" : "Venta";
}
// Devuelve la intención, o el cruce que no se permite: pasar de largo a corto
// (o al revés) en una sola orden.
export function orderIntent(
  heldQty: number,
  action: "buy" | "sell",
  qty: number,
): OrderIntent | "long_to_short" | "short_to_long" {
  if (action === "buy") {
    if (heldQty < 0) {
      const debe = -heldQty;
      return qty < debe
        ? "reduce_short"
        : qty === debe
          ? "close_short"
          : "short_to_long";
    }
    return heldQty === 0 ? "open_long" : "add_long";
  }
  if (heldQty > 0)
    return qty < heldQty
      ? "reduce_long"
      : qty === heldQty
        ? "close_long"
        : "long_to_short";
  return heldQty === 0 ? "open_short" : "add_short";
}
export const opensRisk = (i: OrderIntent) =>
  i === "open_long" ||
  i === "add_long" ||
  i === "open_short" ||
  i === "add_short";
// Dos intenciones significan lo mismo si van en el mismo lado y en la misma
// dirección. Abrir o ampliar da igual; reducir o cerrar también.
export function sameMeaning(a: OrderIntent, b: OrderIntent) {
  const grupo = (i: OrderIntent) =>
    `${i.endsWith("long") ? "long" : "short"}:${opensRisk(i) ? "up" : "down"}`;
  return grupo(a) === grupo(b);
}
