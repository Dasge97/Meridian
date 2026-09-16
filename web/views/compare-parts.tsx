// Piezas de la vista Comparar: tipos de la respuesta, identidad de cada
// simulación (color y trazo) y formatos de cifras.
import React from "react";
import type { CompareResult, SimComparison } from "../../src/compare";
import { RISK_PROFILES } from "../../src/risk";
import { isSimId, type SimId } from "../../src/sims";
import { money, num } from "../shared";

// Respuesta de GET /api/compare.
export type CompareResponse = CompareResult<SimId>;
export type { SimComparison };

// Color y trazo fijos por simulación, no por posición: si una falta, la otra
// conserva los suyos. Los colores son los del selector de la cabecera. La
// segunda va a trazos para no depender solo del color.
type Identity = {
  color: "--sim-alpaca" | "--sim-internal" | "--series" | "--series-2";
  dashed: boolean;
};
const IDENTITY: Record<SimId, Identity> = {
  alpaca: { color: "--sim-alpaca", dashed: false },
  internal: { color: "--sim-internal", dashed: true },
};
export function identity(id: string, index: number): Identity {
  return (
    (isSimId(id) ? IDENTITY[id] : undefined) ??
    (index % 2
      ? { color: "--series-2" as const, dashed: true }
      : { color: "--series" as const, dashed: false })
  );
}

export const riskLabel = (key: string) =>
  Object.hasOwn(RISK_PROFILES, key)
    ? RISK_PROFILES[key as keyof typeof RISK_PROFILES].label
    : key || "Sin nivel";

// Importe con signo escrito: el color nunca va solo.
export const signedMoney = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : (n > 0 ? "+" : "") + money(n);
export const whole = (n: number | null | undefined) => num(n, 0);
export const share = (part: number, total: number) =>
  total > 0 ? num((part / total) * 100, 0) + " %" : "—";

// Tokens por orden ejecutada del agente. null sin órdenes.
export const tokensPerOrder = (x: SimComparison) =>
  x.trades.orders > 0 ? Math.round(x.tokens.tokens / x.trades.orders) : null;

// Quién va por delante por resultado en USD. null si falta alguno.
export function leaderOf(d: CompareResponse) {
  const rows = d.sims
    .map((id) => ({ id, usd: d.bySim[id]?.result.usd ?? null }))
    .filter((x): x is { id: SimId; usd: number } => x.usd !== null);
  if (rows.length < 2 || rows.length !== d.sims.length) return null;
  rows.sort((a, b) => b.usd - a.usd);
  const gap = Math.round((rows[0].usd - rows[1].usd) * 100) / 100;
  return { id: gap === 0 ? null : rows[0].id, runnerUp: rows[1].id, gap };
}

// Muestra de la línea de cada simulación, igual que en la gráfica.
export function SimKey({ id, index }: { id: string; index: number }) {
  const x = identity(id, index);
  return (
    <i
      className={"cmp-key" + (x.dashed ? " dashed" : "")}
      style={{ "--cmp-color": `var(${x.color})` } as React.CSSProperties}
      aria-hidden="true"
    />
  );
}
