// Análisis técnico a partir de velas diarias. Sin entrada ni salida: se calcula
// sobre lo que le llega, para poder probarlo sin red ni base de datos.
import { newYorkDate } from "./clock.ts";
export type Bar = {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};
export type Indicators = {
  price: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  distanceToSma20Pct: number | null;
  distanceToSma50Pct: number | null;
  changePct1d: number | null;
  changePct5d: number | null;
  changePct20d: number | null;
  atr14: number | null;
  atr14Pct: number | null;
  high52w: number | null;
  low52w: number | null;
  positionIn52wRangePct: number | null;
  volumeRatio20: number | null;
};
export type Today = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  prevClose: number | null;
  changePct: number | null;
};
export type Session = Today & { date: string };
export type Analysis = {
  at: string;
  bars: Bar[];
  // La sesión de hoy, solo mientras está abierta. Fuera de ella es null.
  today: Session | null;
  // La última sesión completa. Con la bolsa cerrada es la única que hay.
  lastSession?: Session | null;
  indicators: Indicators | null;
  barsUsed: number;
  barsDiscarded: number;
  source: string;
};
export const BARS_KEPT = 20,
  DAYS_52W = 252;
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
// Alpaca devuelve de vez en cuando una vela con un extremo mal escalado: el
// 2026-02-02 SPY figuraba con un mínimo de 69 en lugar de 690. Sin filtrarlo, el
// mínimo de 52 semanas queda destrozado y el agente razona sobre un dato falso.
export function usableBar(raw: unknown): Bar | null {
  const b = raw as Record<string, unknown>;
  const o = num(b?.o),
    h = num(b?.h),
    l = num(b?.l),
    c = num(b?.c),
    v = num(b?.v),
    t = typeof b?.t === "string" ? b.t : null;
  if (o === null || h === null || l === null || c === null || v === null || !t)
    return null;
  if (!Number.isFinite(Date.parse(t))) return null;
  if (o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0) return null;
  // Coherencia interna: el máximo no puede quedar por debajo de la apertura o
  // del cierre, y el mínimo no puede quedar por encima de ninguno de los dos.
  if (h < Math.max(o, c) || l > Math.min(o, c)) return null;
  // Ninguna acción ni ETF recorre la mitad de su precio dentro de una sesión.
  // Un extremo así es un error de datos, no un movimiento de mercado.
  if (l < c * 0.5 || h > c * 2) return null;
  return { t, o, h, l, c, v };
}
export function cleanBars(raw: unknown[]): {
  bars: Bar[];
  discarded: number;
} {
  const bars: Bar[] = [];
  let discarded = 0;
  for (const x of raw ?? []) {
    const b = usableBar(x);
    if (b) bars.push(b);
    else discarded++;
  }
  bars.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return { bars, discarded };
}
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const round = (v: number | null, decimals = 2) =>
  v === null || !Number.isFinite(v)
    ? null
    : Math.round(v * 10 ** decimals) / 10 ** decimals;
const sma = (bars: Bar[], n: number) =>
  bars.length < n ? null : mean(bars.slice(-n).map((b) => b.c));
const changePct = (bars: Bar[], back: number) => {
  if (bars.length < back + 1) return null;
  const from = bars.at(-1 - back)!.c,
    to = bars.at(-1)!.c;
  return from > 0 ? (to / from - 1) * 100 : null;
};
// Rango verdadero medio: mide cuánto se mueve el activo en un día normal,
// contando los huecos entre el cierre de un día y la apertura del siguiente.
export function atr(bars: Bar[], n = 14) {
  if (bars.length < n + 1) return null;
  const trs: number[] = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i],
      prev = bars[i - 1];
    trs.push(
      Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)),
    );
  }
  return mean(trs);
}
export function indicators(bars: Bar[], price: number): Indicators | null {
  if (!bars.length || !Number.isFinite(price) || price <= 0) return null;
  const window = bars.slice(-DAYS_52W);
  const high52w = Math.max(...window.map((b) => b.h));
  const low52w = Math.min(...window.map((b) => b.l));
  const range = high52w - low52w;
  const s20 = sma(bars, 20),
    s50 = sma(bars, 50),
    a14 = atr(bars, 14);
  const volumes = bars.slice(-21, -1).map((b) => b.v);
  const avgVolume = volumes.length === 20 ? mean(volumes) : null;
  return {
    price: round(price, 4)!,
    sma20: round(s20),
    sma50: round(s50),
    sma200: round(sma(bars, 200)),
    distanceToSma20Pct: s20 ? round((price / s20 - 1) * 100) : null,
    distanceToSma50Pct: s50 ? round((price / s50 - 1) * 100) : null,
    changePct1d: round(changePct(bars, 1)),
    changePct5d: round(changePct(bars, 5)),
    changePct20d: round(changePct(bars, 20)),
    atr14: round(a14),
    atr14Pct: a14 ? round((a14 / price) * 100) : null,
    high52w: round(high52w),
    low52w: round(low52w),
    positionIn52wRangePct:
      range > 0 ? round(((price - low52w) / range) * 100) : null,
    volumeRatio20:
      avgVolume && avgVolume > 0 && bars.at(-1)
        ? round(bars.at(-1)!.v / avgVolume)
        : null,
  };
}
export function todayFrom(bars: Bar[]): Today | null {
  const last = bars.at(-1);
  if (!last) return null;
  const prev = bars.at(-2) ?? null;
  return {
    open: last.o,
    high: last.h,
    low: last.l,
    close: last.c,
    volume: last.v,
    prevClose: prev?.c ?? null,
    changePct: prev && prev.c > 0 ? round((last.c / prev.c - 1) * 100) : null,
  };
}
const withDate = (bars: Bar[]): Session | null => {
  const x = todayFrom(bars);
  return x ? { ...x, date: newYorkDate(bars.at(-1)!.t) } : null;
};
// Situación de la sesión al calcular: si está abierta, si la de hoy ya empezó y
// qué día es hoy en Nueva York.
export type SessionState = { open: boolean; started: boolean; today: string };
export function analyse(
  raw: unknown[],
  price: number,
  source: string,
  at = new Date().toISOString(),
  session: SessionState = {
    open: false,
    started: true,
    today: newYorkDate(at),
  },
): Analysis {
  const { bars: all, discarded } = cleanBars(raw);
  const last = all.at(-1);
  const lastIsToday =
    last !== undefined && newYorkDate(last.t) === session.today;
  // Antes de la apertura, una vela con la fecha de hoy solo trae operaciones
  // previas a la sesión. Presentarla como un día de mercado confunde al agente.
  const bars = lastIsToday && !session.started ? all.slice(0, -1) : all;
  const partial = lastIsToday && session.open;
  const completed = partial ? bars.slice(0, -1) : bars;
  const ind = indicators(bars, price);
  // A media sesión el volumen acumulado siempre parece bajo frente a días
  // enteros. Se compara la última sesión completa.
  if (ind && partial)
    ind.volumeRatio20 = indicators(completed, price)?.volumeRatio20 ?? null;
  return {
    at,
    bars: bars.slice(-BARS_KEPT),
    today: partial ? withDate(bars) : null,
    lastSession: withDate(completed),
    indicators: ind,
    barsUsed: bars.length,
    barsDiscarded: discarded,
    source,
  };
}
