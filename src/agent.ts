import {
  id,
  now,
  log,
  enqueue,
  validWatch,
  watchState,
  orderGuard,
  type State,
  type Decision,
  type Quote,
  type proposalSchema,
} from "./domain.ts";
import type { z } from "zod";
import type { Analysis } from "./market.ts";
// Worker state transitions, kept free of I/O so they can be tested directly.
export type Job = {
  meta: NonNullable<State["modelJob"]>;
  state: State;
  due: Decision | null;
  event?: string;
};
export type Snapshot = {
  account: any;
  positions: any[];
  orders: any[];
  trades: { trades?: Record<string, any> } | null;
  clock: { is_open?: boolean } | null;
};
export const EQUITY_SAMPLE_MS = 300000,
  STREAM_SILENCE_MS = 120000;
export function applySnapshot(s: State, x: Snapshot, t = Date.now()) {
  s.account = x.account;
  s.positions = x.positions;
  s.orders = x.orders;
  s.lastSync = new Date(t).toISOString();
  if (s.baseline === null) s.baseline = Number(x.account.equity);
  for (const [symbol, trade] of Object.entries(x.trades?.trades ?? {}))
    if (trade?.p > 0) s.quotes[symbol] = { price: trade.p, at: trade.t };
  // Solo se avisa cuando cambia, porque esto se sincroniza cada 30 segundos.
  for (const [feed, ok, texto] of [
    [
      "trades",
      x.trades !== null,
      "Alpaca no devuelve precios. Sin precios recientes no se envían órdenes.",
    ],
    [
      "clock",
      x.clock !== null,
      "Alpaca no devuelve el calendario de mercado. Se asume cerrado y no se envían órdenes.",
    ],
  ] as const)
    if (s.feeds[feed] !== ok) {
      s.feeds[feed] = ok;
      log(
        s,
        ok ? "market" : "error",
        ok ? `Alpaca vuelve a responder: ${feed}` : texto,
      );
    }
  if (
    !s.equity.length ||
    t - Date.parse(s.equity.at(-1)!.at) > EQUITY_SAMPLE_MS
  )
    s.equity.push({
      at: new Date(t).toISOString(),
      value: Number(x.account.equity),
    });
  for (const d of s.decisions) {
    const o = x.orders.find((o) => o.client_order_id === d.id);
    if (o && d.status !== o.status) {
      d.status = o.status;
      d.orderId = o.id;
      log(s, "order", `${d.proposal.symbol}: ${o.status}`);
      if (o.status === "filled") enqueue(s, `Orden ejecutada: ${d.id}`);
    }
  }
}
export function applyMarket(
  s: State,
  quotes: Record<string, Quote>,
  connected: boolean,
  lastTick: number,
  t = Date.now(),
) {
  s.heartbeat = new Date(t).toISOString();
  s.stream =
    connected && t - lastTick < STREAM_SILENCE_MS
      ? "connected"
      : "disconnected";
  for (const [symbol, q] of Object.entries(quotes))
    if (
      s.settings.symbols.includes(symbol) &&
      (!s.quotes[symbol] || Date.parse(q.at) > Date.parse(s.quotes[symbol].at))
    )
      s.quotes[symbol] = q;
  for (const w of s.watches) {
    const next = watchState(w, s.paused ? undefined : s.quotes[w.symbol], t);
    if (next !== w.status) {
      w.status = next;
      log(s, "watch", `${w.symbol}: vigilancia ${next}`);
      if (next === "triggered") enqueue(s, `Vigilancia ${w.id}: ${w.reason}`);
    }
  }
}
// Picks the oldest saved intention and either blocks it or marks it as sending.
export function claimIntent(s: State, marketOpen: boolean, t = Date.now()) {
  const d = s.decisions.find((x) => x.status === "pending");
  if (!d) return null;
  const shadow = { ...s, decisions: s.decisions.filter((x) => x.id !== d.id) };
  const error = !marketOpen
    ? "Mercado cerrado"
    : orderGuard(shadow, d.proposal, t);
  if (error) {
    d.status = "blocked";
    d.error = error;
    return null;
  }
  d.status = "submitting";
  d.sentAt = new Date(t).toISOString();
  return structuredClone(d);
}
// Reserves the daily budget before any tokens are spent.
export function claimJob(s: State, ready: boolean, t = Date.now()): Job | null {
  if (s.modelJob) {
    log(
      s,
      "error",
      "Evaluación interrumpida recuperada. El intento ya cuenta para el límite diario.",
    );
    s.modelJob = null;
  }
  if (s.paused || !ready) return null;
  const day = new Date(t).toISOString().slice(0, 10);
  if (s.calls.day !== day) s.calls = { day, count: 0 };
  if (s.calls.count >= s.settings.maxDailyCalls) return null;
  if (
    s.lastDecision &&
    t - Date.parse(s.lastDecision) < s.settings.cooldownSeconds * 1000
  )
    return null;
  const due = s.decisions.find(
    (d) =>
      !d.review && (d.reviewAttempts ?? 0) < 3 && Date.parse(d.reviewAt) <= t,
  );
  const event = s.queue[0];
  if (!due && !event) return null;
  s.calls.count++;
  s.lastDecision = new Date(t).toISOString();
  if (due) due.reviewAttempts = (due.reviewAttempts ?? 0) + 1;
  else s.queue.shift();
  s.modelJob = {
    id: id(),
    startedAt: new Date(t).toISOString(),
    kind: due ? "review" : "decision",
    targetId: due?.id ?? event.id,
  };
  return {
    meta: s.modelJob,
    state: structuredClone(s),
    due: due ? structuredClone(due) : null,
    event: event?.reason,
  };
}
// Re-checks limits after the call, because settings may have changed meanwhile.
export function applyDecision(
  s: State,
  job: Job,
  result: {
    input: unknown;
    proposal: z.infer<typeof proposalSchema>;
    tokens: number;
  },
  marketOpen: boolean,
  t = Date.now(),
) {
  const p = result.proposal;
  const obsolete =
    s.activeVersion !== job.state.activeVersion ||
    JSON.stringify(s.settings) !== JSON.stringify(job.state.settings);
  let error: string | null = null;
  if (p.action !== "wait")
    error = obsolete
      ? "Configuración modificada durante la evaluación"
      : !marketOpen
        ? "Mercado cerrado"
        : orderGuard(s, p, t);
  const d: Decision = {
    id: id(),
    at: new Date(t).toISOString(),
    versionId: job.state.activeVersion,
    event: job.event!,
    input: result.input,
    proposal: p,
    status: p.action === "wait" ? "observed" : error ? "blocked" : "pending",
    error: error ?? undefined,
    reviewAt: new Date(t + p.reviewAfterHours * 3600000).toISOString(),
  };
  s.decisions.push(d);
  s.usage.push({ at: new Date(t).toISOString(), tokens: result.tokens });
  if (!obsolete && !s.paused)
    for (const w of p.watches)
      if (validWatch(w, s))
        s.watches.push({
          ...w,
          id: id(),
          status: "active",
          createdAt: new Date(t).toISOString(),
          decisionId: d.id,
        });
  for (const l of p.lessons)
    s.lessons.push({
      ...l,
      id: id(),
      status: "proposed",
      createdAt: new Date(t).toISOString(),
      decisionId: d.id,
    });
  s.modelJob = null;
  log(s, "decision", `${p.action}: ${p.reason.slice(0, 200)}`);
  return d;
}
export function applyReview(
  s: State,
  job: Job,
  parsed: {
    text: string;
    lessons: { title: string; body: string; source: string }[];
  },
  tokens: number,
  t = Date.now(),
) {
  const due = s.decisions.find((d) => d.id === job.due!.id);
  if (!due) {
    s.modelJob = null;
    return null;
  }
  due.review = {
    at: new Date(t).toISOString(),
    text: parsed.text,
    price: due.proposal.symbol
      ? (job.state.quotes[due.proposal.symbol]?.price ?? null)
      : null,
  };
  for (const l of parsed.lessons)
    s.lessons.push({
      ...l,
      id: id(),
      status: "proposed",
      createdAt: new Date(t).toISOString(),
      decisionId: due.id,
    });
  s.usage.push({ at: new Date(t).toISOString(), tokens });
  s.modelJob = null;
  log(s, "review", `Revisión completada: ${due.id}`);
  return due;
}

// El analisis se recalcula cada pocos minutos y solo se guarda si cambia algo.
export function applyAnalysis(
  s: State,
  fresh: Record<string, Analysis>,
  t = Date.now(),
) {
  const before = JSON.stringify(s.analysis);
  const kept: Record<string, Analysis> = {};
  for (const symbol of s.settings.symbols) {
    const next = fresh[symbol] ?? s.analysis[symbol];
    if (next) kept[symbol] = next;
  }
  s.analysis = kept;
  if (before !== JSON.stringify(s.analysis)) {
    const discarded = Object.values(fresh).reduce(
      (a, x) => a + x.barsDiscarded,
      0,
    );
    if (discarded)
      log(
        s,
        "market",
        `Analisis actualizado. Se descartaron ${discarded} velas con datos imposibles.`,
      );
  }
  void t;
}
