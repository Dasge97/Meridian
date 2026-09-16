import { test } from "node:test";
import assert from "node:assert/strict";
import type { Usage } from "../src/domain.ts";
import type { ComparisonStart, Fill } from "../src/paper.ts";
import {
  alignCurves,
  alignSeries,
  compareSims,
  decisionStats,
  tokenStats,
  tradeStats,
  type DecisionLike,
  type SimInput,
} from "../src/compare.ts";

const T0 = Date.parse("2026-09-16T14:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60000).toISOString();
const p = (min: number, value: number) => ({ at: at(min), value });
let n = 0;
const fill = (over: Partial<Fill> & Pick<Fill, "side">): Fill => ({
  orderId: `o${++n}`,
  symbol: "AAPL",
  qty: 10,
  price: 100,
  at: at(n),
  realizedPl: 0,
  rule: "arrival",
  ...over,
});
const start = (over: Partial<ComparisonStart> = {}): ComparisonStart => ({
  startedAt: at(0),
  equity: 100000,
  cash: 90000,
  positions: [],
  ...over,
});
const decision = (over: Partial<DecisionLike> = {}): DecisionLike => ({
  at: at(1),
  status: "observed",
  proposal: { action: "wait" },
  ...over,
});

test("alignSeries lines up uneven marks with the last known value", () => {
  const a = [p(0, 100), p(10, 110), p(30, 90)];
  const b = [p(5, 200), p(30, 220)];
  const r = alignSeries(a, b, null);
  assert.deepEqual(r.at, [at(0), at(5), at(10), at(30)]);
  assert.deepEqual(r.values.a, [100, 100, 110, 90]);
  // b empieza más tarde: sin valor hasta su primera marca.
  assert.deepEqual(r.values.b, [null, 200, 200, 220]);
  assert.deepEqual(r.base, { a: 100, b: 200 });
  assert.deepEqual(r.indexed.a, [100, 100, 110, 90]);
  assert.deepEqual(r.indexed.b, [null, 100, 100, 110]);
});

test("alignSeries fills gaps and starts at from with the value carried in", () => {
  // Un hueco de horas en a y from en mitad de las dos curvas.
  const a = [p(0, 100), p(5, 105), p(300, 120)];
  const b = [p(2, 50), p(7, 55), p(8, 60), p(290, 40)];
  const r = alignSeries(a, b, at(6));
  assert.deepEqual(r.at, [at(6), at(7), at(8), at(290), at(300)]);
  assert.deepEqual(r.values.a, [105, 105, 105, 105, 120]);
  assert.deepEqual(r.values.b, [50, 55, 60, 40, 40]);
  assert.deepEqual(r.indexed.a, [100, 100, 100, 100, 114.2857]);
  assert.deepEqual(r.indexed.b, [100, 110, 120, 80, 80]);
  // Una marca exacta en from no se repite.
  assert.deepEqual(alignSeries(a, b, at(5)).at.slice(0, 2), [at(5), at(7)]);
  // from en milisegundos vale igual que en ISO.
  assert.deepEqual(alignSeries(a, b, T0 + 6 * 60000), r);
});

test("alignSeries ignores stored order, repeated marks and bad points", () => {
  const a = [
    p(10, 110),
    p(0, 100),
    { at: "no es fecha", value: 1 },
    { at: at(5), value: "105" as any },
    { at: at(6), value: NaN },
    null as any,
    p(10, 111),
  ];
  const r = alignSeries(a, [], null);
  assert.deepEqual(r.at, [at(0), at(10)]);
  assert.deepEqual(r.values.a, [100, 111]);
  assert.deepEqual(r.values.b, [null, null]);
  assert.equal(r.base.b, null);
  // Una base a cero no da índice.
  assert.deepEqual(alignSeries([p(0, 0), p(1, 5)], [], null).indexed.a, [
    null,
    null,
  ]);
});

test("alignSeries with empty lists or a future from is empty", () => {
  const vacio = { at: [], values: { a: [], b: [] }, indexed: { a: [], b: [] } };
  const { base, ...r } = alignSeries([], [], null);
  assert.deepEqual(r, vacio);
  assert.deepEqual(base, { a: null, b: null });
  const futuro = alignSeries([p(0, 1)], [p(1, 2)], at(60 * 24 * 365));
  assert.deepEqual(futuro.at, []);
  assert.deepEqual(futuro.base, { a: null, b: null });
  // to corta lo posterior.
  assert.deepEqual(
    alignCurves({ x: [p(0, 1), p(10, 2)] }, null, at(5)).values.x,
    [1],
  );
});

test("tradeStats uses average cost across partial sells", () => {
  const fills = [
    fill({ side: "buy", qty: 10, price: 100, at: at(1) }),
    fill({ side: "buy", qty: 10, price: 110, at: at(2) }),
    fill({ side: "sell", qty: 5, price: 120, at: at(3) }),
    fill({ side: "sell", qty: 10, price: 100, at: at(4) }),
    fill({ side: "sell", qty: 5, price: 105.5, at: at(5) }),
  ];
  const r = tradeStats(fills, start());
  assert.equal(r.orders, 5);
  assert.equal(r.buys, 2);
  assert.equal(r.sells, 3);
  assert.equal(r.pricedSells, 3);
  // Coste medio 105: +75, -50, +2,5.
  assert.equal(r.realizedPl, 27.5);
  assert.equal(r.winningSells, 2);
  assert.equal(r.winRate, 0.6667);
  assert.equal(r.largestGain?.realizedPl, 75);
  assert.equal(r.largestGain?.avgPrice, 105);
  assert.equal(r.largestLoss?.realizedPl, -50);
  assert.equal(r.largestLoss?.orderId, fills[3].orderId);
  assert.equal(r.unpricedSells, 0);
  assert.equal(r.ignored, 0);
  // Sin orden guardado: el resultado es el mismo.
  assert.deepEqual(tradeStats([...fills].reverse(), start()), r);
});

test("tradeStats counts inherited positions from the comparison start", () => {
  const inicio = start({
    positions: [{ symbol: "MSFT", qty: 20, avgPrice: 400 }],
  });
  const fills = [
    fill({ side: "sell", symbol: "MSFT", qty: 5, price: 410, at: at(1) }),
  ];
  const r = tradeStats(fills, inicio);
  assert.equal(r.realizedPl, 50);
  assert.equal(r.winningSells, 1);
  assert.equal(r.unpricedSells, 0);
  // Sin punto de partida no se sabe a cuánto se compró.
  const sin = tradeStats(fills, null);
  assert.equal(sin.sells, 1);
  assert.equal(sin.pricedSells, 0);
  assert.equal(sin.unpricedSells, 1);
  assert.equal(sin.winRate, null);
  assert.equal(sin.realizedPl, 0);
  // Las anteriores al inicio ya están dentro del libro de partida.
  const antigua = fill({ side: "buy", symbol: "MSFT", at: at(-5) });
  assert.deepEqual(tradeStats([antigua, ...fills], inicio), {
    ...r,
    ignored: 1,
  });
});

test("tradeStats keeps manual orders apart but in the book", () => {
  const fills = [
    fill({ side: "buy", qty: 10, price: 100, at: at(1), manual: true }),
    fill({ side: "buy", qty: 10, price: 120, at: at(2) }),
    fill({ side: "sell", qty: 10, price: 130, at: at(3) }),
    fill({ side: "sell", qty: 10, price: 90, at: at(4), manual: true }),
  ];
  const r = tradeStats(fills, start());
  assert.equal(r.orders, 2);
  assert.equal(r.buys, 1);
  assert.equal(r.sells, 1);
  // La compra manual baja el coste medio a 110.
  assert.equal(r.realizedPl, 200);
  assert.equal(r.winningSells, 1);
  assert.equal(r.winRate, 1);
  assert.equal(r.largestLoss, null);
  assert.deepEqual(r.manual, {
    orders: 2,
    buys: 1,
    sells: 1,
    realizedPl: -200,
  });
});

test("tradeStats without sells, with one, with from and with bad data", () => {
  const compras = [fill({ side: "buy", at: at(1) })];
  const sinVentas = tradeStats(compras, start());
  assert.equal(sinVentas.orders, 1);
  assert.equal(sinVentas.winRate, null);
  assert.equal(sinVentas.largestGain, null);
  assert.equal(sinVentas.largestLoss, null);

  const una = tradeStats(
    [...compras, fill({ side: "sell", price: 100, at: at(2) })],
    start(),
  );
  assert.equal(una.sells, 1);
  assert.equal(una.pricedSells, 1);
  // Sin ganar ni perder: ni acierto ni mayor pérdida.
  assert.equal(una.winRate, 0);
  assert.equal(una.largestGain, null);
  assert.equal(una.largestLoss, null);

  // from en mitad: la compra de antes da el coste pero no cuenta.
  const fills = [
    fill({ side: "buy", qty: 10, price: 50, at: at(1) }),
    fill({ side: "sell", qty: 4, price: 60, at: at(10) }),
  ];
  const mitad = tradeStats(fills, start(), at(5));
  assert.equal(mitad.orders, 1);
  assert.equal(mitad.buys, 0);
  assert.equal(mitad.realizedPl, 40);
  const futuro = tradeStats(fills, start(), at(99999));
  assert.equal(futuro.orders, 0);
  assert.equal(futuro.realizedPl, 0);

  const malas = tradeStats(
    [
      fill({ side: "buy", qty: NaN }),
      fill({ side: "buy", price: "100" as any }),
      fill({ side: "short" as any }),
      fill({ side: "buy", at: "ayer" }),
      null as any,
      fill({ side: "buy", orderId: "x", at: at(1) }),
      fill({ side: "buy", orderId: "x", at: at(2) }),
    ],
    start({ positions: [{ symbol: "AAPL", qty: "5" as any, avgPrice: 1 }] }),
  );
  assert.equal(malas.ignored, 6);
  assert.equal(malas.orders, 1);
  assert.deepEqual(tradeStats([], null), {
    ...tradeStats([], start()),
  });
  assert.equal(tradeStats(undefined as any, null).orders, 0);
});

test("tokenStats counts calls, failures and averages within the window", () => {
  const usage: Usage[] = [
    // Registro antiguo: solo at y tokens.
    { at: "2026-09-10T12:00:00.000Z", tokens: 5000 },
    { at: "2026-09-14T12:00:00.000Z", tokens: 1000 },
    { at: "2026-09-15T12:00:00.000Z", tokens: 3000, ok: true },
    { at: "2026-09-16T12:00:00.000Z", tokens: 0, ok: false, error: "429" },
    { at: "mal", tokens: 9999 },
    { at: "2026-09-16T13:00:00.000Z", tokens: NaN },
  ];
  const now = Date.parse("2026-09-16T14:00:00.000Z");
  const r = tokenStats(usage, "2026-09-14T00:00:00.000Z", undefined, now);
  assert.equal(r.calls, 4);
  assert.equal(r.failed, 1);
  assert.equal(r.tokens, 4000);
  assert.equal(r.avgPerCall, 1000);
  // 2 días y 14 horas.
  assert.equal(r.days, 2.58);
  assert.equal(r.avgPerDay, Math.round(4000 / (62 / 24)));
  const cerrada = tokenStats(
    usage,
    "2026-09-10T00:00:00.000Z",
    "2026-09-14T12:00:00.000Z",
    now,
  );
  assert.deepEqual(cerrada, {
    calls: 2,
    failed: 0,
    tokens: 6000,
    avgPerCall: 3000,
    avgPerDay: 1333,
    days: 4.5,
  });
  // Sin inicio, desde la primera llamada; menos de un día cuenta como uno.
  const corta = tokenStats(usage.slice(3, 4), null, undefined, now);
  assert.equal(corta.days, 1);
  const vacia = tokenStats([], null, undefined, now);
  assert.deepEqual(vacia, {
    calls: 0,
    failed: 0,
    tokens: 0,
    avgPerCall: 0,
    avgPerDay: 0,
    days: 1,
  });
  assert.equal(tokenStats(usage, now + 86400000, undefined, now).calls, 0);
});

test("decisionStats counts waits, blocked and sent orders from from", () => {
  const decisions = [
    decision({ at: at(-10), status: "filled", orderId: "viejo" }),
    decision(),
    decision({
      status: "blocked",
      proposal: { action: "buy" },
    }),
    decision({ status: "filled", orderId: "o", proposal: { action: "buy" } }),
    decision({
      status: "unknown",
      sentAt: at(2),
      proposal: { action: "sell" },
    }),
    decision({ at: "mal" }),
  ];
  assert.deepEqual(decisionStats(decisions, at(0)), {
    decisions: 4,
    waits: 1,
    blocked: 1,
    sent: 2,
  });
  assert.equal(decisionStats(decisions, null).sent, 3);
  assert.equal(decisionStats([], null).decisions, 0);
  assert.equal(decisionStats(decisions, at(99999)).decisions, 0);
});

test("compareSims builds the whole comparison for two simulations", () => {
  const comparison = start({
    startedAt: at(0),
    equity: 100000,
    positions: [{ symbol: "AAPL", qty: 10, avgPrice: 100 }],
  });
  const now = T0 + 120 * 60000;
  const input: Record<"alpaca" | "internal", SimInput> = {
    alpaca: {
      label: "Alpaca Paper",
      riskProfile: "balanced",
      // Historia copiada de antes del inicio y muestras cada cinco minutos.
      equity: [p(-60, 99000), p(-5, 100000), p(5, 100100), p(65, 100300)],
      fills: [
        fill({
          side: "sell",
          qty: 5,
          price: 110,
          at: at(30),
          rule: "alpaca",
        }),
        fill({ side: "buy", qty: 1, price: 50, at: at(40), manual: true }),
      ],
      comparison,
      usage: [
        { at: at(-120), tokens: 999 },
        { at: at(10), tokens: 2000, ok: true },
      ],
      decisions: [
        decision({ at: at(10) }),
        decision({
          at: at(20),
          status: "filled",
          orderId: "a1",
          proposal: { action: "sell" },
        }),
      ],
      account: { equity: "100350.5", cash: "90000" },
    },
    internal: {
      label: "Interna",
      riskProfile: "aggressive",
      equity: [p(-60, 99000), p(-5, 100000), p(3, 99900), p(62, 100500)],
      fills: [
        fill({ side: "sell", qty: 10, price: 95, at: at(20) }),
        fill({ side: "buy", qty: 20, price: 100, at: at(25) }),
      ],
      comparison,
      usage: [
        { at: at(10), tokens: 3000, ok: true },
        { at: at(20), tokens: 100, ok: false },
      ],
      decisions: [
        decision({
          at: at(10),
          status: "blocked",
          proposal: { action: "buy" },
        }),
      ],
      account: null,
    },
  };
  const r = compareSims(input, null, now);
  // Sin from, desde el inicio de la comparación.
  assert.equal(r.from, at(0));
  assert.deepEqual(r.sims, ["alpaca", "internal"]);
  assert.deepEqual(r.series.at, [at(0), at(3), at(5), at(62), at(65)]);
  assert.deepEqual(
    r.series.values.alpaca,
    [100000, 100000, 100100, 100100, 100300],
  );
  assert.deepEqual(r.series.indexed.internal, [100, 99.9, 99.9, 100.5, 100.5]);

  const a = r.bySim.alpaca;
  assert.equal(a.label, "Alpaca Paper");
  assert.equal(a.riskProfile, "balanced");
  assert.equal(a.startedAt, at(0));
  assert.deepEqual(a.result, {
    equityStart: 100000,
    // La cuenta manda sobre la última muestra.
    equityNow: 100350.5,
    usd: 350.5,
    pct: 0.3505,
    realizedPl: 50,
    unrealizedPl: 300.5,
  });
  assert.equal(a.trades.winRate, 1);
  assert.equal(a.trades.manual.buys, 1);
  assert.deepEqual(a.decisions, {
    decisions: 2,
    waits: 1,
    blocked: 0,
    sent: 1,
  });
  assert.equal(a.tokens.calls, 1);
  assert.equal(a.tokens.tokens, 2000);

  const i = r.bySim.internal;
  // Sin cuenta, la última muestra.
  assert.equal(i.result.equityNow, 100500);
  assert.equal(i.result.usd, 500);
  assert.equal(i.result.realizedPl, -50);
  assert.equal(i.result.unrealizedPl, 550);
  assert.equal(i.trades.largestLoss?.realizedPl, -50);
  assert.equal(i.trades.winRate, 0);
  assert.equal(i.decisions.blocked, 1);
  assert.deepEqual(
    { calls: i.tokens.calls, failed: i.tokens.failed, tokens: i.tokens.tokens },
    { calls: 2, failed: 1, tokens: 3100 },
  );
  // Sale tal cual por JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);

  // from en mitad: la venta de Alpaca queda fuera pero el patrimonio parte de ahí.
  const mitad = compareSims(input, at(35), now);
  assert.equal(mitad.from, at(35));
  assert.equal(mitad.bySim.alpaca.result.equityStart, 100100);
  assert.equal(mitad.bySim.alpaca.trades.sells, 0);
  assert.equal(mitad.bySim.alpaca.result.realizedPl, 0);

  // from futuro: sin periodo, sin resultado y sin cuentas.
  const futuro = compareSims(input, now + 86400000, now);
  assert.deepEqual(futuro.series.at, []);
  assert.deepEqual(futuro.bySim.alpaca.result, {
    equityStart: null,
    equityNow: null,
    usd: null,
    pct: null,
    realizedPl: 0,
    unrealizedPl: null,
  });
  assert.equal(futuro.bySim.internal.tokens.calls, 0);
  assert.equal(futuro.bySim.internal.decisions.decisions, 0);
});

test("compareSims with empty simulations and no comparison start", () => {
  const vacia: SimInput = {
    label: "Vacía",
    riskProfile: "balanced",
    equity: [],
    fills: [],
    comparison: null,
    usage: [],
    decisions: [],
    account: { equity: "" },
  };
  const r = compareSims({ alpaca: vacia, internal: vacia }, null, T0);
  assert.equal(r.from, null);
  assert.deepEqual(r.series.at, []);
  assert.equal(r.bySim.internal.startedAt, null);
  assert.equal(r.bySim.internal.result.equityNow, null);
  assert.equal(r.bySim.internal.result.usd, null);
  assert.equal(r.bySim.internal.trades.orders, 0);
  assert.equal(r.bySim.internal.tokens.avgPerDay, 0);
  // Una cuenta con patrimonio no numérico no se toma por cero.
  const rara = compareSims(
    { x: { ...vacia, equity: [p(0, 10)], account: { equity: "n/a" } } },
    "no es fecha",
    T0,
  );
  assert.equal(rara.from, null);
  assert.equal(rara.bySim.x.result.equityNow, 10);
  assert.equal(rara.bySim.x.result.usd, 0);
  assert.equal(rara.bySim.x.result.pct, 0);
});
