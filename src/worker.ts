import WebSocket from "ws";
import { describeFailure } from "./worker-failures.ts";
import { pool, change, read } from "./db.ts";
import {
  alpaca,
  configured,
  snapshot,
  dailyBars,
  intradayBars,
  marketNews,
} from "./alpaca.ts";
import {
  decide,
  review,
  modelConfigured,
  ModelFailure,
  type Spent,
} from "./model.ts";
import {
  log,
  now,
  limitPriceString,
  assetProblem,
  INTENT_LABELS,
  type AssetInfo,
  type Quote,
} from "./domain.ts";
import {
  analyse,
  intradaySummary,
  type Analysis,
  type Intraday,
} from "./market.ts";
import { sendTelegram, telegramConfigured } from "./telegram.ts";
import {
  decisionNotice,
  newsNotice,
  orderNotice,
  reviewNotice,
  problemNotice,
  type Notice,
} from "./report.ts";
import {
  applyAnalysis,
  applyNews,
  applyMarket,
  applySnapshot,
  claimIntent,
  claimJob,
  applyDecision,
  applyReview,
  failJob,
  queueNewsBeforeOpen,
  queueSessionScan,
  applyIntraday,
} from "./agent.ts";
import { sessionOpen, todayStarted, newYorkDate } from "./clock.ts";
// One worker owns the market connection and outbox, including across rolling restarts.
const lock = await pool.connect();
if (!(await lock.query("SELECT pg_try_advisory_lock(746391) AS ok")).rows[0].ok)
  throw new Error("Otro worker está activo");
lock.on("error", () => process.exit(1));
let stopping = false,
  ws: WebSocket | undefined,
  retryAt = 0,
  lastSync = 0,
  lastAnalysis = 0,
  lastAnalysisOpen = false,
  lastNews = 0,
  lastTick = 0,
  streamSymbols = "",
  syncFailure = "";
const quotes: Record<string, Quote> = {};
function connect(symbols: string[]) {
  if (!configured() || Date.now() < retryAt) return;
  streamSymbols = symbols.join(",");
  retryAt = Date.now() + 10000;
  ws = new WebSocket("wss://stream.data.alpaca.markets/v2/iex");
  ws.on("open", () =>
    ws?.send(
      JSON.stringify({
        action: "auth",
        key: process.env.ALPACA_KEY_ID,
        secret: process.env.ALPACA_SECRET_KEY,
      }),
    ),
  );
  ws.on("message", (buffer) => {
    lastTick = Date.now();
    try {
      for (const m of JSON.parse(buffer.toString())) {
        if (m.T === "success" && m.msg === "authenticated")
          ws?.send(JSON.stringify({ action: "subscribe", trades: symbols }));
        if (
          m.T === "t" &&
          symbols.includes(m.S) &&
          Number.isFinite(m.p) &&
          m.p > 0
        )
          quotes[m.S] = { price: m.p, at: m.t };
        if (m.T === "error") {
          console.error("Market stream error", m.code);
          ws?.close();
        }
      }
    } catch {
      console.error("Invalid market message");
    }
  });
  ws.on("error", () => ws?.close());
  ws.on("close", () => {
    ws = undefined;
    retryAt = Date.now() + 10000;
  });
}
// Prices and watches. Never waits on the model, so conditions keep being checked.
async function marketStep() {
  const symbols = await change((s) => {
    applyMarket(s, quotes, ws?.readyState === WebSocket.OPEN, lastTick);
    return s.settings.symbols;
  });
  if (ws && streamSymbols !== symbols.join(",")) ws.close();
  if (!ws) connect(symbols);
}
// Reconcile ambiguous submissions after a crash or timeout. Never blindly resend.
async function reconcileStep() {
  const ambiguous = await change((s) =>
    s.decisions
      .filter((d) => ["submitting", "unknown"].includes(d.status))
      .map((d) => d.id),
  );
  for (const id of ambiguous) {
    try {
      const o = await alpaca(
        "/v2/orders:by_client_order_id?client_order_id=" + id,
      );
      await change((s) => {
        const target = s.decisions.find((x) => x.id === id);
        if (!target) return;
        target.status = o.status;
        target.orderId = o.id;
      });
    } catch {
      const aviso = await change((s) => {
        const target = s.decisions.find((x) => x.id === id);
        if (!target) return null;
        const primeraVez = target.status !== "unknown";
        if (primeraVez)
          log(
            s,
            "error",
            "Envío incierto. Agente pausado; comprueba la orden en Alpaca y reconcilia desde el panel.",
          );
        target.status = "unknown";
        s.paused = true;
        return primeraVez
          ? problemNotice(
              `No se sabe si la orden de ${target.proposal.symbol} llegó a Alpaca. El agente queda pausado hasta que lo resuelvas desde el panel. No se reenviará sola.`,
              process.env.APP_ORIGIN,
            )
          : null;
      });
      await notify(aviso);
    }
  }
}
async function submitStep() {
  const intent = await change((s) => claimIntent(s, sessionOpen(s)));
  if (!intent) return;
  const p = intent.proposal;
  // Consultar el activo no envía nada. Si falla, la orden no ha salido: se
  // bloquea con el motivo en lugar de pausar el agente como con un envío incierto.
  let asset: AssetInfo;
  try {
    asset = await alpaca("/v2/assets/" + p.symbol);
  } catch (e) {
    await change((s) => {
      const d = s.decisions.find((x) => x.id === intent.id);
      if (!d) return;
      d.status = "blocked";
      d.error = `No se pudo consultar el activo en Alpaca: ${describeFailure(e)}`;
    });
    return;
  }
  // Negociable y, si abre o amplía un corto, con acciones para pedir prestadas.
  // El resto de comprobaciones de orderGuard ya las pasó claimIntent.
  const problema = assetProblem(asset, intent.intent);
  if (problema) {
    await change((s) => {
      const d = s.decisions.find((x) => x.id === intent.id);
      if (!d) return;
      d.status = "blocked";
      d.error = problema;
    });
    return;
  }
  try {
    const order = await alpaca("/v2/orders", "POST", {
      symbol: p.symbol,
      qty: String(p.qty),
      side: p.action,
      type: "limit",
      limit_price: limitPriceString(p.limitPrice!),
      time_in_force: "day",
      extended_hours: false,
      client_order_id: intent.id,
    });
    const aviso = await change((s) => {
      const d = s.decisions.find((x) => x.id === intent.id);
      if (!d) return null;
      d.status = order.status;
      d.orderId = order.id;
      log(
        s,
        "order",
        `Orden enviada a Alpaca Paper: ${d.intent ? `${INTENT_LABELS[d.intent]} de ` : ""}${p.symbol}`,
      );
      return orderNotice(s, d, order.status);
    });
    await notify(aviso);
  } catch {
    const aviso = await change((s) => {
      const d = s.decisions.find((x) => x.id === intent.id);
      if (d) d.status = "unknown";
      s.paused = true;
      log(
        s,
        "error",
        "Respuesta de orden incierta; pausa y reconciliación obligatoria.",
      );
      return problemNotice(
        `La orden de ${intent.proposal.symbol} se envió pero Alpaca no confirmó. El agente queda pausado y hay que reconciliar desde el panel.`,
        process.env.APP_ORIGIN,
      );
    });
    await notify(aviso);
  }
}
// Velas diarias e indicadores. Cambian despacio, asi que se piden cada 5 minutos.
export const ANALYSIS_EVERY_MS = 300000;
async function analysisStep() {
  if (!configured()) return;
  const state = await read();
  // Al abrir o cerrar la bolsa se recalcula al momento. Si no, la primera
  // evaluación de la sesión podía usar un análisis de antes de la apertura.
  const abierta = sessionOpen(state);
  if (
    Date.now() - lastAnalysis < ANALYSIS_EVERY_MS &&
    abierta === lastAnalysisOpen
  )
    return;
  lastAnalysis = Date.now();
  lastAnalysisOpen = abierta;
  const symbols = state.settings.symbols;
  if (!symbols.length) return;
  const raw = await dailyBars(symbols);
  const t = Date.now();
  const session = {
    open: sessionOpen(state, t),
    started: todayStarted(state, t),
    today: newYorkDate(t),
  };
  const fresh: Record<string, Analysis> = {};
  for (const symbol of symbols) {
    const price = state.quotes[symbol]?.price ?? 0;
    const bars = raw[symbol] ?? [];
    if (bars.length)
      fresh[symbol] = analyse(
        bars,
        price,
        "alpaca sip 1Day",
        new Date(t).toISOString(),
        session,
      );
  }
  if (Object.keys(fresh).length) await change((s) => applyAnalysis(s, fresh));
  // Las velas de 5 minutos van después: si fallan, el análisis diario ya está
  // guardado.
  const [rawIntraday, rawIex] = await Promise.all([
    intradayBars(symbols),
    intradayBars(symbols, 1, "iex"),
  ]);
  const intraday: Record<string, Intraday> = {};
  for (const symbol of symbols) {
    // Fuera de la sesión el precio del momento puede ser de antes de la
    // apertura o de después del cierre: manda el último cierre de la sesión.
    const price = session.open ? (state.quotes[symbol]?.price ?? 0) : 0;
    const summary = intradaySummary(
      rawIntraday[symbol] ?? [],
      price,
      "alpaca sip 5Min, últimos minutos de iex",
      new Date(t).toISOString(),
      rawIex[symbol] ?? [],
    );
    if (summary) intraday[symbol] = summary;
  }
  if (Object.keys(intraday).length)
    await change((s) => applyIntraday(s, intraday));
}
async function brokerStep() {
  if (configured() && Date.now() - lastSync > 30000) {
    lastSync = Date.now();
    try {
      const state = await read();
      const x = await snapshot(state.settings.symbols);
      const recuperada = syncFailure !== "";
      syncFailure = "";
      const avisos = await change((s) => {
        const antes = new Map(s.decisions.map((d) => [d.id, d.status]));
        applySnapshot(s, x);
        queueNewsBeforeOpen(s);
        queueSessionScan(s);
        if (recuperada)
          log(s, "market", "Alpaca vuelve a sincronizar la cuenta.");
        return s.decisions
          .filter((d) => antes.get(d.id) !== d.status)
          .map((d) => orderNotice(s, d, d.status))
          .filter((n): n is Notice => n !== null);
      });
      for (const aviso of avisos) await notify(aviso);
    } catch (e) {
      // Se registra el motivo y solo la primera vez de una racha: antes quedaba
      // un aviso idéntico cada 30 segundos, sin decir qué fallaba.
      const motivo = describeFailure(e);
      if (motivo !== syncFailure) {
        syncFailure = motivo;
        await change((s) => {
          log(
            s,
            "error",
            `No se pudo sincronizar Alpaca (${motivo}). No se enviarán órdenes con datos obsoletos.`,
          );
        });
      }
    }
  }
  await reconcileStep();
  await submitStep();
}
// Model calls run here, outside any transaction and outside the market loop.
async function modelStep() {
  const job = await change((s) =>
    claimJob(s, configured() && modelConfigured()),
  );
  if (!job) return;
  // Lo gastado en una llamada que respondió bien pero no se llegó a guardar.
  let unsaved: Spent | undefined;
  try {
    if (job.due) {
      const result = await review(job.state, job.due);
      unsaved = result.spent;
      const aviso = await change((s) => {
        const due = applyReview(s, job, result.parsed, result.spent);
        return due ? reviewNotice(s, due) : null;
      });
      unsaved = undefined;
      await notify(aviso);
      return;
    }
    const result = await decide(job.state, job.event!);
    unsaved = result.spent;
    const avisos = await change((s) => {
      const d = applyDecision(s, job, result, sessionOpen(s));
      return [newsNotice(s, d), decisionNotice(s, d)];
    });
    unsaved = undefined;
    for (const aviso of avisos) await notify(aviso);
  } catch (e) {
    // Sin el motivo concreto no hay forma de saber si falló el proveedor, si
    // tardó demasiado o si la respuesta no cumplía el esquema. El fallo del
    // modelo lleva dentro lo que llegó a cobrar el proveedor.
    const failure = e instanceof ModelFailure ? e : null;
    const motivo = describeFailure(failure ? failure.original : e);
    await change((s) =>
      failJob(s, job, motivo, failure ? failure.spent : unsaved),
    );
  }
}
// Enviar un aviso nunca puede impedir que el laboratorio siga funcionando: si
// Telegram falla, se registra y se sigue.
async function notify(notice: Notice | null) {
  if (!notice || !telegramConfigured()) return;
  try {
    await sendTelegram(notice.text);
    await change((s) => {
      s.lastNotice = { at: now(), kind: notice.kind };
    });
  } catch (e) {
    await change((s) => {
      log(s, "error", `No se pudo avisar por Telegram: ${describeFailure(e)}`);
    });
  }
}
// Las noticias llegan de continuo. Se miran por tandas para que el agente no se
// dispare con cada titular.
export const NEWS_EVERY_MS = 1800000;
async function newsStep() {
  if (!configured() || Date.now() - lastNews < NEWS_EVERY_MS) return;
  lastNews = Date.now();
  const state = await read();
  if (!state.settings.symbols.length) return;
  const raw = await marketNews(state.settings.symbols);
  await change((s) => applyNews(s, raw));
}
async function loop(name: string, step: () => Promise<void>, waitMs: number) {
  let ultimoFallo = "";
  while (!stopping) {
    try {
      await step();
      ultimoFallo = "";
    } catch (e) {
      // Sin el motivo no hay forma de saber qué bucle se rompió ni por qué. Se
      // registra el primero de una racha, no los de cada vuelta.
      const motivo = describeFailure(e);
      console.error(`Worker ${name}: ${motivo}`);
      if (motivo !== ultimoFallo) {
        ultimoFallo = motivo;
        try {
          await change((s) => log(s, "error", `Fallo en ${name}: ${motivo}`));
        } catch {
          console.error(`Worker ${name}: tampoco se pudo registrar el fallo`);
        }
      }
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }
}
function stop() {
  stopping = true;
  ws?.close();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
console.log("Meridian worker: paper only");
await Promise.all([
  loop("market", marketStep, 2000),
  loop("broker", brokerStep, 2000),
  loop("model", modelStep, 2000),
  loop("analysis", analysisStep, 10000),
  loop("news", newsStep, 30000),
]);
await lock.query("SELECT pg_advisory_unlock(746391)");
lock.release();
await pool.end();
