// Tipos del endpoint /api/usage, nombres en español llano y piezas pequeñas que
// comparten la vista Uso, su gráfica y el detalle de una llamada.
import React from "react";
import { num } from "../shared";

// Los tipos salen del servidor, para que la vista no se desincronice del endpoint.
import type { UsageTrigger, UsageSection } from "../../src/domain";
import type {
  TriggerKey,
  UsageKind,
  UsageItem,
  UsageSummary,
  UsagePage,
} from "../../src/usage";
export type {
  UsageTrigger,
  UsageSection,
  TriggerKey,
  UsageKind,
  UsageItem,
  UsageSummary,
  UsagePage,
};
export type UsageDay = UsageSummary["byDay"][number];

// El orden fija el color y el apilado: nunca cambia con los filtros.
export const TRIGGERS: TriggerKey[] = [
  "watch",
  "periodic",
  "news",
  "preopen",
  "manual",
  "review",
  "other",
  "unknown",
];

export const triggerText: Record<TriggerKey, { label: string; hint: string }> =
  {
    watch: { label: "Vigilancia", hint: "Se activó una vigilancia de precio" },
    periodic: {
      label: "Revisión periódica",
      hint: "Repaso con la bolsa abierta",
    },
    news: { label: "Noticias", hint: "Llegaron noticias nuevas" },
    preopen: {
      label: "Antes de la apertura",
      hint: "Repaso de noticias antes de abrir",
    },
    manual: { label: "Reevaluar", hint: "Pulsaste el botón Reevaluar" },
    review: {
      label: "Revisión de operación",
      hint: "Revisa una orden ya enviada",
    },
    other: { label: "Otro motivo", hint: "No encaja en los anteriores" },
    unknown: {
      label: "Sin dato",
      hint: "Registros anteriores al detalle",
    },
  };

export const SECTIONS: UsageSection[] = [
  "instructions",
  "portfolio",
  "analysis",
  "intraday",
  "news",
  "watches",
  "lessons",
  "decisions",
  "reviewed",
];

export const sectionText: Record<
  UsageSection,
  { label: string; hint: string }
> = {
  instructions: {
    label: "Instrucciones",
    hint: "Instrucciones y formato de respuesta",
  },
  portfolio: { label: "Cartera", hint: "Cartera, precios, límites y hora" },
  analysis: { label: "Análisis diario", hint: "Un análisis por activo" },
  intraday: { label: "Velas de 5 minutos", hint: "Lo que va de sesión" },
  news: { label: "Noticias", hint: "Titulares y resúmenes" },
  watches: { label: "Vigilancias", hint: "Las que siguen activas" },
  lessons: { label: "Lecciones", hint: "Lo que recuerda de otras revisiones" },
  decisions: { label: "Decisiones recientes", hint: "Sus últimas decisiones" },
  reviewed: {
    label: "Decisión revisada",
    hint: "La decisión que revisa, con su contexto",
  },
};

export const kindText: Record<UsageKind, string> = {
  decision: "Evaluación",
  review: "Revisión",
};

export const tokens = (n: number | null | undefined) => num(n, 0);

// Cifras cortas para el eje: 120 mil, 1,2 M.
export const compact = (n: number) =>
  new Intl.NumberFormat("es-ES", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);

export const share = (part: number, total: number) =>
  total > 0
    ? num((part / total) * 100, part / total < 0.1 ? 1 : 0) + " %"
    : "—";

export const plural = (n: number, one: string, many: string) =>
  `${num(n, 0)} ${n === 1 ? one : many}`;

// Día UTC en texto: "mar 16 sep".
export function utcDay(day: string, weekday = false) {
  return new Date(day + "T12:00:00Z").toLocaleDateString("es-ES", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(weekday ? { weekday: "long" } : {}),
  });
}

export const triggerOf = (u: UsageItem): TriggerKey => u.trigger ?? "unknown";

// Registro anterior al detalle: solo trae at y tokens.
export const isLegacy = (u: UsageItem) =>
  !u.kind && !u.trigger && !u.sections && !u.estimated && u.ok === undefined;

export function Swatch({ trigger }: { trigger: TriggerKey }) {
  return <i className={"us-swatch us-c-" + trigger} aria-hidden="true" />;
}

export function Status({ u }: { u: UsageItem }) {
  if (u.ok === false) return <span className="badge us-failed">Fallida</span>;
  if (u.ok === true) return <span className="badge us-ok">Correcta</span>;
  return <span className="muted">—</span>;
}
