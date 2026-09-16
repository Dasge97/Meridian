// Qué tipo de operación es una decisión, para la lista, el detalle y la
// gráfica de Mercado. Sin estilos: la importan vistas que no cargan decisions.css.
import {
  CirclePlus,
  CircleMinus,
  CirclePause,
  CircleArrowDown,
  CircleArrowUp,
  CircleChevronDown,
  CircleChevronUp,
  type LucideIcon,
} from "lucide-react";
import type { Decision } from "../../src/domain";
import type { OrderIntent } from "../../src/risk";

// Mismo tipo que src/risk.ts, que no arrastra dependencias al navegador.
export type Intent = OrderIntent;

export type DecisionType = {
  key: string;
  text: string;
  // Forma plural en minúscula, para resúmenes como «2 ventas en corto».
  one: string;
  many: string;
  Icon: LucideIcon;
  // Dirección del dinero: compra (buy), venta (sell) o nada (wait).
  side: "buy" | "sell" | "wait";
  short: boolean;
};

const TYPES = {
  buy: {
    text: "Compra",
    one: "compra",
    many: "compras",
    Icon: CirclePlus,
    side: "buy",
    short: false,
  },
  sell: {
    text: "Venta",
    one: "venta",
    many: "ventas",
    Icon: CircleMinus,
    side: "sell",
    short: false,
  },
  wait: {
    text: "Espera",
    one: "espera",
    many: "esperas",
    Icon: CirclePause,
    side: "wait",
    short: false,
  },
  open_short: {
    text: "Venta en corto",
    one: "venta en corto",
    many: "ventas en corto",
    Icon: CircleArrowDown,
    side: "sell",
    short: true,
  },
  add_short: {
    text: "Amplía corto",
    one: "ampliación de corto",
    many: "ampliaciones de corto",
    Icon: CircleChevronDown,
    side: "sell",
    short: true,
  },
  reduce_short: {
    text: "Reduce corto",
    one: "reducción de corto",
    many: "reducciones de corto",
    Icon: CircleChevronUp,
    side: "buy",
    short: true,
  },
  close_short: {
    text: "Recompra",
    one: "recompra",
    many: "recompras",
    Icon: CircleArrowUp,
    side: "buy",
    short: true,
  },
} satisfies Record<string, Omit<DecisionType, "key">>;

const BY_INTENT: Record<Intent, keyof typeof TYPES> = {
  open_long: "buy",
  add_long: "buy",
  reduce_long: "sell",
  close_long: "sell",
  open_short: "open_short",
  add_short: "add_short",
  reduce_short: "reduce_short",
  close_short: "close_short",
};

// El servidor lo guarda en la decisión. Se admite también dentro de la
// propuesta por si llega así.
export const intentOf = (d: Decision): Intent | undefined => {
  const x =
    (d as { intent?: string }).intent ??
    (d.proposal as { intent?: string }).intent;
  return x && Object.hasOwn(BY_INTENT, x) ? (x as Intent) : undefined;
};

// Sin intent (decisiones antiguas) se usa la acción, como hasta ahora.
export function decisionType(d: Decision): DecisionType {
  const intent = intentOf(d);
  const action = Object.hasOwn(TYPES, d.proposal.action)
    ? d.proposal.action
    : "wait";
  const key = intent ? BY_INTENT[intent] : action;
  return { key, ...TYPES[key] };
}

// Explica en una frase lo que no es evidente de una operación en corto.
export const shortNote: Partial<Record<Intent, string>> = {
  open_short:
    "Vende acciones que no tiene. Gana si el precio baja y pierde si sube.",
  add_short: "Vende más acciones prestadas sobre una posición corta abierta.",
  reduce_short: "Compra parte de las acciones para devolverlas.",
  close_short:
    "Compra las acciones para devolverlas y cierra la posición corta.",
};
