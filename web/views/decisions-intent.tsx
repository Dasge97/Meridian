// Qué tipo de operación es una decisión, para la lista, el detalle y la
// gráfica de Mercado. Sin estilos: la importan vistas que no cargan decisions.css.
import {
  CirclePlus,
  CircleMinus,
  CirclePause,
  type LucideIcon,
} from "lucide-react";
import type { Decision } from "../../src/domain";
import type { OrderIntent } from "../../src/risk";

// Mismo tipo que src/risk.ts, que no arrastra dependencias al navegador.
export type Intent = OrderIntent;

export type DecisionType = {
  key: string;
  text: string;
  // Forma plural en minúscula, para resúmenes como «2 compras · 1 venta».
  one: string;
  many: string;
  Icon: LucideIcon;
  // Dirección del dinero: compra (buy), venta (sell) o nada (wait).
  side: "buy" | "sell" | "wait";
};

const TYPES = {
  buy: {
    text: "Compra",
    one: "compra",
    many: "compras",
    Icon: CirclePlus,
    side: "buy",
  },
  sell: {
    text: "Venta",
    one: "venta",
    many: "ventas",
    Icon: CircleMinus,
    side: "sell",
  },
  wait: {
    text: "Espera",
    one: "espera",
    many: "esperas",
    Icon: CirclePause,
    side: "wait",
  },
} satisfies Record<string, Omit<DecisionType, "key">>;

const BY_INTENT: Record<Intent, keyof typeof TYPES> = {
  open_long: "buy",
  add_long: "buy",
  reduce_long: "sell",
  close_long: "sell",
};

// El servidor lo guarda en la decisión. Se admite también dentro de la
// propuesta por si llega así. Una intención que ya no existe, como las de
// cuando había ventas en corto (open_short, close_short…), no se reconoce.
const intentOf = (d: Decision): Intent | undefined => {
  const x =
    (d as { intent?: string }).intent ??
    (d.proposal as { intent?: string }).intent;
  return x && Object.hasOwn(BY_INTENT, x) ? (x as Intent) : undefined;
};

// Sin intención conocida (decisiones antiguas) se usa la acción: una venta en
// corto guardada se muestra como venta y su recompra, como compra.
export function decisionType(d: Decision): DecisionType {
  const intent = intentOf(d);
  const action = Object.hasOwn(TYPES, d.proposal.action)
    ? d.proposal.action
    : "wait";
  const key = intent ? BY_INTENT[intent] : action;
  return { key, ...TYPES[key] };
}
