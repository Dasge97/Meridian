import WebSocket from "ws";
import { describeFailure } from "./worker-failures.ts";
import {
  pool,
  changeShared,
  changeSim,
  readShared,
  readHot,
  WORKER_LOCK,
} from "./db.ts";
import {
  configured,
  marketSnapshot,
  dailyBars,
  intradayBars,
  marketNews,
} from "./alpaca.ts";
import { log, logShared, type Quote } from "./domain.ts";
import {
  analyse,
  intradaySummary,
  type Analysis,
  type Intraday,
} from "./market.ts";
import { newsSims } from "./report.ts";
import {
  applyAnalysis,
  applyIntraday,
  applyQuotes,
  applyMarketSnapshot,
  mergeNews,
  queueNews,
} from "./agent.ts";
import { sessionOpen, todayStarted, newYorkDate } from "./clock.ts";
import { SIM_IDS, type SimId } from "./sims.ts";
import { simWorker, modelConcurrency } from "./sim-worker.ts";
// One worker owns the market connection and outbox, including across rolling restarts.
const lock = await pool.connect();
if (
  !(await lock.query("SELECT pg_try_advisory_lock($1) AS ok", [WORKER_LOCK]))
    .rows[0].ok
)
  throw new Error("Otro worker está activo");
lock.on("error", () => process.exit(1));
// Dónde se registra el fallo de un bucle: en lo compartido o en una simulación.
type Scope = "shared" | SimId;
let stopping = false,
  ws: WebSocket | undefined,
  retryAt = 0,
  lastCalendar = 0,
  lastAnalysis = 0,
  lastAnalysisOpen = false,
  lastNews = 0,
  lastTick = 0,
  streamSymbols = "";
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
// Precios y latido, compartidos. Nunca espera al modelo, así que los precios
// siguen llegando durante una evaluación. Solo reescribe shared:hot.
async function marketStep() {
  const symbols = await changeShared((sh) => {
    applyQuotes(sh, quotes, ws?.readyState === WebSocket.OPEN, lastTick);
    return sh.settings.symbols;
  });
  if (ws && streamSymbols !== symbols.join(",")) ws.close();
  if (!ws) connect(symbols);
}
// Calendario y últimos precios cada 30 segundos, compartidos. Va aparte de la
// cuenta: una petición lenta a /v2/account no retrasa el calendario.
async function calendarStep() {
  if (!configured() || Date.now() - lastCalendar < 30000) return;
  lastCalendar = Date.now();
  const { shared } = await readHot([]);
  const x = await marketSnapshot(shared.settings.symbols);
  await changeShared((sh) => applyMarketSnapshot(sh, x));
}
// Velas diarias e indicadores. Cambian despacio, asi que se piden cada 5 minutos.
export const ANALYSIS_EVERY_MS = 300000;
async function analysisStep() {
  if (!configured()) return;
  const state = await readShared();
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
  if (Object.keys(fresh).length)
    await changeShared((sh) => applyAnalysis(sh, fresh));
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
    await changeShared((sh) => applyIntraday(sh, intraday));
}
// Las noticias llegan de continuo. Se miran por tandas para que el agente no se
// dispare con cada titular. Se guardan una vez, en lo compartido, y cada
// simulación decide si la tanda la despierta.
export const NEWS_EVERY_MS = 1800000;
async function newsStep() {
  if (!configured() || Date.now() - lastNews < NEWS_EVERY_MS) return;
  lastNews = Date.now();
  const { shared } = await readHot([]);
  if (!shared.settings.symbols.length) return;
  const raw = await marketNews(shared.settings.symbols);
  const fresh = await changeShared((sh) => mergeNews(sh, raw));
  if (!fresh.length) return;
  for (const sim of SIM_IDS) await changeSim(sim, (s) => queueNews(s, fresh));
}
async function loop(
  name: string,
  scope: Scope,
  step: () => Promise<void>,
  waitMs: number,
) {
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
        const texto = `Fallo en ${name}: ${motivo}`;
        try {
          if (scope === "shared")
            await changeShared((sh) => logShared(sh, "error", texto));
          else await changeSim(scope, (s) => log(s, "error", texto));
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
// Lo de cada simulación: vigilancias y ejecuciones simuladas, bróker, modelo y
// avisos. La interna nunca llama a Alpaca.
const sims = simWorker();
const concurrency = modelConcurrency(process.env.MODEL_CONCURRENCY);
const avisoNoticias = newsSims(process.env.TELEGRAM_NEWS_SIMS);
if (avisoNoticias.unknown.length)
  console.warn(
    `TELEGRAM_NEWS_SIMS: no existe ${avisoNoticias.unknown.join(", ")}. Se usan ${avisoNoticias.sims.join(", ")}.`,
  );
console.log(
  `Meridian worker: paper only. Simulaciones: ${SIM_IDS.join(", ")}. Llamadas al modelo a la vez: ${concurrency === 1 ? "1, por turnos" : "una por simulación"}.`,
);
await Promise.all([
  loop("market", "shared", marketStep, 2000),
  loop("calendar", "shared", calendarStep, 2000),
  loop("analysis", "shared", analysisStep, 10000),
  loop("news", "shared", newsStep, 30000),
  ...SIM_IDS.flatMap((sim) => [
    loop(`watches:${sim}`, sim, () => sims.watchesStep(sim), 2000),
    loop(`broker:${sim}`, sim, () => sims.brokerStep(sim), 2000),
  ]),
  ...(concurrency === 1
    ? [
        loop(
          "model",
          "shared",
          async () => void (await sims.scheduledModelStep()),
          2000,
        ),
      ]
    : SIM_IDS.map((sim) =>
        loop(
          `model:${sim}`,
          sim,
          async () => void (await sims.modelStep(sim)),
          2000,
        ),
      )),
]);
await lock.query("SELECT pg_advisory_unlock($1)", [WORKER_LOCK]);
lock.release();
await pool.end();
