import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  restoreState,
  settingsSchema,
  settingsUpdate,
  proposalSchema,
  orderGuard,
  orderIntent,
  riskProfileOf,
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
  applyNews,
  claimIntent,
  queueNewsBeforeOpen,
  queueSessionScan,
  scanEveryMinutes,
  type Job,
} from "../src/agent.ts";
import {
  context,
  decide,
  recentDecisions,
  riskInstructions,
} from "../src/model.ts";
import { decisionNotice, orderNotice, reviewNotice } from "../src/report.ts";
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
const shortable = {
  tradable: true,
  status: "active",
  shortable: true,
  easy_to_borrow: true,
};

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

test("Saving the limits without a risk level keeps the current one", () => {
  const actual = { ...initialState().settings, riskProfile: "active" as const };
  const { riskProfile, ...formulario } = actual;
  void riskProfile;
  assert.equal(settingsUpdate(actual, formulario).riskProfile, "active");
  assert.equal(
    settingsUpdate(actual, { ...formulario, riskProfile: "prudent" })
      .riskProfile,
    "prudent",
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
  assert.match(texto("aggressive"), /abre un corto en lugar de esperar/);
  // Tamaño sobre maxOrderUsd = 600.
  assert.match(texto("prudent"), /25 % de maxOrderUsd, unos 150 USD/);
  assert.match(texto("balanced"), /50 % de maxOrderUsd, unos 300 USD/);
  assert.match(texto("active"), /80 % de maxOrderUsd, unos 480 USD/);
  assert.match(texto("aggressive"), /100 % de maxOrderUsd, unos 600 USD/);
  // Distancia de salida en veces atr14.
  assert.match(texto("prudent"), /distancia de 1 vez el movimiento/);
  assert.match(texto("balanced"), /distancia de 1,5 veces/);
  assert.match(texto("active"), /distancia de entre 2 y 3 veces/);
  // Los cortos solo se explican donde se permiten.
  for (const level of ["prudent", "balanced", "active"] as const) {
    assert.match(texto(level), /No puedes vender en corto/);
    assert.doesNotMatch(texto(level), /shortable/);
  }
  assert.match(texto("aggressive"), /Ventas en corto permitidas/);
  assert.match(texto("aggressive"), /qty negativa/);
  assert.match(texto("aggressive"), /shortable y easy_to_borrow/);
  const conCorto = state("balanced");
  conCorto.positions = [{ symbol: "AAPL", qty: "-5", market_value: "-1000" }];
  assert.match(riskInstructions(conCorto), /puedes recomprarlas con buy/i);
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
  assert.equal(input.risk.shorts, false);
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

test("Shorts are allowed only on a level with shorts, a shortable asset and an account that allows them", () => {
  const venta = proposal({ action: "sell", qty: 2, limitPrice: 200 });
  assert.equal(orderGuard(state("aggressive"), venta), null, "abre un corto");
  assert.equal(
    orderGuard(state("aggressive"), venta, Date.now(), shortable),
    null,
  );
  for (const level of ["prudent", "balanced", "active"] as const)
    assert.equal(
      orderGuard(state(level), venta),
      "No se permiten posiciones cortas",
      `${level}: el motivo de siempre`,
    );
  assert.match(
    orderGuard(state("aggressive"), venta, Date.now(), {
      ...shortable,
      shortable: false,
    })!,
    /no permite vender este activo en corto/,
  );
  assert.match(
    orderGuard(state("aggressive"), venta, Date.now(), {
      ...shortable,
      easy_to_borrow: false,
    })!,
    /no permite vender este activo en corto/,
  );
  assert.match(
    orderGuard(state("aggressive"), venta, Date.now(), {
      ...shortable,
      tradable: false,
    })!,
    /no negociable/,
  );
  const cuenta = state("aggressive");
  cuenta.account.shorting_enabled = false;
  assert.match(
    orderGuard(cuenta, venta)!,
    /no tiene activadas las ventas en corto/,
  );
  // Vender lo que se tiene no necesita que el activo admita cortos.
  const larga = state("balanced");
  larga.positions = [{ symbol: "AAPL", qty: "2", market_value: "400" }];
  assert.equal(
    orderGuard(larga, venta, Date.now(), { ...shortable, shortable: false }),
    null,
  );
});

test("A short counts in absolute value for position, exposure and cash", () => {
  const s = state("aggressive");
  s.settings.symbols = ["AAPL", "MSFT"];
  s.positions = [
    { symbol: "AAPL", qty: "-5", market_value: "-1000", side: "short" },
  ];
  const amplia = proposal({ action: "sell", qty: 1, limitPrice: 200 });
  s.settings.maxPositionUsd = 1100;
  assert.equal(orderGuard(s, amplia), "Límite por posición");
  s.settings.maxPositionUsd = 1200;
  assert.equal(orderGuard(s, amplia), null);
  s.settings.maxExposureUsd = 1100;
  assert.equal(orderGuard(s, amplia), "Límite de exposición");
  s.settings.maxExposureUsd = 2000;
  // Lo cobrado al vender en corto está en el efectivo, pero se debe.
  s.account.cash = "1100";
  assert.equal(orderGuard(s, amplia), "Saldo insuficiente");
  s.account.cash = "10000";
  // Una orden de venta abierta sin posición larga abre un corto: compromete.
  s.positions = [];
  s.orders = [
    {
      symbol: "MSFT",
      side: "sell",
      status: "new",
      qty: "10",
      limit_price: "150",
    },
  ];
  s.settings.maxExposureUsd = 1600;
  assert.equal(orderGuard(s, amplia), "Límite de exposición");
  // Una compra abierta que recompra un corto no compromete nada.
  s.positions = [{ symbol: "MSFT", qty: "-10", market_value: "-1500" }];
  s.orders[0].side = "buy";
  s.settings.maxExposureUsd = 1800;
  assert.equal(orderGuard(s, amplia), null);
});

test("One order never goes from long to short or from short to long", () => {
  const larga = state("aggressive");
  larga.positions = [{ symbol: "AAPL", qty: "2", market_value: "400" }];
  const tres = proposal({ action: "sell", qty: 3 });
  assert.match(orderGuard(larga, tres)!, /de largo a corto.*las 2 acciones/);
  larga.settings.riskProfile = "balanced";
  assert.equal(orderGuard(larga, tres), "No se permiten posiciones cortas");
  const corta = state("aggressive");
  corta.positions = [{ symbol: "AAPL", qty: "-2", market_value: "-400" }];
  assert.match(
    orderGuard(corta, proposal({ action: "buy", qty: 3 }))!,
    /de corto a largo.*las 2 acciones/,
  );
  // Recomprar se permite en cualquier nivel, también pasado el umbral de pérdida
  // y sin efectivo: es lo que baja el riesgo.
  corta.settings.riskProfile = "prudent";
  corta.account.equity = "5000";
  corta.account.cash = "0";
  assert.equal(orderGuard(corta, proposal({ action: "buy", qty: 2 })), null);
  assert.equal(orderGuard(corta, proposal({ action: "buy", qty: 1 })), null);
});

test("Each order stores what it means with the positions of the moment", () => {
  assert.equal(orderIntent(0, "buy", 5), "open_long");
  assert.equal(orderIntent(5, "buy", 5), "add_long");
  assert.equal(orderIntent(5, "sell", 2), "reduce_long");
  assert.equal(orderIntent(5, "sell", 5), "close_long");
  assert.equal(orderIntent(5, "sell", 6), "long_to_short");
  assert.equal(orderIntent(0, "sell", 5), "open_short");
  assert.equal(orderIntent(-5, "sell", 5), "add_short");
  assert.equal(orderIntent(-5, "buy", 2), "reduce_short");
  assert.equal(orderIntent(-5, "buy", 5), "close_short");
  assert.equal(orderIntent(-5, "buy", 6), "short_to_long");
  // Las mismas etiquetas que muestra el panel.
  assert.deepEqual(INTENT_LABELS, {
    open_long: "Compra",
    add_long: "Amplía compra",
    reduce_long: "Venta parcial",
    close_long: "Venta",
    open_short: "Venta en corto",
    add_short: "Amplía corto",
    reduce_short: "Reduce corto",
    close_short: "Recompra",
  });
  const guardar = (s: State, p: ReturnType<typeof proposal>) =>
    applyDecision(s, job(s), { input: {}, proposal: p, tokens: 1 }, true);
  const s = state("aggressive");
  const corto = guardar(s, proposal({ action: "sell", qty: 2 }));
  assert.equal(corto.status, "pending");
  assert.equal(corto.intent, "open_short");
  const r = state("balanced");
  r.positions = [{ symbol: "AAPL", qty: "-2", market_value: "-400" }];
  assert.equal(
    guardar(r, proposal({ action: "buy", qty: 2 })).intent,
    "close_short",
  );
  const l = state("balanced");
  l.positions = [{ symbol: "AAPL", qty: "3", market_value: "600" }];
  assert.equal(
    guardar(l, proposal({ action: "sell", qty: 1 })).intent,
    "reduce_long",
  );
  assert.equal(guardar(state(), waiting()).intent, undefined);
  const cruce = state("aggressive");
  cruce.positions = [{ symbol: "AAPL", qty: "1", market_value: "200" }];
  const bloqueada = guardar(cruce, proposal({ action: "sell", qty: 2 }));
  assert.equal(bloqueada.status, "blocked");
  assert.equal(bloqueada.intent, undefined);
});

test("An order whose meaning changed before sending is not sent", () => {
  // Decidió cerrar un largo; entre medias se vendió y ahora abriría un corto.
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
  assert.match(d.error!, /ya no significa lo mismo/);
  // Abrir o ampliar significan lo mismo: se envía y se anota lo de ahora.
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

test("Notices say short sale and buyback instead of sell and buy", () => {
  const s = state("aggressive");
  const corto = decision({
    proposal: proposal({ action: "sell", qty: 5, limitPrice: 200 }),
    intent: "open_short",
    status: "pending",
  });
  const aviso = decisionNotice(s, corto)!;
  assert.match(aviso.text, /VENTA EN CORTO · AAPL/);
  assert.match(aviso.text, /5 acciones a 200,00 USD como mínimo/);
  s.positions = [
    {
      symbol: "AAPL",
      qty: "-5",
      side: "short",
      market_value: "-1000",
      unrealized_pl: "12",
    },
  ];
  const ejecutada = orderNotice(s, corto, "filled")!;
  assert.match(ejecutada.text, /Venta en corto de 5 a 200,00 USD/);
  assert.match(
    ejecutada.text,
    /Ahora debes 5 de AAPL \(posición corta\), valen 1\.?000,00 USD/,
  );
  const recompra = decision({
    proposal: proposal({ action: "buy", qty: 5, limitPrice: 190 }),
    intent: "close_short",
    status: "filled",
    review: {
      at: now(),
      text: "El corto salió bien por el proceso",
      price: 185,
    },
  });
  assert.match(decisionNotice(s, recompra)!.text, /RECOMPRA · AAPL/);
  assert.match(decisionNotice(s, recompra)!.text, /como máximo/);
  assert.match(orderNotice(s, recompra, "filled")!.text, /Recompra de 5/);
  assert.match(reviewNotice(s, recompra)!.text, /Revisión · Recompra · AAPL/);
  // Una decisión anterior a la intención se nombra como antes.
  const antigua = decision({
    proposal: proposal({ action: "buy" }),
    status: "filled",
  });
  assert.match(decisionNotice(s, antigua)!.text, /COMPRA · AAPL/);
  assert.match(orderNotice(s, antigua, "filled")!.text, /Compra de 1/);
});
