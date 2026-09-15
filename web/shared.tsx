import React from "react";
import type { State } from "../src/domain";
export const money = (n: number | string | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(Number(n));
export const date = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleString("es-ES", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
// Día y hora en la zona del navegador, que es la del propietario.
export const weekdayTime = (s: string) =>
  new Date(s).toLocaleString("es-ES", {
    weekday: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export const clockTime = (s: string) =>
  new Date(s).toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  });
// Cifra con coma decimal y sin moneda.
export const num = (n: number | null | undefined, decimals = 2) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : new Intl.NumberFormat("es-ES", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(n);
// El signo va siempre escrito: el color de una subida o bajada nunca va solo.
export const pct = (n: number | null | undefined, decimals = 2) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : (n > 0 ? "+" : n < 0 ? "−" : "") + num(Math.abs(n), decimals) + " %";
export const tone = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) || n === 0 ? "flat" : n > 0 ? "up" : "down";
// Mismo criterio que el worker: abierta solo si el calendario responde, dice que
// está abierta y aún no ha llegado su cierre.
export const marketOpen = (s: State) =>
  Boolean(
    s.market &&
    s.feeds?.clock &&
    s.market.open &&
    s.market.nextClose &&
    Date.parse(s.market.nextClose) > Date.now(),
  );
export const marketText = (s: State) => {
  const m = s.market;
  if (!m || !s.feeds?.clock) return "Calendario no disponible";
  if (marketOpen(s)) return "Abierta hasta el " + weekdayTime(m.nextClose!);
  return m.nextOpen
    ? "Cerrada · abre el " + weekdayTime(m.nextOpen)
    : "Cerrada";
};
export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <span>◇</span>
      <p>{children}</p>
    </div>
  );
}
