import {
  id,
  log,
  logShared,
  enqueue,
  validWatch,
  watchState,
  orderGuard,
  EVENT_ATTEMPTS,
  REVIEW_ATTEMPTS,
  USAGE_EVENT_CHARS,
  USAGE_ERROR_CHARS,
  adoptLessons,
  proposalIntent,
  riskProfileOf,
  tradeName,
  comparisonStart,
  type State,
  type Usage,
  type Decision,
  type Fill,
  type Quote,
  type UsageTrigger,
  type proposalSchema,
} from "./domain.ts";
import type { SharedState } from "./sim-state.ts";
import type { SimId } from "./sims.ts";
import type { z } from "zod";
import type { Analysis, Intraday } from "./market.ts";
import type { Spent } from "./model.ts";
import { mergeStories, summarise, pendingRefs, type Story } from "./news.ts";
import {
  sessionOpen,
  newYorkMinutes,
  PRE_OPEN_MINUTES,
  SESSION_OPEN_MINUTE,
} from "./clock.ts";
// Worker state transitions, kept free of I/O so they can be tested directly.
export type Job = {
  meta: NonNullable<State["modelJob"]>;
  state: State;
  due: Decision | null;
  event?: string;
  // El evento tal como estaba en la cola, para devolverlo si la evaluación falla.
  queued?: State["queue"][number];
};
// Lo que se pide a Alpaca cada 30 segundos, en dos partes. El calendario y los
// últimos precios son compartidos; la cuenta, las posiciones y las órdenes son de
// la simulación de Alpaca. Separadas, una cuenta lenta no retrasa el calendario.
export type MarketSnapshot = {
  trades: { trades?: Record<string, any> } | null;
  clock: {
    is_open?: boolean;
    next_open?: string;
    next_close?: string;
  } | null;
};
export type AccountSnapshot = {
  account: any;
  positions: any[];
  orders: any[];
};
export const EQUITY_SAMPLE_MS = 300000,
  STREAM_SILENCE_MS = 120000;
const iso = (t: number) => new Date(t).toISOString();
// Un precio solo sustituye al guardado si es más reciente. La sincronización de
// cada 30 segundos trae el último trade de /trades/latest, que puede ser anterior
// al que ya llegó por el WebSocket: antes lo pisaba y el precio retrocedía.
function newerQuote(at: unknown, saved: Quote | undefined) {
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return false;
  return !saved || !(Date.parse(saved.at) >= t);
}
export function applyMarketSnapshot(
  sh: SharedState,
  x: MarketSnapshot,
  t = Date.now(),
) {
  sh.marketSync = iso(t);
  // El agente necesita saber si el mercado está abierto: si no, proponer una
  // compra es tirar una evaluación, porque los límites la bloquean después.
  if (x.clock)
    sh.market = {
      open: Boolean(x.clock.is_open),
      nextOpen: x.clock.next_open ?? null,
      nextClose: x.clock.next_close ?? null,
    };
  for (const [symbol, trade] of Object.entries(x.trades?.trades ?? {}))
    if (
      sh.settings.symbols.includes(symbol) &&
      Number.isFinite(trade?.p) &&
      trade.p > 0 &&
      newerQuote(trade.t, sh.quotes[symbol])
    )
      sh.quotes[symbol] = { price: trade.p, at: trade.t };
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
    if (sh.feeds[feed] !== ok) {
      sh.feeds[feed] = ok;
      logShared(
        sh,
        ok ? "market" : "error",
        ok ? `Alpaca vuelve a responder: ${feed}` : texto,
      );
    }
}
// Una muestra de patrimonio cada EQUITY_SAMPLE_MS como mucho.
export function sampleEquity(
  s: Pick<State, "equity">,
  value: number,
  t = Date.now(),
) {
  if (
    !s.equity.length ||
    t - Date.parse(s.equity.at(-1)!.at) > EQUITY_SAMPLE_MS
  )
    s.equity.push({ at: iso(t), value });
}
// La decisión sigue a su orden, y una venta ejecutada despierta al agente porque
// libera dinero. Una compra ejecutada no: sus vigilancias ya quedaron puestas al
// decidirla. El 16/09/2026 despertar con cada compra hizo que el nivel Agresivo
// comprara una vez cada 2 minutos, frenado solo por cooldownSeconds. Vale para
// las órdenes de Alpaca y para las de la simulación interna.
export function reconcileDecisions(s: State, orders: any[]) {
  for (const d of s.decisions) {
    const o = orders.find((o) => o.client_order_id === d.id);
    if (o && d.status !== o.status) {
      d.status = o.status;
      d.orderId = o.id;
      log(s, "order", `${d.proposal.symbol}: ${o.status}`);
      if (o.status === "filled" && d.proposal.action === "sell")
        enqueue(s, `Orden ejecutada: ${d.id}`, "other");
    }
  }
}
const TERMINAL_ORDERS = [
  "filled",
  "canceled",
  "expired",
  "replaced",
  "done_for_day",
  "stopped",
  "rejected",
];
// Apunta en fills las órdenes de Alpaca ya terminadas con algo ejecutado, una
// vez cada una. Una orden que no es de ninguna decisión la puso el propietario a
// mano en la misma cuenta. Devuelve cuántas añadió.
export function recordAlpacaFills(
  s: Pick<State, "fills" | "decisions">,
  orders: any[],
  t = Date.now(),
) {
  const known = new Set(s.fills.map((f) => f.orderId));
  const decided = new Set(s.decisions.map((d) => d.id));
  const nuevas: Fill[] = [];
  for (const o of orders ?? []) {
    const qty = Number(o?.filled_qty),
      price = Number(o?.filled_avg_price);
    if (
      !o?.id ||
      known.has(String(o.id)) ||
      !TERMINAL_ORDERS.includes(o.status) ||
      !(qty > 0) ||
      !(price > 0) ||
      (o.side !== "buy" && o.side !== "sell")
    )
      continue;
    known.add(String(o.id));
    const f: Fill = {
      orderId: String(o.id),
      symbol: String(o.symbol),
      side: o.side,
      qty,
      price,
      at: o.filled_at ?? o.updated_at ?? iso(t),
      realizedPl: 0,
      rule: "alpaca",
    };
    if (decided.has(o.client_order_id)) f.decisionId = o.client_order_id;
    else f.manual = true;
    nuevas.push(f);
  }
  nuevas.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  s.fills.push(...nuevas);
  return nuevas.length;
}
// La cuenta de Alpaca, sincronizada cada 30 segundos.
export function applyAccount(s: State, x: AccountSnapshot, t = Date.now()) {
  s.account = x.account;
  s.positions = x.positions;
  s.orders = x.orders;
  s.lastSync = iso(t);
  if (s.baseline === null) s.baseline = Number(x.account.equity);
  // Una instalación nueva no tenía cuenta al migrar: la comparación empieza en la
  // primera sincronización.
  if (s.comparison === null && Number.isFinite(Number(x.account.equity)))
    s.comparison = comparisonStart(s, t);
  sampleEquity(s, Number(x.account.equity), t);
  recordAlpacaFills(s, x.orders, t);
  reconcileDecisions(s, x.orders);
}
// Latido, estado del WebSocket y precios recibidos. Compartido: los precios son
// los mismos para todas las simulaciones.
export function applyQuotes(
  sh: SharedState,
  quotes: Record<string, Quote>,
  connected: boolean,
  lastTick: number,
  t = Date.now(),
) {
  sh.heartbeat = iso(t);
  sh.stream =
    connected && t - lastTick < STREAM_SILENCE_MS
      ? "connected"
      : "disconnected";
  for (const [symbol, q] of Object.entries(quotes))
    if (
      sh.settings.symbols.includes(symbol) &&
      newerQuote(q.at, sh.quotes[symbol])
    )
      sh.quotes[symbol] = q;
  // Al quitar un activo de la lista su último precio deja de actualizarse. Si se
  // queda guardado, el agente lo sigue viendo en su contexto cada vez más viejo.
  for (const symbol of Object.keys(sh.quotes))
    if (!sh.settings.symbols.includes(symbol)) delete sh.quotes[symbol];
}
// Las vigilancias de una simulación con los precios compartidos.
export function applyWatches(s: State, t = Date.now()) {
  // IEX también da operaciones antes de la apertura y después del cierre. Una
  // vigilancia se activa una sola vez: si lo hiciera a esa hora, el agente no
  // podría operar y la condición se perdería.
  const vigilar = !s.paused && sessionOpen(s, t);
  for (const w of s.watches) {
    const next = watchState(w, vigilar ? s.quotes[w.symbol] : undefined, t);
    if (next !== w.status) {
      w.status = next;
      log(s, "watch", `${w.symbol}: vigilancia ${next}`);
      if (next === "triggered")
        enqueue(s, `Vigilancia ${w.id}: ${w.reason}`, "watch");
    }
  }
}
// Picks the oldest saved intention and either blocks it or marks it as sending.
export function claimIntent(s: State, marketOpen: boolean, t = Date.now()) {
  const d = s.decisions.find((x) => x.status === "pending");
  if (!d) return null;
  const shadow = { ...s, decisions: s.decisions.filter((x) => x.id !== d.id) };
  // Entre la decisión y el envío puede ejecutarse otra orden. Si una venta pide
  // más acciones de las que quedan, orderGuard la bloquea. Si pasa, se anota la
  // intención con las posiciones de ahora, que es lo que se envía.
  const error = !marketOpen
    ? "Mercado cerrado"
    : orderGuard(shadow, d.proposal, t);
  if (error) {
    d.status = "blocked";
    d.error = error;
    return null;
  }
  const ahora = proposalIntent(s, d.proposal);
  if (ahora) d.intent = ahora;
  d.status = "submitting";
  d.sentAt = new Date(t).toISOString();
  return structuredClone(d);
}
// Con MODEL_CONCURRENCY=1 el proveedor atiende una llamada a la vez y el worker
// elige qué simulación va primero. Cada candidata trae el origen del primer
// evento de su cola, o "review" si no tiene cola y solo podría tener revisiones
// vencidas, que viven en la fila fría y no se ven desde aquí.
export type SimCandidate = {
  sim: SimId;
  trigger: UsageTrigger | undefined;
  queuedAt: string | null;
};
// Primero lo que no puede esperar: una vigilancia cumplida o una orden
// ejecutada. Después lo que pide el propietario, las noticias, la revisión
// periódica y, al final, las revisiones de operaciones.
export const SIM_PRIORITY: Record<UsageTrigger, number> = {
  watch: 0,
  other: 0,
  manual: 1,
  news: 2,
  preopen: 2,
  periodic: 3,
  review: 4,
};
// La simulación que va ahora, o null si no hay candidatas. En empate va la que
// no se atendió la última vez, para que se turnen; si aún empatan, la que lleva
// más tiempo esperando.
export function pickSim(
  candidates: SimCandidate[],
  lastServed: SimId | null,
): SimId | null {
  const prioridad = (c: SimCandidate) =>
    SIM_PRIORITY[c.trigger ?? "other"] ?? SIM_PRIORITY.other;
  const espera = (c: SimCandidate) => {
    const t = c.queuedAt ? Date.parse(c.queuedAt) : NaN;
    return Number.isFinite(t) ? t : Infinity;
  };
  const ordenadas = candidates
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        prioridad(a.c) - prioridad(b.c) ||
        Number(a.c.sim === lastServed) - Number(b.c.sim === lastServed) ||
        espera(a.c) - espera(b.c) ||
        a.i - b.i,
    );
  return ordenadas[0]?.c.sim ?? null;
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
  // Solo se revisa lo que llegó a enviar una orden: el agente aprende de
  // resultados reales. Revisar esperas gastaba llamadas y producía lecciones de
  // prudencia que acababan frenándolo.
  for (const d of s.decisions)
    if (
      !d.orderId &&
      !d.review &&
      !d.reviewSkipped &&
      Date.parse(d.reviewAt) <= t
    )
      d.reviewSkipped =
        d.proposal.action === "wait"
          ? "Las esperas no se revisan: el agente aprende de operaciones reales."
          : "No llegó a enviarse ninguna orden, así que no hay resultado que revisar.";
  // Los eventos van antes que las revisiones. Una vigilancia cumplida en la
  // apertura no puede esperar detrás de revisiones atrasadas.
  const event = s.queue[0];
  const due = event
    ? undefined
    : s.decisions.find(
        (d) =>
          !d.review &&
          !d.reviewSkipped &&
          (d.reviewAttempts ?? 0) < REVIEW_ATTEMPTS &&
          Date.parse(d.reviewAt) <= t,
      );
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
    event: due ? undefined : event.reason,
    queued: due ? undefined : structuredClone(event),
  };
}
// Un registro de consumo por llamada, con lo que la provocó. El origen lo guarda
// el propio evento al encolarse; uno que ya esperaba en la cola antes de existir
// ese campo cuenta como "other".
export function usageRecord(
  job: Job,
  spent: Spent | undefined,
  t: number,
  extra: Pick<Usage, "decisionId" | "ok" | "error">,
): Usage {
  const u: Usage = {
    at: new Date(t).toISOString(),
    tokens: spent?.tokens ?? 0,
    kind: job.due ? "review" : "decision",
    trigger: job.due ? "review" : (job.queued?.trigger ?? "other"),
    event: job.due ? undefined : job.event?.slice(0, USAGE_EVENT_CHARS),
    decisionId: extra.decisionId,
    model: spent?.model,
    promptTokens: spent?.promptTokens,
    completionTokens: spent?.completionTokens,
    cachedTokens: spent?.cachedTokens,
    sections: spent?.sections,
    ok: extra.ok,
    error: extra.error?.slice(0, USAGE_ERROR_CHARS),
  };
  // Sin campos vacíos: el historial guarda miles de registros.
  for (const k of Object.keys(u) as (keyof Usage)[])
    if (u[k] === undefined) delete u[k];
  return u;
}
// Una evaluación fallida gasta su llamada. El evento vuelve a la cola una vez:
// si no, una respuesta mal formada perdía para siempre lo que la provocó.
// spent trae lo que cobró el proveedor si llegó a responder.
export function failJob(
  s: State,
  job: Job,
  motivo: string,
  spent?: Spent,
  t = Date.now(),
) {
  s.modelJob = null;
  s.usage.push(
    usageRecord(job, spent, t, {
      decisionId: job.due?.id,
      ok: false,
      error: motivo,
    }),
  );
  const q = job.queued;
  const intentos = (q?.attempts ?? 0) + 1;
  const reintento = !job.due && q !== undefined && intentos < EVENT_ATTEMPTS;
  if (reintento) s.queue.unshift({ ...q, attempts: intentos });
  const despues = job.due
    ? "Las revisiones se intentan como máximo 3 veces."
    : reintento
      ? "El evento vuelve a la cola para un segundo intento."
      : "El evento ya se había reintentado y se descarta. Puedes solicitar otra reevaluación.";
  log(
    s,
    "error",
    `Falló la evaluación: ${motivo}. El intento cuenta para el límite diario. ${despues}`,
  );
}
// Re-checks limits after the call, because settings may have changed meanwhile.
export function applyDecision(
  s: State,
  job: Job,
  result: {
    input: unknown;
    proposal: z.infer<typeof proposalSchema>;
    tokens: number;
    spent?: Spent;
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
  // Con las posiciones de ahora, no con las que vio el modelo: es lo que se
  // enviaría. Queda sin intención si vende más de lo que se tiene.
  const intent = proposalIntent(s, p);
  if (intent) d.intent = intent;
  s.decisions.push(d);
  s.usage.push(
    usageRecord(job, result.spent ?? { tokens: result.tokens }, t, {
      decisionId: d.id,
      ok: true,
    }),
  );
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
  // Las lecciones salen solo de las revisiones, que ven el resultado. Una
  // decisión tiene delante noticias de terceros, y de ahí no debe nacer una
  // regla que entre sola en la memoria.
  // Las referencias se resuelven contra la misma lista que el agente tuvo
  // delante, no contra la de ahora: entre medias pueden haber llegado noticias.
  const vistas = pendingRefs(job.state.stories ?? []);
  d.newsCommented = [];
  for (const c of p.newsComments ?? []) {
    const vista = vistas.get(c.ref);
    if (!vista) continue;
    const n = s.stories.find((x) => x.id === vista.id);
    if (!n || n.commented) continue;
    n.commented = true;
    d.newsCommented.push({
      storyId: n.id,
      comment: c.comment,
      matters: c.matters,
    });
  }
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
  spent: Spent,
  t = Date.now(),
) {
  // Se registra aunque la decisión ya no exista: los tokens se gastaron igual.
  s.usage.push(
    usageRecord(job, spent, t, { decisionId: job.due!.id, ok: true }),
  );
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
  adoptLessons(
    s,
    parsed.lessons.map((l) => ({ ...l, decisionId: due.id })),
    `Lecciones de la revisión de la ${tradeName(due.proposal.action).toLowerCase()} de ${due.proposal.symbol ?? "un activo"}`,
    t,
  );
  s.modelJob = null;
  log(s, "review", `Revisión completada: ${due.id}`);
  return due;
}

// El analisis se recalcula cada pocos minutos y solo se guarda si cambia algo.
export function applyAnalysis(
  s: SharedState,
  fresh: Record<string, Analysis>,
  t = Date.now(),
) {
  const antes = Object.fromEntries(
    Object.entries(s.analysis).map(([k, a]) => [k, a.barsDiscarded]),
  );
  const kept: Record<string, Analysis> = {};
  for (const symbol of s.settings.symbols) {
    const next = fresh[symbol] ?? s.analysis[symbol];
    if (next) kept[symbol] = next;
  }
  s.analysis = kept;
  // El análisis se recalcula cada pocos minutos y casi siempre cambia, porque
  // cambia el precio. Solo es noticia que el proveedor empiece a mandar velas
  // imposibles, no que se haya recalculado.
  for (const [symbol, a] of Object.entries(kept))
    if (a.barsDiscarded > 0 && a.barsDiscarded !== antes[symbol])
      logShared(
        s,
        "market",
        `${symbol}: ${a.barsDiscarded} ${a.barsDiscarded === 1 ? "sesión descartada" : "sesiones descartadas"} porque el proveedor las dio con datos imposibles.`,
      );
  void t;
}
// Las velas de 5 minutos se sustituyen enteras: solo interesa la última sesión.
export function applyIntraday(s: SharedState, fresh: Record<string, Intraday>) {
  const kept: Record<string, Intraday> = {};
  for (const symbol of s.settings.symbols) {
    const next = fresh[symbol] ?? s.intraday?.[symbol];
    if (next) kept[symbol] = next;
  }
  s.intraday = kept;
}
export const SCAN_START_AFTER_OPEN_MINUTES = 10,
  SCAN_STOP_BEFORE_CLOSE_MINUTES = 15,
  SCAN_RESERVED_CALLS = 3,
  SCAN_REASON = "Revisión periódica del mercado";
// Cada cuántos minutos toca la revisión periódica, o null si ya no queda
// presupuesto para ella. El ritmo lo marca el nivel de riesgo, pero nunca tan
// deprisa que las llamadas del día se acaben antes del cierre: con el límite de
// 20 llamadas, revisar cada 10 minutos lo agotaba hacia la una de la tarde en
// Nueva York, y una vigilancia cumplida después ya no se podía evaluar. Por eso
// se reservan unas pocas llamadas para vigilancias, órdenes ejecutadas y
// revisiones, y el resto se reparte hasta el final de la sesión.
export function scanEveryMinutes(s: State, t = Date.now()) {
  const base = riskProfileOf(s.settings).scanEveryMinutes;
  const hoy = new Date(t).toISOString().slice(0, 10);
  const usadas = s.calls.day === hoy ? s.calls.count : 0;
  const reserva = Math.min(
    SCAN_RESERVED_CALLS,
    Math.floor(s.settings.maxDailyCalls / 5),
  );
  const libres = s.settings.maxDailyCalls - usadas - reserva;
  if (libres <= 0) return null;
  const cierre = Date.parse(s.market.nextClose ?? "");
  if (!Number.isFinite(cierre)) return base;
  const quedan = (cierre - t) / 60000 - SCAN_STOP_BEFORE_CLOSE_MINUTES;
  return Math.max(base, Math.ceil(quedan / libres));
}
// Con la sesión abierta, el agente mira el mercado cada pocos minutos, según el
// nivel de riesgo, aunque no haya noticias ni vigilancias. Antes solo se
// despertaba por eventos y podía pasar la sesión entera sin evaluar nada. Cerca
// del cierre no se abre una operación que no daría tiempo a gestionar.
export function queueSessionScan(s: State, t = Date.now()) {
  if (s.paused || s.queue.length || !sessionOpen(s, t)) return false;
  // En los primeros minutos todavía no hay velas de la sesión, y la evaluación
  // se gastaba en decir que faltan datos.
  if (newYorkMinutes(t) < SESSION_OPEN_MINUTE + SCAN_START_AFTER_OPEN_MINUTES)
    return false;
  const cierre = Date.parse(s.market.nextClose!);
  if (cierre - t < SCAN_STOP_BEFORE_CLOSE_MINUTES * 60000) return false;
  const cada = scanEveryMinutes(s, t);
  if (cada === null) return false;
  if (s.lastDecision && t - Date.parse(s.lastDecision) < cada * 60000)
    return false;
  enqueue(s, SCAN_REASON, "periodic");
  return true;
}

// Guarda las noticias nuevas, que son compartidas, y devuelve cuáles lo son.
export function mergeNews(
  sh: Pick<SharedState, "stories" | "settings">,
  raw: unknown[],
  t = Date.now(),
) {
  const { stories, fresh } = mergeStories(
    sh.stories,
    raw,
    sh.settings.symbols,
    t,
  );
  sh.stories = stories;
  return fresh;
}
// Cada simulación decide si una tanda de noticias la despierta, una sola vez por
// tanda, según su nivel de riesgo y su pausa.
export function queueNews(s: State, fresh: Story[], t = Date.now()) {
  if (!fresh.length) return 0;
  // Con la bolsa cerrada el agente no puede operar: despertarlo por cada tanda
  // gastaba una llamada para decir que espera. Las noticias se guardan y se
  // comentan juntas antes de la apertura. Sin calendario no se sabe si está
  // cerrada, y se prefiere no perder la noticia.
  // En los niveles activo y agresivo tampoco despiertan con la bolsa abierta. El
  // 16/09/2026 casi todas las evaluaciones las provocaba una tanda de noticias, y
  // en cada una el agente repasaba su única posición para decir que seguía
  // igual. Las pendientes llevan ref en el contexto y se comentan en la
  // siguiente revisión periódica, que en esos niveles es la más frecuente.
  const abierta = sessionOpen(s, t);
  const despertar =
    (abierta && riskProfileOf(s.settings).newsWakesAgent) || !s.feeds.clock;
  log(
    s,
    "news",
    summarise(fresh) +
      (despertar
        ? ""
        : abierta
          ? ". Se comentarán en la próxima revisión."
          : ". Bolsa cerrada: se comentarán antes de la apertura."),
  );
  if (!s.paused && despertar) enqueue(s, summarise(fresh), "news");
  return fresh.length;
}
export const NEWS_REVIEW_REASON = "Repaso de noticias pendientes de comentar";
// Encola una sola vez por sesión el repaso de las noticias sin comentar: en los
// 30 minutos previos a la apertura, o nada más abrir si el worker no estaba.
export function queueNewsBeforeOpen(s: State, t = Date.now()) {
  if (s.paused || !s.feeds.clock || s.queue.length) return false;
  // El cierre de la próxima sesión la identifica tanto antes como durante ella.
  const sesion = s.market.nextClose;
  if (!sesion || s.preOpenNews === sesion) return false;
  if (sessionOpen(s, t)) {
    // Si las noticias no despiertan al agente, con la bolsa abierta tampoco lo
    // hace este repaso: contaría como pendientes las llegadas durante la sesión.
    // Las de la noche se comentan en la primera revisión periódica.
    if (!riskProfileOf(s.settings).newsWakesAgent) return false;
  } else {
    const apertura = s.market.nextOpen ? Date.parse(s.market.nextOpen) : NaN;
    const faltan = (apertura - t) / 60000;
    if (!(faltan > 0 && faltan <= PRE_OPEN_MINUTES)) return false;
  }
  const pendientes = (s.stories ?? []).filter((n) => !n.commented).length;
  if (!pendientes) return false;
  s.preOpenNews = sesion;
  enqueue(
    s,
    `${NEWS_REVIEW_REASON}: ${pendientes} ${pendientes === 1 ? "noticia llegada" : "noticias llegadas"} con la bolsa cerrada`,
    "preopen",
  );
  return true;
}
