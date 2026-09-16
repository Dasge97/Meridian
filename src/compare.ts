// Comparación de las simulaciones: curvas de patrimonio alineadas, operaciones,
// decisiones y consumo del modelo en un mismo periodo. Sin entrada ni salida y
// solo con importaciones de tipos, para que el panel lo use sin arrastrar zod.
import type { Decision, Usage } from "./domain.ts";
import type { ComparisonStart, Fill } from "./paper.ts";

export type EquityPoint = { at: string; value: number };
// Un instante del periodo se da como ISO o en milisegundos. null, o una fecha que
// no se entiende, es sin límite: la API valida antes lo que le llega.
export type Instant = string | number | null | undefined;

// Curvas alineadas por columnas: at[i] es la marca de values[sim][i] e
// indexed[sim][i]. null es que esa curva aún no tenía ningún valor.
export type AlignedCurves<K extends string> = {
  at: string[];
  values: Record<K, (number | null)[]>;
  // Índice 100 sobre base[sim], el primer valor de cada curva en el periodo.
  indexed: Record<K, (number | null)[]>;
  base: Record<K, number | null>;
};

export type TradeStats = {
  // Órdenes ejecutadas del agente en el periodo, sin las manuales.
  orders: number;
  buys: number;
  sells: number;
  // Ventas cuyo coste medio se conoce: sin él no hay resultado que medir.
  pricedSells: number;
  winningSells: number;
  // winningSells / pricedSells, de 0 a 1. null sin ventas con coste conocido.
  winRate: number | null;
  realizedPl: number;
  largestGain: SellResult | null;
  largestLoss: SellResult | null;
  // Ventas de más acciones de las que había en el libro reconstruido.
  unpricedSells: number;
  // Las manuales mueven el libro, así que cuentan para el coste medio, pero se
  // dan aparte: no las decidió el agente.
  manual: { orders: number; buys: number; sells: number; realizedPl: number };
  // Ejecuciones descartadas: datos no válidos, repetidas o anteriores al inicio.
  ignored: number;
};
export type SellResult = {
  orderId: string;
  symbol: string;
  at: string;
  qty: number;
  price: number;
  avgPrice: number;
  realizedPl: number;
};

export type TokenStats = {
  calls: number;
  failed: number;
  tokens: number;
  avgPerCall: number;
  // Tokens entre los días transcurridos del periodo, con un mínimo de un día.
  avgPerDay: number;
  days: number;
};

export type DecisionStats = {
  decisions: number;
  waits: number;
  blocked: number;
  // Las que llegaron a enviar una orden, a Alpaca o a la simulación interna.
  sent: number;
};

// Lo que el servidor saca de cada simulación para compararla.
export type SimInput = {
  label: string;
  riskProfile: string;
  equity: EquityPoint[];
  fills: Fill[];
  comparison: ComparisonStart | null;
  usage: Usage[];
  decisions: DecisionLike[];
  account: { equity?: unknown; cash?: unknown } | null;
};
export type DecisionLike = Pick<
  Decision,
  "at" | "status" | "orderId" | "sentAt"
> & { proposal: Pick<Decision["proposal"], "action"> };

// Respuesta de GET /api/compare. Las claves de sims, bySim y series.values son
// los identificadores de simulación ("alpaca", "internal"), en el orden de la
// entrada.
export type CompareResult<K extends string = string> = {
  // El inicio efectivo del periodo, en ISO. null es sin límite.
  from: string | null;
  sims: K[];
  series: AlignedCurves<K>;
  bySim: Record<K, SimComparison>;
};
export type SimComparison = {
  label: string;
  riskProfile: string;
  // Cuándo empezó la comparación de esta simulación, si se sabe.
  startedAt: string | null;
  result: {
    // Patrimonio al empezar el periodo y ahora. null si no se conoce.
    equityStart: number | null;
    equityNow: number | null;
    usd: number | null;
    pct: number | null;
    // Realizado del periodo, del agente y manual.
    realizedPl: number;
    // Lo demás: usd menos lo realizado. Es sobre todo la variación de lo no
    // realizado. null si no hay usd.
    unrealizedPl: number | null;
  };
  trades: TradeStats;
  decisions: DecisionStats;
  tokens: TokenStats;
};

const DAY_MS = 86400000;
const r2 = (x: number) => Math.round(x * 100) / 100;
// Las mismas cuentas que paper.ts: precios de hasta 4 decimales.
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const iso = (t: number) => new Date(t).toISOString();
const timeOf = (v: Instant, empty: number) => {
  const t = typeof v === "number" ? v : v == null ? NaN : Date.parse(v);
  return Number.isFinite(t) ? t : empty;
};
// Alpaca da los importes como texto: "101.5" vale, "" o null no.
const num = (v: unknown) =>
  typeof v === "number" || (typeof v === "string" && v.trim())
    ? Number(v)
    : NaN;
const parseAt = (at: unknown) =>
  typeof at === "string" ? Date.parse(at) : NaN;

// Alinea varias curvas en la unión de sus marcas desde from, cada una con su
// último valor conocido. Si alguna tenía valor antes de from, el periodo empieza
// con una marca en from, para que el índice parta justo de ahí. Los puntos con
// fecha o valor no válidos se descartan y el orden guardado no se da por bueno.
export function alignCurves<K extends string>(
  curves: Record<K, EquityPoint[]>,
  from: Instant,
  to?: Instant,
): AlignedCurves<K> {
  const keys = Object.keys(curves) as K[];
  const since = timeOf(from, -Infinity),
    until = timeOf(to, Infinity);
  const clean = {} as Record<K, { t: number; value: number }[]>;
  for (const k of keys)
    clean[k] = (Array.isArray(curves[k]) ? curves[k] : [])
      .map((p) => ({ t: parseAt(p?.at), value: p?.value }))
      .filter(
        (p): p is { t: number; value: number } =>
          Number.isFinite(p.t) && finite(p.value) && p.t <= until,
      )
      .sort((a, b) => a.t - b.t);
  const marks = new Set<number>();
  let antes = false;
  for (const k of keys)
    for (const p of clean[k])
      if (p.t >= since) marks.add(p.t);
      else antes = true;
  // Solo si hay datos dentro: un from posterior a todo da un periodo vacío.
  if (antes && marks.size) marks.add(since);
  const times = [...marks].sort((a, b) => a - b);
  const values = {} as AlignedCurves<K>["values"],
    indexed = {} as AlignedCurves<K>["indexed"],
    base = {} as AlignedCurves<K>["base"];
  for (const k of keys) {
    const list = clean[k];
    let i = 0,
      last: number | null = null;
    values[k] = times.map((t) => {
      // Con la misma marca repetida vale la última guardada.
      while (i < list.length && list[i].t <= t) last = list[i++].value;
      return last;
    });
    const first = values[k].find((v) => v !== null) ?? null;
    base[k] = first;
    indexed[k] = values[k].map((v) =>
      v === null || first === null || first <= 0 ? null : r4((v / first) * 100),
    );
  }
  return { at: times.map(iso), values, indexed, base };
}

// Dos curvas: la forma corta de alignCurves, con las claves a y b.
export function alignSeries(a: EquityPoint[], b: EquityPoint[], from: Instant) {
  return alignCurves({ a, b }, from);
}

// Reconstruye el libro desde start con coste medio y mide cada venta contra el
// precio medio de ese momento. Todas las ejecuciones mueven el libro, pero solo
// cuentan las del periodo [from, ...). Las anteriores a start.startedAt ya están
// dentro de start y se descartan. Sin start se parte de un libro vacío.
export function tradeStats(
  fills: Fill[],
  start: ComparisonStart | null,
  from?: Instant,
): TradeStats {
  const since = timeOf(from, -Infinity),
    startedAt = timeOf(start?.startedAt, -Infinity);
  const held = new Map<string, { qty: number; avgPrice: number }>();
  for (const x of start?.positions ?? [])
    if (finite(x?.qty) && x.qty > 0 && finite(x.avgPrice) && x.avgPrice > 0)
      held.set(x.symbol, { qty: x.qty, avgPrice: x.avgPrice });
  const stats: TradeStats = {
    orders: 0,
    buys: 0,
    sells: 0,
    pricedSells: 0,
    winningSells: 0,
    winRate: null,
    realizedPl: 0,
    largestGain: null,
    largestLoss: null,
    unpricedSells: 0,
    manual: { orders: 0, buys: 0, sells: 0, realizedPl: 0 },
    ignored: 0,
  };
  const seen = new Set<string>();
  const valid = (Array.isArray(fills) ? fills : [])
    .map((f, i) => ({ f, i, t: parseAt(f?.at) }))
    .filter(({ f, t }) => {
      const ok =
        Number.isFinite(t) &&
        t >= startedAt &&
        (f.side === "buy" || f.side === "sell") &&
        typeof f.symbol === "string" &&
        finite(f.qty) &&
        f.qty > 0 &&
        finite(f.price) &&
        f.price > 0;
      if (!ok) stats.ignored++;
      return ok;
    })
    .sort((a, b) => a.t - b.t || a.i - b.i);
  for (const { f, t } of valid) {
    // Una orden se apunta una sola vez: una repetida descuadraría el libro.
    if (f.orderId) {
      if (seen.has(f.orderId)) {
        stats.ignored++;
        continue;
      }
      seen.add(f.orderId);
    }
    const prev = held.get(f.symbol);
    const counts = t >= since;
    const bucket = f.manual ? stats.manual : stats;
    if (counts) {
      bucket.orders++;
      if (f.side === "buy") bucket.buys++;
      else bucket.sells++;
    }
    if (f.side === "buy") {
      const q0 = prev?.qty ?? 0,
        avg0 = prev?.avgPrice ?? 0;
      held.set(f.symbol, {
        qty: q0 + f.qty,
        avgPrice: r4((q0 * avg0 + f.qty * f.price) / (q0 + f.qty)),
      });
      continue;
    }
    if (!prev || prev.qty < f.qty) {
      // Sin cortos, vender más de lo que había es que falta historia: el libro
      // se queda a cero y la venta no tiene resultado medible.
      held.delete(f.symbol);
      if (counts && !f.manual) stats.unpricedSells++;
      continue;
    }
    const pl = r4((f.price - prev.avgPrice) * f.qty);
    if (prev.qty === f.qty) held.delete(f.symbol);
    else held.set(f.symbol, { qty: prev.qty - f.qty, avgPrice: prev.avgPrice });
    if (!counts) continue;
    bucket.realizedPl = r4(bucket.realizedPl + pl);
    if (f.manual) continue;
    stats.pricedSells++;
    const venta: SellResult = {
      orderId: f.orderId,
      symbol: f.symbol,
      at: f.at,
      qty: f.qty,
      price: f.price,
      avgPrice: prev.avgPrice,
      realizedPl: pl,
    };
    if (pl > 0) {
      stats.winningSells++;
      if (!stats.largestGain || pl > stats.largestGain.realizedPl)
        stats.largestGain = venta;
    } else if (
      pl < 0 &&
      (!stats.largestLoss || pl < stats.largestLoss.realizedPl)
    )
      stats.largestLoss = venta;
  }
  stats.winRate = stats.pricedSells
    ? r4(stats.winningSells / stats.pricedSells)
    : null;
  return stats;
}

// Consumo del modelo en [from, to]. to es ahora si no se da. Los registros
// antiguos solo traen at y tokens: cuentan como llamadas bien hechas.
export function tokenStats(
  usage: Usage[],
  from: Instant,
  to?: Instant,
  now = Date.now(),
): TokenStats {
  const since = timeOf(from, -Infinity),
    until = timeOf(to, now);
  let calls = 0,
    failed = 0,
    tokens = 0,
    first = Infinity;
  for (const u of Array.isArray(usage) ? usage : []) {
    const t = parseAt(u?.at);
    if (!Number.isFinite(t) || t < since || t > until) continue;
    calls++;
    if (u.ok === false) failed++;
    if (finite(u.tokens) && u.tokens > 0) tokens += u.tokens;
    first = Math.min(first, t);
  }
  // Sin inicio, el periodo empieza en la primera llamada.
  const start = Number.isFinite(since) ? since : first;
  const days = Number.isFinite(start)
    ? Math.max(1, (until - start) / DAY_MS)
    : 1;
  return {
    calls,
    failed,
    tokens,
    avgPerCall: calls ? Math.round(tokens / calls) : 0,
    avgPerDay: Math.round(tokens / days),
    days: r2(days),
  };
}

export function decisionStats(
  decisions: DecisionLike[],
  from: Instant,
): DecisionStats {
  const since = timeOf(from, -Infinity);
  const stats: DecisionStats = { decisions: 0, waits: 0, blocked: 0, sent: 0 };
  for (const d of Array.isArray(decisions) ? decisions : []) {
    const t = parseAt(d?.at);
    if (!Number.isFinite(t) || t < since) continue;
    stats.decisions++;
    if (d.proposal?.action === "wait") stats.waits++;
    if (d.status === "blocked") stats.blocked++;
    // sentAt lo pone claimIntent; las decisiones de antes de ese campo solo
    // traen orderId.
    if (d.sentAt || d.orderId) stats.sent++;
  }
  return stats;
}

// Todo lo de GET /api/compare. Sin from, el periodo empieza en el inicio de
// comparación más reciente: desde ahí existen todas las simulaciones.
export function compareSims<K extends string>(
  input: Record<K, SimInput>,
  from: Instant,
  now = Date.now(),
): CompareResult<K> {
  const sims = Object.keys(input) as K[];
  const inicios = sims
    .map((k) => timeOf(input[k].comparison?.startedAt, NaN))
    .filter(Number.isFinite);
  const since = timeOf(from, inicios.length ? Math.max(...inicios) : NaN);
  const desde = Number.isFinite(since) ? since : null;
  const series = alignCurves(
    Object.fromEntries(sims.map((k) => [k, input[k].equity])) as Record<
      K,
      EquityPoint[]
    >,
    desde,
    now,
  );
  const bySim = {} as Record<K, SimComparison>;
  for (const k of sims) {
    const x = input[k];
    const trades = tradeStats(x.fills, x.comparison, desde);
    const last = series.values[k].findLast((v) => v !== null) ?? null;
    const cuenta = num(x.account?.equity);
    // La cuenta es más reciente que la última muestra de la curva. Con from en
    // el futuro no hay periodo, y tampoco resultado.
    const equityNow =
      desde !== null && desde > now
        ? null
        : Number.isFinite(cuenta)
          ? cuenta
          : last;
    const equityStart = series.base[k];
    const usd =
      equityStart !== null && equityNow !== null
        ? r2(equityNow - equityStart)
        : null;
    const realizedPl = r2(trades.realizedPl + trades.manual.realizedPl);
    bySim[k] = {
      label: x.label,
      riskProfile: x.riskProfile,
      startedAt: x.comparison?.startedAt ?? null,
      result: {
        equityStart,
        equityNow,
        usd,
        pct: usd !== null && equityStart ? r4((usd / equityStart) * 100) : null,
        realizedPl,
        unrealizedPl: usd === null ? null : r2(usd - realizedPl),
      },
      trades,
      decisions: decisionStats(x.decisions, desde),
      tokens: tokenStats(x.usage, desde, now, now),
    };
  }
  return {
    from: desde === null ? null : iso(desde),
    sims,
    series,
    bySim,
  };
}
