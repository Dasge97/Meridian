// Niveles de riesgo y significado de cada orden. Sin dependencias: el panel lo
// importa como datos sin arrastrar zod ni nada del servidor. src/domain.ts lo
// reexporta, así que también se puede importar desde allí.
//
// El 16/09/2026 el agente llevaba 1 orden en 54 decisiones. Las instrucciones le
// dejaban esperar si lo justificaba, las noticias lo despertaban cada 30 minutos
// para repasar la misma posición y, con el mercado bajando, solo esperaba. Cada
// nivel cambia a la vez cada cuánto mira el mercado, si las noticias lo
// despiertan y cuánto arriesga, para poder comparar. Ningún nivel vende en corto.
export const RISK_PROFILES = {
  prudent: {
    label: "Prudente",
    scanEveryMinutes: 30,
    newsWakesAgent: true,
    sizing: "small",
    exit: "tight",
    description:
      "Mira el mercado cada media hora, puede quedarse sin operar si nada le convence y usa operaciones pequeñas con salidas cercanas.",
  },
  balanced: {
    label: "Equilibrado",
    scanEveryMinutes: 20,
    newsWakesAgent: true,
    sizing: "medium",
    exit: "medium",
    description:
      "Mira el mercado cada 20 minutos y solo se queda sin operar si explica con cifras por qué no hay ninguna entrada. Operaciones de tamaño medio.",
  },
  active: {
    label: "Activo",
    scanEveryMinutes: 15,
    newsWakesAgent: false,
    sizing: "large",
    exit: "wide",
    description:
      "Mira el mercado cada 15 minutos y en cada revisión propone al menos una operación, salvo que algo concreto se lo impida. Operaciones grandes con más margen hasta la salida. Las noticias se comentan en la siguiente revisión.",
  },
  aggressive: {
    label: "Agresivo",
    scanEveryMinutes: 10,
    newsWakesAgent: false,
    sizing: "max",
    exit: "wide",
    description:
      "Mira el mercado cada 10 minutos, busca varias operaciones al día y usa lo que permiten los límites, sin más de 2 posiciones del mismo grupo de activos. Solo compra lo que hoy va por encima de su precio medio del día. Cuando el mercado cae, reduce o cierra lo que tiene antes de abrir nada nuevo.",
  },
} as const;
// Activos que suelen moverse juntos. El 16/09/2026, en su primera sesión, el
// nivel Agresivo compró NVDA, AMD, AAPL, META, GOOGL y TSLA en 12 minutos
// creyendo que repartía el riesgo: si cae la tecnología, caen las seis. Un
// activo que no está aquí forma su propio grupo.
export const SYMBOL_GROUPS: Record<string, string> = {
  NVDA: "Semiconductores",
  AMD: "Semiconductores",
  AVGO: "Semiconductores",
  AAPL: "Grandes tecnológicas",
  MSFT: "Grandes tecnológicas",
  GOOGL: "Grandes tecnológicas",
  META: "Grandes tecnológicas",
  AMZN: "Grandes tecnológicas",
  NFLX: "Grandes tecnológicas",
  TSLA: "Grandes tecnológicas",
  XLK: "Grandes tecnológicas",
  QQQ: "Grandes tecnológicas",
  SPY: "Índices amplios",
  DIA: "Índices amplios",
  IWM: "Índices amplios",
  XLF: "Financieras",
  JPM: "Financieras",
  XLE: "Energía",
  GLD: "Oro",
  TLT: "Bonos del Tesoro",
};
export const groupOf = (symbol: string) =>
  Object.hasOwn(SYMBOL_GROUPS, symbol) ? SYMBOL_GROUPS[symbol] : symbol;
// Posiciones distintas del mismo grupo que pueden tener los niveles que empujan
// a operar (activo y agresivo). Ampliar una que ya se tiene no cuenta.
export const MAX_POSITIONS_PER_GROUP = 2;
export const limitsGroups = (profile: RiskProfile) =>
  profile === "active" || profile === "aggressive";
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
// Qué significa una orden según la posición que hay en ese momento. Solo hay
// posiciones largas: no se vende lo que no se tiene.
export type OrderIntent =
  "open_long" | "add_long" | "reduce_long" | "close_long";
// Las mismas etiquetas que usa el panel.
export const INTENT_LABELS: Record<OrderIntent, string> = {
  open_long: "Compra",
  add_long: "Amplía compra",
  reduce_long: "Venta parcial",
  close_long: "Venta",
};
// Una decisión guardada cuando había ventas en corto puede traer open_short,
// reduce_short y parecidos. Esas intenciones ya no existen: se tratan como si no
// hubiera intención y la orden se nombra por su acción, como venta o compra.
export const knownIntent = (intent: unknown): OrderIntent | undefined =>
  typeof intent === "string" && Object.hasOwn(INTENT_LABELS, intent)
    ? (intent as OrderIntent)
    : undefined;
// Nombre de la operación para los avisos.
export const tradeName = (action: "buy" | "sell" | "wait") =>
  action === "buy" ? "Compra" : "Venta";
// Etiqueta de la intención, o el nombre por la acción si no se conoce.
export const intentLabel = (
  intent: unknown,
  action: "buy" | "sell" | "wait",
) => {
  const known = knownIntent(intent);
  return known ? INTENT_LABELS[known] : tradeName(action);
};
// Devuelve la intención, o exceeds_position si la venta pide más acciones de
// las que hay: eso abriría una posición corta, y no se permite.
export function orderIntent(
  heldQty: number,
  action: "buy" | "sell",
  qty: number,
): OrderIntent | "exceeds_position" {
  if (action === "buy") return heldQty === 0 ? "open_long" : "add_long";
  if (heldQty <= 0 || qty > heldQty) return "exceeds_position";
  return qty < heldQty ? "reduce_long" : "close_long";
}
export const opensRisk = (i: OrderIntent) =>
  i === "open_long" || i === "add_long";
