// Piezas de la vista Vigilancias que no dependen de su estado: formatos,
// cálculo de distancias y la regleta con nivel e invalidaciones.
import React from "react";
import type { Watch } from "../../src/domain";
import type { Data } from "./types";
import { num, pct } from "../shared";

export type Operator = Watch["operator"];
export const sign = (op: Operator) => (op === "lte" ? "≤" : "≥");
// El worker descarta precios con más de 90 segundos.
export const FRESH_MS = 90000;

export function remaining(ms: number) {
  if (ms <= 0) return "0 min";
  const d = Math.floor(ms / 86400000),
    h = Math.floor((ms % 86400000) / 3600000),
    m = Math.floor((ms % 3600000) / 60000);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${Math.max(1, m)} min`;
}

// Precio con el que se evalúa: el último trade. Si no hay, el último cierre.
export function priceFor(s: Data, symbol: string) {
  const q = s.quotes[symbol];
  if (q) return { price: q.price, at: q.at, live: true };
  const i = s.analysis[symbol]?.indicators;
  return i
    ? { price: i.price, at: s.analysis[symbol].at, live: false }
    : { price: null, at: null, live: false };
}

export function distance(s: Data, symbol: string, level: number) {
  const { price } = priceFor(s, symbol),
    atr = s.analysis[symbol]?.indicators?.atr14 ?? null;
  if (!price || !(level > 0)) return null;
  return {
    pct: (level / price - 1) * 100,
    atr: atr ? Math.abs(level - price) / atr : null,
  };
}

export function distanceText(d: ReturnType<typeof distance>) {
  if (!d) return null;
  return (
    `${pct(d.pct)} hasta el nivel` +
    (d.atr === null
      ? ""
      : ` · ${num(d.atr, 1)} ${d.atr >= 0.95 && d.atr < 1.05 ? "movimiento diario habitual" : "movimientos diarios habituales"}`)
  );
}

// Qué pasaría con este precio. Mismo orden que watchState: primero invalida.
export function outcome(
  op: Operator,
  level: number,
  below: number | null,
  above: number | null,
  price: number | null,
): "waiting" | "triggered" | "invalidated" | "unknown" {
  if (!price || !(level > 0)) return "unknown";
  if ((below !== null && price <= below) || (above !== null && price >= above))
    return "invalidated";
  return (op === "lte" ? price <= level : price >= level)
    ? "triggered"
    : "waiting";
}

export function WatchRuler(p: {
  operator: Operator;
  level: number;
  price: number | null;
  below: number | null;
  above: number | null;
}) {
  const values = [p.price, p.level, p.below, p.above].filter(
    (v): v is number => v !== null && v > 0,
  );
  const min = Math.min(...values),
    max = Math.max(...values),
    pad = Math.max((max - min) * 0.18, max * 0.004),
    lo = min - pad,
    hi = max + pad,
    at = (v: number) =>
      Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100)) + "%";
  const label =
    `Nivel de activación ${num(p.level)}` +
    (p.price ? `, precio actual ${num(p.price)}` : "") +
    (p.below !== null ? `, se invalida por debajo de ${num(p.below)}` : "") +
    (p.above !== null ? `, se invalida por encima de ${num(p.above)}` : "");
  return (
    <div className="wt-ruler-wrap">
      <div className="wt-ruler" role="img" aria-label={label}>
        <div className="wt-track">
          <span
            className="wt-zone hit"
            style={
              p.operator === "lte"
                ? { left: 0, width: at(p.level) }
                : { left: at(p.level), right: 0 }
            }
          />
          {p.below !== null && (
            <span
              className="wt-zone bad"
              style={{ left: 0, width: at(p.below) }}
            />
          )}
          {p.above !== null && (
            <span
              className="wt-zone bad"
              style={{ left: at(p.above), right: 0 }}
            />
          )}
        </div>
        {p.below !== null && (
          <span className="wt-mark stop" style={{ left: at(p.below) }} />
        )}
        {p.above !== null && (
          <span className="wt-mark stop" style={{ left: at(p.above) }} />
        )}
        <span className="wt-mark level" style={{ left: at(p.level) }} />
        {p.price !== null && (
          <span className="wt-mark price" style={{ left: at(p.price) }} />
        )}
      </div>
      <div className="wt-legend num" aria-hidden="true">
        {p.price !== null && (
          <span>
            <i className="wt-k price" />
            precio {num(p.price)}
          </span>
        )}
        <span>
          <i className="wt-k level" />
          activa {num(p.level)}
        </span>
        {p.below !== null && (
          <span>
            <i className="wt-k stop" />
            invalida ≤ {num(p.below)}
          </span>
        )}
        {p.above !== null && (
          <span>
            <i className="wt-k stop" />
            invalida ≥ {num(p.above)}
          </span>
        )}
      </div>
    </div>
  );
}
