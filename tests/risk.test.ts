import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  restoreState,
  settingsSchema,
  sharedSettingsSchema,
  proposalSchema,
  orderGuard,
  orderIntent,
  riskProfileOf,
  knownIntent,
  intentLabel,
  RISK_PROFILES,
  INTENT_LABELS,
  now,
  id,
  type State,
  type Decision,
  type RiskProfile,
} from "../src/domain.ts";
import {
  applyDecision,
  mergeNews,
  queueNews,
  claimIntent,
  queueNewsBeforeOpen,
  queueSessionScan,
  scanEveryMinutes,
  type Job,
} from "../src/agent.ts";
import {
  allFallingNothingToReduce,
  context,
  decide,
  recentDecisions,
  reviewContext,
  riskInstructions,
} from "../src/model.ts";
import { decisionNotice, orderNotice, reviewNotice } from "../src/report.ts";
import { newYorkDate } from "../src/clock.ts";
import type { Intraday } from "../src/market.ts";
import { decisionType } from "../web/views/decisions-intent.tsx";
import { composeState, decomposeState } from "../src/sim-state.ts";
// Las noticias se guardan en lo compartido y cada simulación decide si despierta,
// como en el worker.
function applyNews(s: State, raw: unknown[]) {
  const { shared, sim } = decomposeState(s);
  const fresh = mergeNews(shared, raw);
  Object.assign(s, composeState(shared, sim));
  return queueNews(s, fresh);
}
const LEVELS = Object.keys(RISK_PROFILES) as RiskProfile[];
function state(level: RiskProfile = "balanced"): State {
  const s = initialState();
  s.paused = false;
  s.settings.riskProfile = level;
  s.account = { status: "ACTIVE", equity: "10000", cash: "10000" };
  s.baseline = 10000;
  s.lastSync = now();
  s.quotes.AAPL = { price: 200, at: now() };
  s.market = {
    open: true,
    nextOpen: null,
    nextClose: new Date(Date.now() + 3600000).toISOString(),
  };
  return s;
}
const proposal = (over: Record<string, unknown> = {}) =>
  proposalSchema.parse({
    action: "sell",
    symbol: "AAPL",
    qty: 1,
    limitPrice: 200,
    reason: "Hipótesis basada en precio",
    hypothesis: "Esperar confirmación",
    reviewAfterHours: 24,
    notify: true,
    note: "Nota suficientemente larga para el propietario",
    watches: [],
    ...over,
  });
const waiting = (note = "Sigo con las 23 acciones y mantengo") =>
  proposal({ action: "wait", symbol: null, qty: null, limitPrice: null, note });
const decision = (over: Partial<Decision> = {}): Decision => ({
  id: id(),
  at: now(),
  versionId: "v1",
  event: "evento",
  input: null,
  proposal: proposal(),
  status: "observed",
  reviewAt: now(),
  ...over,
});
const job = (s: State): Job => ({
  meta: { id: id(), startedAt: now(), kind: "decision", targetId: id() },
  state: structuredClone(s),
  due: null,
  event: "Revisión periódica del mercado",
});
const negociable = { tradable: true, status: "active" };
const PROHIBICION =
  "No puedes vender en corto: sell solo con acciones que ya tienes, y como mucho las que tienes.";

test("An old saved state without a risk level gets the balanced one", () => {
  const guardado = initialState() as any;
  delete guardado.settings.riskProfile;
  const s = restoreState([
    { settings: guardado.settings, paused: true },
    { decisions: [] },
  ]);
  assert.equal(s.settings.riskProfile, "balanced");
  assert.equal(s.settings.maxOrderUsd, 600, "lo guardado se conserva");
  const { riskProfile, ...sinNivel } = initialState().settings;
  void riskProfile;
  assert.equal(settingsSchema.parse(sinNivel).riskProfile, "balanced");
  assert.throws(() =>
    settingsSchema.parse({ ...sinNivel, riskProfile: "temerario" }),
  );
  // Un valor que no existe no rompe la evaluación: se trata como el de defecto.
  assert.equal(riskProfileOf({ riskProfile: "temerario" }).key, "balanced");
  assert.equal(riskProfileOf(undefined).key, "balanced");
});

test("The shared limits ignore a risk level sent with them", () => {
  const conNivel = { ...initialState().settings, riskProfile: "aggressive" };
  const limites = sharedSettingsSchema.parse(conNivel);
  assert.equal(
    "riskProfile" in limites,
    false,
    "el nivel es de cada simulación",
  );
  assert.equal(limites.maxOrderUsd, 600);
  // Uno que no existe tampoco rompe el formulario de límites de antes.
  assert.doesNotThrow(() =>
    sharedSettingsSchema.parse({ ...conNivel, riskProfile: "temerario" }),
  );
});

test("Each level adds its own concrete block of instructions", () => {
  const texto = (level: RiskProfile) => riskInstructions(state(level));
  for (const level of LEVELS) {
    const t = texto(level);
    assert.match(
      t,
      new RegExp(`NIVEL DE RIESGO: ${RISK_PROFILES[level].label}`),
    );
    assert.match(t, /manda sobre cualquier frase anterior/);
    assert.match(t, /no abras operaciones por cumplir un número/);
  }
  assert.match(texto("prudent"), /Puedes esperar cuando ninguna idea/);
  assert.match(texto("balanced"), /solo si reason explica con cifras/);
  assert.match(texto("active"), /propón al menos una operación/);
  assert.match(texto("active"), /Motivo N:/);
  assert.match(texto("active"), /menor que 15/);
  assert.match(texto("active"), /No son motivos: que el mercado esté flojo/);
  assert.match(texto("active"), /dato macro/);
  assert.doesNotMatch(texto("balanced"), /Motivo N:/);
  assert.match(texto("aggressive"), /varias operaciones por sesión/);
  assert.match(texto("aggressive"), /confirmación parcial/);
  assert.match(
    texto("aggressive"),
    /reduce o cierra lo que tengas antes de abrir nada nuevo/,
  );
  assert.match(texto("aggressive"), /no compres a contracorriente/);
  // Tamaño sobre maxOrderUsd = 600.
  assert.match(texto("prudent"), /25 % de maxOrderUsd, unos 150 USD/);
  assert.match(texto("balanced"), /50 % de maxOrderUsd, unos 300 USD/);
  assert.match(texto("active"), /80 % de maxOrderUsd, unos 480 USD/);
  assert.match(texto("aggressive"), /100 % de maxOrderUsd, unos 600 USD/);
  // Distancia de salida en veces atr14.
  assert.match(texto("prudent"), /distancia de 1 vez el movimiento/);
  assert.match(texto("balanced"), /distancia de 1,5 veces/);
  assert.match(texto("active"), /distancia de entre 2 y 3 veces/);
  // Ningún nivel vende en corto. Lo único que habla de cortos es la prohibición.
  for (const level of LEVELS) {
    const t = texto(level);
    assert.ok(t.includes(PROHIBICION), `${level}: prohíbe los cortos`);
    assert.doesNotMatch(t.replace(PROHIBICION, ""), /corto|short/i, level);
    assert.doesNotMatch(RISK_PROFILES[level].description, /corto/i, level);
  }
});

test("The level block goes right after the saved instructions, which stay untouched", async () => {
  const s = state("active");
  const instrucciones = s.versions[0].instructions;
  const original = globalThis.fetch;
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";
  let sent: any;
  try {
    globalThis.fetch = async (_url, opts) => {
      sent = JSON.parse(String(opts?.body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(waiting()) } }],
          usage: { total_tokens: 1 },
        }),
      );
    };
    await decide(s, "Revisión periódica del mercado");
  } finally {
    globalThis.fetch = original;
  }
  const system: string = sent.messages[0].content;
  assert.ok(system.startsWith(instrucciones + riskInstructions(s)));
  assert.equal(s.versions[0].instructions, instrucciones);
  assert.equal(s.versions.length, 1, "no crea ninguna versión");
  const input = JSON.parse(sent.messages[1].content);
  assert.equal(input.settings.riskProfile, "active");
  assert.equal(input.risk.profile, "active");
  assert.equal(input.risk.label, "Activo");
  assert.equal(input.risk.scanEveryMinutes, 15);
  assert.equal("shorts" in input.risk, false, "sin campo de cortos");
  assert.equal(input.risk.allFallingNothingToReduce, false);
  assert.equal(input.risk.orderTargetUsd, 480);
  assert.deepEqual(input.risk.exitAtrMultiple, { min: 2, max: 3 });
  assert.equal(input.risk.ordersLeftToday, 5);
});

test("Each level scans the market at its own pace", () => {
  // Lunes 14 de septiembre de 2026 a las 11:00 en Nueva York.
  const T = Date.parse("2026-09-14T15:00:00Z");
  const hace = (minutos: number) => new Date(T - minutos * 60000).toISOString();
  for (const level of LEVELS) {
    const s = state(level);
    s.settings.maxDailyCalls = 200;
    s.market = {
      open: true,
      nextOpen: null,
      nextClose: "2026-09-14T20:00:00Z",
    };
    const cada = RISK_PROFILES[level].scanEveryMinutes;
    assert.equal(scanEveryMinutes(s, T), cada);
    s.lastDecision = hace(cada - 1);
    assert.equal(queueSessionScan(s, T), false, `${level}: aún no toca`);
    s.lastDecision = hace(cada);
    assert.equal(queueSessionScan(s, T), true, `${level}: a los ${cada} min`);
  }
});

test("The scan slows down so the daily budget lasts until the close", () => {
  const T = Date.parse("2026-09-14T15:00:00Z");
  const s = state("aggressive");
  s.market = { open: true, nextOpen: null, nextClose: "2026-09-14T20:00:00Z" };
  s.settings.maxDailyCalls = 20;
  // 10 usadas y 3 reservadas: quedan 7 para 285 minutos, una cada 41.
  s.calls = { day: "2026-09-14", count: 10 };
  assert.equal(scanEveryMinutes(s, T), 41);
  s.lastDecision = new Date(T - 40 * 60000).toISOString();
  assert.equal(queueSessionScan(s, T), false);
  s.lastDecision = new Date(T - 41 * 60000).toISOString();
  assert.equal(queueSessionScan(s, T), true);
  s.queue = [];
  // Solo quedan las reservadas para vigilancias, órdenes y revisiones.
  s.calls.count = 17;
  s.lastDecision = null;
  assert.equal(scanEveryMinutes(s, T), null);
  assert.equal(queueSessionScan(s, T), false);
  // Las llamadas de otro día no cuentan.
  s.calls = { day: "2026-09-13", count: 17 };
  assert.equal(scanEveryMinutes(s, T), 17, "17 libres para 285 minutos");
  s.settings.maxDailyCalls = 200;
  assert.equal(scanEveryMinutes(s, T), 10, "con presupuesto, el del nivel");
});

const rawStory = (storyId: string) => ({
  id: storyId,
  created_at: now(),
  source: "benzinga",
  headline: "Titular sobre Apple",
  summary: "Resumen",
  symbols: ["AAPL"],
  url: "https://ejemplo.test",
});
test("With the active and aggressive levels news does not wake the agent", () => {
  for (const level of LEVELS) {
    const s = state(level);
    applyNews(s, [rawStory("1")]);
    assert.equal(s.stories.length, 1, `${level}: la noticia se guarda`);
    assert.equal(
      s.queue.length,
      RISK_PROFILES[level].newsWakesAgent ? 1 : 0,
      `${level}: ${RISK_PROFILES[level].newsWakesAgent ? "despierta" : "no despierta"}`,
    );
  }
  const activo = state("active");
  applyNews(activo, [rawStory("1")]);
  assert.match(activo.events[0].message, /próxima revisión/);
  // Con la bolsa abierta tampoco la cuenta el repaso de la apertura.
  assert.equal(queueNewsBeforeOpen(activo), false);
  // La siguiente evaluación recibe la noticia con su ref para comentarla.
  const n = context(activo, "Revisión periódica del mercado").news;
  assert.equal(n[0].ref, "N1");
  // Antes de la apertura el repaso se mantiene.
  const antes = state("aggressive");
  antes.market = {
    open: false,
    nextOpen: new Date(Date.now() + 20 * 60000).toISOString(),
    nextClose: new Date(Date.now() + 410 * 60000).toISOString(),
  };
  applyNews(antes, [rawStory("2")]);
  assert.equal(antes.queue.length, 0);
  assert.equal(queueNewsBeforeOpen(antes), true);
  assert.equal(antes.queue[0].trigger, "preopen");
  // Sin calendario no se sabe si está abierta: se despierta, como siempre.
  const sinCalendario = state("active");
  sinCalendario.feeds.clock = false;
  applyNews(sinCalendario, [rawStory("3")]);
  assert.equal(sinCalendario.queue.length, 1);
});

test("Repeated waits reach the model as a single summary", () => {
  const T = Date.parse("2026-09-15T19:00:00Z");
  const a = (horas: number) => new Date(T + horas * 3600000).toISOString();
  const compra = decision({
    at: a(-1),
    proposal: proposal({ action: "buy" }),
    status: "filled",
  });
  const esperas = [0, 1, 2, 3].map((h) =>
    decision({ at: a(h), proposal: waiting(`Nota número ${h} para el dueño`) }),
  );
  const lista = recentDecisions([compra, ...esperas], 8);
  assert.equal(lista.length, 2);
  assert.equal((lista[0] as any).id, compra.id, "la compra va entera");
  const resumen = lista[1] as any;
  assert.match(resumen.summary, /esperó 4 veces seguidas/);
  assert.match(
    resumen.summary,
    /el 15\/09 15:00 y el 15\/09 18:00 \(hora de Nueva York\)/,
  );
  assert.equal(resumen.waits, 4);
  assert.equal(resumen.lastNote, "Nota número 3 para el dueño");
  assert.equal(resumen.proposal, undefined, "sin el razonamiento que copiar");
  // Una espera sola va entera, igual que una espera seguida de una orden.
  assert.equal(recentDecisions([compra, esperas[0]], 8).length, 2);
  assert.equal(
    (recentDecisions([compra, esperas[0]], 8)[1] as any).id,
    esperas[0].id,
  );
  assert.equal(recentDecisions([...esperas, compra], 8).length, 5);
  // El resumen ocupa un hueco; el resto son las anteriores.
  const muchas = Array.from({ length: 10 }, () =>
    decision({ proposal: proposal({ action: "buy" }) }),
  );
  const corta = recentDecisions([...muchas, ...esperas], 4);
  assert.equal(corta.length, 4);
  assert.equal((corta[2] as any).id, muchas[9].id);
  assert.equal(recentDecisions([...muchas, ...esperas], 0).length, 0);
  // Y así llega al modelo.
  const s = state();
  s.decisions = [compra, ...esperas];
  const input = context(s, "Revisión periódica del mercado");
  assert.equal(input.recentDecisions.length, 2);
  assert.doesNotMatch(
    JSON.stringify(input.recentDecisions),
    /Nota número [012]/,
    "las esperas anteriores no llegan",
  );
});

// Una sesión de 5 minutos ya resumida, cayendo: por debajo del vwap y con la
// última hora negativa.
const cayendo = (date: string, over: Partial<Intraday> = {}): Intraday => ({
  at: now(),
  date,
  source: "prueba",
  bars: [],
  open: 205,
  high: 206,
  low: 195,
  last: 198,
  vwap: 200,
  changeFromOpenPct: -3.4,
  change30mPct: -0.5,
  change60mPct: -1.2,
  positionInDayRangePct: 27,
  barsUsed: 60,
  ...over,
});
test("Active and aggressive may also wait when every symbol falls and there is nothing to reduce", () => {
  for (const level of ["active", "aggressive"] as const) {
    const t = riskInstructions(state(level));
    assert.match(t, /\(4\) Todo cae y no hay nada que reducir/);
    assert.match(
      t,
      /last está por debajo de vwap y change60mPct es menor que 0/,
    );
    assert.match(t, /date igual a clock\.todayNewYork/);
    assert.match(t, /no tienes acciones de ninguno de esos activos/);
    assert.match(t, /risk\.allFallingNothingToReduce/);
  }
  for (const level of ["prudent", "balanced"] as const)
    assert.doesNotMatch(riskInstructions(state(level)), /\(4\)/);

  // Lunes 14 de septiembre de 2026 a las 11:00 en Nueva York.
  const T = Date.parse("2026-09-14T15:00:00Z");
  const hoy = "2026-09-14";
  const s = state("aggressive");
  s.settings.symbols = ["AAPL", "MSFT"];
  s.intraday = { AAPL: cayendo(hoy), MSFT: cayendo(hoy) };
  assert.equal(allFallingNothingToReduce(s, T), true);
  const conMsft = (over: Partial<Intraday> | null) => {
    const x = structuredClone(s);
    if (over === null) delete x.intraday.MSFT;
    else x.intraday.MSFT = cayendo(hoy, over);
    return allFallingNothingToReduce(x, T);
  };
  assert.equal(conMsft({ last: 201 }), false, "por encima del vwap");
  assert.equal(conMsft({ last: 200 }), false, "justo en el vwap");
  assert.equal(conMsft({ change60mPct: 0 }), false, "la última hora no cae");
  assert.equal(conMsft({ vwap: null }), false, "sin vwap");
  assert.equal(conMsft({ change60mPct: null }), false, "sin la última hora");
  assert.equal(conMsft({ date: "2026-09-11" }), false, "sesión de otro día");
  assert.equal(conMsft(null), false, "sin datos de un activo");
  // Con acciones que vender no vale: primero se reduce.
  s.positions = [{ symbol: "AAPL", qty: "3", market_value: "594" }];
  assert.equal(allFallingNothingToReduce(s, T), false);
  // Una posición de un activo que ya no está permitido no se puede vender.
  s.positions = [{ symbol: "TSLA", qty: "3", market_value: "900" }];
  assert.equal(allFallingNothingToReduce(s, T), true);
  // Y así llega al modelo, calculado con la hora de ahora.
  const ahora = state("active");
  ahora.settings.symbols = ["AAPL"];
  ahora.intraday = { AAPL: cayendo(newYorkDate(Date.now())) };
  const input = context(ahora, "Revisión periódica del mercado");
  assert.equal(input.risk.allFallingNothingToReduce, true);
  ahora.intraday.AAPL.change60mPct = 0.3;
  assert.equal(
    context(ahora, "Revisión periódica del mercado").risk
      .allFallingNothingToReduce,
    false,
  );
});

test("Selling more than what is held is blocked on every level", () => {
  const venta = proposal({ action: "sell", qty: 2, limitPrice: 200 });
  for (const level of LEVELS) {
    const s = state(level);
    assert.equal(
      orderGuard(s, venta),
      "No se permiten posiciones cortas",
      `${level}: sin posición`,
    );
    assert.equal(
      orderGuard(s, venta, Date.now(), negociable),
      "No se permiten posiciones cortas",
      `${level}: también al enviar`,
    );
    s.positions = [{ symbol: "AAPL", qty: "1", market_value: "200" }];
    assert.equal(
      orderGuard(s, venta),
      "No se permiten posiciones cortas",
      `${level}: más de lo que tiene`,
    );
    s.positions = [{ symbol: "AAPL", qty: "2", market_value: "400" }];
    assert.equal(orderGuard(s, venta), null, `${level}: lo que tiene`);
  }
  // Vender lo que se tiene no se frena por el umbral de pérdida ni por el
  // efectivo: es lo que baja el riesgo. Si el activo no se puede negociar, sí.
  const larga = state("prudent");
  larga.positions = [{ symbol: "AAPL", qty: "2", market_value: "400" }];
  larga.account.equity = "5000";
  larga.account.cash = "0";
  assert.equal(orderGuard(larga, venta), null);
  assert.equal(orderGuard(larga, proposal({ action: "sell", qty: 1 })), null);
  assert.match(
    orderGuard(larga, venta, Date.now(), { ...negociable, tradable: false })!,
    /no negociable/,
  );
});

test("Only open buys commit money", () => {
  const s = state("aggressive");
  s.settings.symbols = ["AAPL", "MSFT"];
  s.positions = [{ symbol: "MSFT", qty: "10", market_value: "1500" }];
  s.orders = [
    {
      symbol: "MSFT",
      side: "sell",
      status: "new",
      qty: "10",
      limit_price: "150",
    },
  ];
  const compra = proposal({ action: "buy", qty: 1, limitPrice: 200 });
  s.settings.maxExposureUsd = 1800;
  s.account.cash = "1600";
  // La venta abierta no compromete efectivo ni exposición.
  assert.equal(orderGuard(s, compra), null);
  // Una compra abierta sí: 1.500 comprometidos más 200 no caben en 1.600.
  s.orders[0].side = "buy";
  assert.equal(orderGuard(s, compra), "Saldo insuficiente");
  s.account.cash = "10000";
  assert.equal(orderGuard(s, compra), "Límite de exposición");
});

test("Each order stores what it means with the positions of the moment", () => {
  assert.equal(orderIntent(0, "buy", 5), "open_long");
  assert.equal(orderIntent(5, "buy", 5), "add_long");
  assert.equal(orderIntent(5, "sell", 2), "reduce_long");
  assert.equal(orderIntent(5, "sell", 5), "close_long");
  assert.equal(orderIntent(5, "sell", 6), "exceeds_position");
  assert.equal(orderIntent(0, "sell", 5), "exceeds_position");
  // Las mismas etiquetas que muestra el panel.
  assert.deepEqual(INTENT_LABELS, {
    open_long: "Compra",
    add_long: "Amplía compra",
    reduce_long: "Venta parcial",
    close_long: "Venta",
  });
  const guardar = (s: State, p: ReturnType<typeof proposal>) =>
    applyDecision(s, job(s), { input: {}, proposal: p, tokens: 1 }, true);
  const sinAcciones = guardar(
    state("aggressive"),
    proposal({ action: "sell", qty: 2 }),
  );
  assert.equal(sinAcciones.status, "blocked");
  assert.equal(sinAcciones.error, "No se permiten posiciones cortas");
  assert.equal(sinAcciones.intent, undefined);
  const l = state("balanced");
  l.positions = [{ symbol: "AAPL", qty: "3", market_value: "600" }];
  assert.equal(
    guardar(l, proposal({ action: "sell", qty: 1 })).intent,
    "reduce_long",
  );
  assert.equal(guardar(state(), waiting()).intent, undefined);
  const c = state("aggressive");
  assert.equal(
    guardar(c, proposal({ action: "buy", qty: 1 })).intent,
    "open_long",
  );
});

test("A sale that no longer has its shares when sending is not sent", () => {
  // Decidió cerrar un largo; entre medias se vendió y ya no quedan acciones.
  const s = state("aggressive");
  s.positions = [{ symbol: "AAPL", qty: "2", market_value: "400" }];
  const d = applyDecision(
    s,
    job(s),
    { input: {}, proposal: proposal({ action: "sell", qty: 2 }), tokens: 1 },
    true,
  );
  assert.equal(d.intent, "close_long");
  s.positions = [];
  assert.equal(claimIntent(s, true), null);
  assert.equal(d.status, "blocked");
  assert.equal(d.error, "No se permiten posiciones cortas");
  // Abrir y ampliar son compras: se envía y se anota lo de ahora.
  const b = state("aggressive");
  const compra = applyDecision(
    b,
    job(b),
    { input: {}, proposal: proposal({ action: "buy", qty: 1 }), tokens: 1 },
    true,
  );
  assert.equal(compra.intent, "open_long");
  b.positions = [{ symbol: "AAPL", qty: "1", market_value: "200" }];
  assert.ok(claimIntent(b, true));
  assert.equal(compra.intent, "add_long");
});

test("Old decisions with a short intent are still read as a sale or a purchase", () => {
  // Guardadas cuando el nivel agresivo vendía en corto. El tipo ya no las admite,
  // pero siguen en la base de datos.
  const antigua = (intent: string, over: Partial<Decision> = {}): Decision =>
    ({ ...decision(over), intent }) as unknown as Decision;
  const s = state("aggressive");
  const corto = antigua("open_short", {
    proposal: proposal({ action: "sell", qty: 5, limitPrice: 200 }),
    status: "filled",
  });
  const recompra = antigua("close_short", {
    proposal: proposal({ action: "buy", qty: 5, limitPrice: 190 }),
    status: "filled",
    review: { at: now(), text: "Salió bien por el proceso", price: 185 },
  });
  assert.equal(knownIntent("open_short"), undefined);
  assert.equal(knownIntent("reduce_long"), "reduce_long");
  assert.equal(intentLabel("open_short", "sell"), "Venta");
  assert.equal(intentLabel("close_short", "buy"), "Compra");
  assert.equal(intentLabel("reduce_long", "sell"), "Venta parcial");
  // Avisos.
  assert.match(decisionNotice(s, corto)!.text, /🔴 VENTA · AAPL/);
  assert.match(decisionNotice(s, corto)!.text, /a 200,00 USD como mínimo/);
  assert.match(
    orderNotice(s, corto, "filled")!.text,
    /Venta de 5 a 200,00 USD/,
  );
  assert.match(decisionNotice(s, recompra)!.text, /🟢 COMPRA · AAPL/);
  assert.match(orderNotice(s, recompra, "filled")!.text, /Compra de 5/);
  assert.match(reviewNotice(s, recompra)!.text, /Revisión · Compra · AAPL/);
  for (const aviso of [
    decisionNotice(s, corto)!.text,
    orderNotice(s, recompra, "filled")!.text,
    reviewNotice(s, recompra)!.text,
  ])
    assert.doesNotMatch(aviso, /corto|recompra/i);
  // Panel.
  assert.equal(decisionType(corto).text, "Venta");
  assert.equal(decisionType(corto).side, "sell");
  assert.equal(decisionType(recompra).text, "Compra");
  assert.equal(decisionType(recompra).side, "buy");
  // Modelo: la intención desconocida no llega; la acción dice qué fue.
  s.decisions = [corto, recompra];
  const recientes = context(s, "Revisión periódica del mercado")
    .recentDecisions as { intent?: string }[];
  assert.deepEqual(
    recientes.map((x) => x.intent),
    [undefined, undefined],
  );
  assert.equal(reviewContext(s, recompra).decision.intent, undefined);
  // Una pendiente de entonces se bloquea al enviarla, sin romper nada.
  const pendiente = antigua("open_short", {
    proposal: proposal({ action: "sell", qty: 2 }),
    status: "pending",
  });
  s.decisions = [pendiente];
  assert.equal(claimIntent(s, true), null);
  assert.equal(pendiente.status, "blocked");
  assert.equal(pendiente.error, "No se permiten posiciones cortas");
});
