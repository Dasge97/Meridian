import WebSocket from "ws";
import { z } from "zod";
import { describeFailure } from "./worker-failures.ts";
import { pool, change, read } from "./db.ts";
import { alpaca, configured, snapshot, dailyBars } from "./alpaca.ts";
import { decide, review, modelConfigured } from "./model.ts";
import { log, lessonSchema, limitPriceString, type Quote } from "./domain.ts";
import { analyse, type Analysis } from "./market.ts";
import {
  applyAnalysis,
  applyMarket,
  applySnapshot,
  claimIntent,
  claimJob,
  applyDecision,
  applyReview,
} from "./agent.ts";
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
  lastTick = 0,
  streamSymbols = "",
  marketOpen = false;
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
      await change((s) => {
        const target = s.decisions.find((x) => x.id === id);
        if (!target) return;
        if (target.status !== "unknown")
          log(
            s,
            "error",
            "Envío incierto. Agente pausado; comprueba la orden en Alpaca y reconcilia desde el panel.",
          );
        target.status = "unknown";
        s.paused = true;
      });
    }
  }
}
async function submitStep() {
  const intent = await change((s) => claimIntent(s, marketOpen));
  if (!intent) return;
  try {
    const p = intent.proposal;
    const asset = await alpaca("/v2/assets/" + p.symbol);
    if (!asset.tradable || asset.status !== "active") {
      await change((s) => {
        const d = s.decisions.find((x) => x.id === intent.id);
        if (!d) return;
        d.status = "blocked";
        d.error = "Activo no negociable";
      });
      return;
    }
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
    await change((s) => {
      const d = s.decisions.find((x) => x.id === intent.id);
      if (!d) return;
      d.status = order.status;
      d.orderId = order.id;
      log(s, "order", `Orden enviada a Alpaca Paper: ${p.symbol}`);
    });
  } catch {
    await change((s) => {
      const d = s.decisions.find((x) => x.id === intent.id);
      if (d) d.status = "unknown";
      s.paused = true;
      log(
        s,
        "error",
        "Respuesta de orden incierta; pausa y reconciliación obligatoria.",
      );
    });
  }
}
// Velas diarias e indicadores. Cambian despacio, asi que se piden cada 5 minutos.
export const ANALYSIS_EVERY_MS = 300000;
async function analysisStep() {
  if (!configured() || Date.now() - lastAnalysis < ANALYSIS_EVERY_MS) return;
  lastAnalysis = Date.now();
  const state = await read();
  const symbols = state.settings.symbols;
  if (!symbols.length) return;
  const raw = await dailyBars(symbols);
  const fresh: Record<string, Analysis> = {};
  for (const symbol of symbols) {
    const price = state.quotes[symbol]?.price ?? 0;
    const bars = raw[symbol] ?? [];
    if (bars.length) fresh[symbol] = analyse(bars, price, "alpaca sip 1Day");
  }
  if (Object.keys(fresh).length) await change((s) => applyAnalysis(s, fresh));
}
async function brokerStep() {
  if (configured() && Date.now() - lastSync > 30000) {
    lastSync = Date.now();
    try {
      const state = await read();
      const x = await snapshot(state.settings.symbols);
      marketOpen = Boolean(x.clock?.is_open);
      await change((s) => applySnapshot(s, x));
    } catch {
      await change((s) => {
        log(
          s,
          "error",
          "No se pudo sincronizar Alpaca; no se enviarán órdenes con datos obsoletos.",
        );
      });
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
  try {
    if (job.due) {
      const result = await review(job.state, job.due);
      const parsed = z
        .object({
          text: z.string().min(10).max(6000),
          lessons: z.array(lessonSchema).max(3),
        })
        .parse(result.value);
      await change((s) => applyReview(s, job, parsed, result.tokens));
      return;
    }
    const result = await decide(job.state, job.event!);
    await change((s) => applyDecision(s, job, result, marketOpen));
  } catch (e) {
    // Sin el motivo concreto no hay forma de saber si falló el proveedor, si
    // tardó demasiado o si la respuesta no cumplía el esquema.
    const motivo = describeFailure(e);
    await change((s) => {
      s.modelJob = null;
      log(
        s,
        "error",
        `Falló la evaluación: ${motivo}. El intento cuenta para el límite diario. Puedes solicitar otra reevaluación. Las revisiones se intentan como máximo 3 veces.`,
      );
    });
  }
}
async function loop(name: string, step: () => Promise<void>, waitMs: number) {
  while (!stopping) {
    try {
      await step();
    } catch {
      console.error(`Worker ${name} failed`);
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
]);
await lock.query("SELECT pg_advisory_unlock(746391)");
lock.release();
await pool.end();
