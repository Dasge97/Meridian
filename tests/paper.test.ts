import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  orderGuard,
  proposalSchema,
  id,
  type Decision,
  type State,
} from "../src/domain.ts";
import {
  acceptInternalOrder,
  simulateFills,
  markInternal,
  cancelOpenInternal,
  replayFills,
  startingBookFrom,
  bookOf,
  comparisonStart,
  INTERNAL_ORDERS_KEPT,
} from "../src/paper.ts";
// 10:00 en Nueva York, con la sesión abierta hasta las 16:00.
const T0 = Date.parse("2026-09-16T14:00:00.000Z");
const CLOSE = "2026-09-16T20:00:00.000Z";
const iso = (t: number) => new Date(t).toISOString();
function internal(cash = 100000, positions: any[] = [], t = T0): State {
  const s = initialState();
  s.paused = false;
  s.settings = {
    ...s.settings,
    symbols: ["AAPL", "MSFT", "SPY"],
    maxOrderUsd: 5000,
    maxPositionUsd: 15000,
    maxExposureUsd: 40000,
    maxDailyOrders: 10,
  };
  s.market = { open: true, nextOpen: null, nextClose: CLOSE };
  Object.assign(
    s,
    startingBookFrom({
      account: { cash: String(cash), equity: String(cash) },
      positions,
      baseline: null,
    }),
  );
  s.quotes.AAPL = { price: 200, at: iso(t) };
  markInternal(s, t);
  return s;
}
function tick(s: State, symbol: string, price: number, t: number) {
  s.quotes[symbol] = { price, at: iso(t) };
}
const proposal = (over: Record<string, unknown> = {}) =>
  proposalSchema.parse({
    action: "buy",
    symbol: "AAPL",
    qty: 10,
    limitPrice: 200,
    reason: "Hipótesis basada en precio",
    hypothesis: "Esperar confirmación",
    reviewAfterHours: 24,
    notify: false,
    note: "Sin novedad que contar al propietario",
    watches: [],
    lessons: [],
    ...over,
  });
// Una decisión ya reservada por claimIntent, aceptada en la misma transacción.
function place(
  s: State,
  action: "buy" | "sell",
  qty: number,
  limitPrice: number,
  t: number,
  symbol = "AAPL",
) {
  const d: Decision = {
    id: id(),
    at: iso(t),
    versionId: s.activeVersion,
    event: "Prueba",
    input: null,
    proposal: proposal({ action, qty, limitPrice, symbol }),
    status: "submitting",
    sentAt: iso(t),
    reviewAt: iso(t + 86400000),
  };
  s.decisions.push(d);
  const order = acceptInternalOrder(s, d, t);
  return { d, order };
}
const held = (s: State, symbol = "AAPL") =>
  s.positions.find((x) => x.symbol === symbol);

test("A buy executable on arrival fills at the last price", () => {
  const s = internal();
  const { d, order } = place(s, "buy", 10, 201, T0);
  assert.equal(order.status, "filled");
  assert.equal(order.filled_avg_price, 200, "mejor que su límite");
  assert.equal(order.filled_qty, 10);
  assert.equal(s.account.cash, 98000);
  assert.equal(s.account.equity, 100000);
  assert.equal(held(s).qty, 10);
  assert.equal(held(s).avg_entry_price, 200);
  assert.equal(s.fills.length, 1);
  assert.equal(s.fills[0].rule, "arrival");
  assert.equal(s.fills[0].decisionId, d.id);
  assert.equal(s.fills[0].cashAfter, 98000);
  assert.equal(d.status, "filled");
  assert.equal(d.orderId, order.id);
  assert.match(s.queue[0].reason, /Orden ejecutada/);
  assert.ok(s.events.some((e) => e.message === "AAPL: filled"));
});

test("A resting buy fills later at its limit, not at the price seen", () => {
  const s = internal();
  const { d, order } = place(s, "buy", 10, 199, T0);
  assert.equal(order.status, "new");
  assert.equal(d.status, "new");
  assert.equal(order.expires_at, CLOSE);
  assert.equal(s.queue.length, 0);
  tick(s, "AAPL", 199.5, T0 + 2000);
  simulateFills(s, T0 + 2000);
  assert.equal(order.status, "new", "aún no cruza");
  tick(s, "AAPL", 198.4, T0 + 4000);
  simulateFills(s, T0 + 4000);
  assert.equal(order.status, "filled");
  assert.equal(order.filled_avg_price, 199);
  assert.equal(s.fills[0].rule, "resting");
  assert.equal(s.account.cash, 98010);
  assert.equal(d.status, "filled");
});

test("A sell fills when the price reaches or passes its limit", () => {
  const s = internal();
  place(s, "buy", 10, 200, T0);
  const resting = place(s, "sell", 5, 205, T0 + 1000).order;
  assert.equal(resting.status, "new");
  tick(s, "AAPL", 204.99, T0 + 2000);
  simulateFills(s, T0 + 2000);
  assert.equal(resting.status, "new");
  tick(s, "AAPL", 205, T0 + 3000);
  simulateFills(s, T0 + 3000);
  assert.equal(resting.status, "filled", "igual al límite también cruza");
  assert.equal(resting.filled_avg_price, 205);
  tick(s, "AAPL", 210, T0 + 4000);
  const arrival = place(s, "sell", 5, 206, T0 + 4000).order;
  assert.equal(arrival.filled_avg_price, 210, "al llegar, el último precio");
});

test("No fill without session, with a stale, future or pre-open price, or with a tick older than the order", () => {
  // Sesión cerrada.
  let s = internal();
  s.market = { open: false, nextOpen: null, nextClose: CLOSE };
  assert.equal(place(s, "buy", 1, 201, T0).order.status, "new");
  // Precio de más de 90 s.
  s = internal();
  tick(s, "AAPL", 200, T0 - 91000);
  assert.equal(place(s, "buy", 1, 201, T0).order.status, "new");
  // Precio adelantado más de 5 s.
  s = internal();
  tick(s, "AAPL", 200, T0 + 6000);
  assert.equal(place(s, "buy", 1, 201, T0).order.status, "new");
  // Operación de IEX anterior a la apertura de Nueva York (09:29:50).
  const apertura = Date.parse("2026-09-16T13:30:20.000Z");
  s = internal(100000, [], apertura);
  tick(s, "AAPL", 200, Date.parse("2026-09-16T13:29:50.000Z"));
  assert.equal(place(s, "buy", 1, 201, apertura).order.status, "new");
  // Una orden que espera no se ejecuta con un tick de antes de su envío.
  s = internal();
  const { order } = place(s, "buy", 1, 199, T0 + 10000);
  tick(s, "AAPL", 198, T0 + 5000);
  simulateFills(s, T0 + 12000);
  assert.equal(order.status, "new");
  tick(s, "AAPL", 198, T0 + 10000);
  simulateFills(s, T0 + 12000);
  assert.equal(order.status, "new", "tampoco con uno de la misma hora");
  tick(s, "AAPL", 198, T0 + 11000);
  simulateFills(s, T0 + 12000);
  assert.equal(order.status, "filled");
  assert.equal(order.filled_avg_price, 199);
});

test("Open orders expire at the close even without a calendar", () => {
  const s = internal();
  const { d, order } = place(s, "buy", 1, 150, T0);
  s.feeds.clock = false;
  s.market = { open: false, nextOpen: null, nextClose: null };
  simulateFills(s, Date.parse(CLOSE) - 1);
  assert.equal(order.status, "new");
  simulateFills(s, Date.parse(CLOSE));
  assert.equal(order.status, "expired");
  assert.equal(order.expired_at, CLOSE);
  assert.equal(d.status, "expired");
  assert.equal(s.account.cash, 100000);
  assert.equal(s.fills.length, 0);
});

test("Adding to a position averages the entry price", () => {
  const s = internal();
  place(s, "buy", 10, 200, T0);
  tick(s, "AAPL", 210, T0 + 1000);
  place(s, "buy", 10, 211, T0 + 1000);
  assert.equal(held(s).qty, 20);
  assert.equal(held(s).avg_entry_price, 205);
  assert.equal(held(s).cost_basis, 4100);
  assert.equal(held(s).market_value, 4200);
  assert.equal(held(s).unrealized_pl, 100);
  assert.equal(s.account.cash, 95900);
});

test("A partial sell realises the result and a full sell removes the position", () => {
  const s = internal();
  place(s, "buy", 20, 200, T0);
  tick(s, "AAPL", 215, T0 + 1000);
  place(s, "sell", 5, 214, T0 + 1000);
  assert.equal(s.fills[1].realizedPl, 75);
  assert.equal(held(s).qty, 15);
  assert.equal(
    held(s).avg_entry_price,
    200,
    "vender no cambia el precio medio",
  );
  assert.equal(s.account.cash, 96000 + 1075);
  place(s, "sell", 15, 215, T0 + 2000);
  assert.equal(s.fills[2].realizedPl, 225);
  assert.equal(held(s), undefined);
  assert.equal(s.account.long_market_value, 0);
  assert.equal(s.account.equity, s.account.cash);
  assert.equal(s.account.cash, 100300);
});

test("Without cash or shares the order is rejected", () => {
  const s = internal(1000);
  const compra = place(s, "buy", 10, 200, T0);
  assert.equal(compra.order.status, "rejected");
  assert.equal(compra.d.status, "rejected");
  const venta = place(s, "sell", 1, 199, T0 + 1000);
  assert.equal(venta.order.status, "rejected");
  assert.equal(s.account.cash, 1000);
  assert.equal(s.fills.length, 0);
  assert.ok(s.events.some((e) => /rechazada: falta efectivo/.test(e.message)));
  assert.ok(s.events.some((e) => /rechazada: faltan acciones/.test(e.message)));
});

// Generador sembrado (mulberry32): la secuencia es la misma en cada ejecución.
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
test("Replaying the fills rebuilds the book after a random sequence", () => {
  const rnd = seeded(20260916);
  const s = internal(20000, [
    {
      symbol: "MSFT",
      qty: "12",
      avg_entry_price: "480.123456",
      current_price: "495.5",
    },
  ]);
  const start = bookOf(s);
  const prices: Record<string, number> = { AAPL: 200, MSFT: 495, SPY: 650 };
  const symbols = Object.keys(prices);
  let t = T0;
  const estados = new Set<string>();
  for (let step = 0; step < 600; step++) {
    t += 1000 + Math.floor(rnd() * 20000);
    s.market.open = rnd() > 0.05;
    for (const symbol of symbols) {
      prices[symbol] =
        Math.round(prices[symbol] * (1 + (rnd() - 0.5) * 0.01) * 100) / 100;
      if (rnd() > 0.2) tick(s, symbol, prices[symbol], t);
    }
    if (rnd() < 0.3) {
      const symbol = symbols[Math.floor(rnd() * symbols.length)];
      const limit =
        Math.round(prices[symbol] * (1 + (rnd() - 0.5) * 0.02) * 100) / 100;
      place(
        s,
        rnd() < 0.5 ? "buy" : "sell",
        1 + Math.floor(rnd() * 15),
        limit,
        t,
        symbol,
      );
    }
    if (rnd() < 0.02) cancelOpenInternal(s, t);
    simulateFills(s, t);
    if (step % 50 === 0) markInternal(s, t);
    assert.deepEqual(replayFills(start, s.fills), bookOf(s), `paso ${step}`);
    for (const o of s.orders) estados.add(o.status);
  }
  simulateFills(s, Date.parse(CLOSE));
  assert.deepEqual(replayFills(start, s.fills), bookOf(s));
  assert.ok(s.fills.length > 20, "la secuencia ejecuta órdenes");
  assert.ok(estados.has("rejected"), "y rechaza alguna");
  assert.ok(estados.has("canceled"), "y cancela alguna");
  assert.ok(s.account.cash >= 0);
  assert.equal(
    s.orders.filter((o) => ["new"].includes(o.status)).length,
    0,
    "al cierre no queda ninguna abierta",
  );
});

test("markInternal values positions, samples equity and keeps the account synced", () => {
  const s = internal();
  assert.equal(s.equity.length, 1);
  assert.equal(s.baseline, 100000);
  place(s, "buy", 10, 200, T0);
  tick(s, "AAPL", 220, T0 + 60000);
  assert.equal(markInternal(s, T0 + 60000), null);
  assert.equal(held(s).current_price, 220);
  assert.equal(held(s).market_value, 2200);
  assert.equal(held(s).unrealized_pl, 200);
  assert.equal(held(s).unrealized_plpc, 0.1);
  assert.equal(s.account.long_market_value, 2200);
  assert.equal(s.account.equity, 100200);
  assert.equal(s.account.portfolio_value, 100200);
  assert.equal(s.account.buying_power, 98000);
  assert.equal(s.lastSync, iso(T0 + 60000));
  assert.equal(s.equity.length, 1, "una muestra cada 5 minutos");
  markInternal(s, T0 + 301000);
  assert.equal(s.equity.length, 2);
  assert.equal(s.equity[1].value, 100200);
  assert.equal(s.baseline, 100000, "el baseline no se mueve");
});

test("markInternal pauses once when the book stops adding up", () => {
  const s = internal();
  s.account.cash = -5;
  assert.match(markInternal(s, T0)!, /efectivo negativo/);
  assert.equal(s.paused, true);
  markInternal(s, T0 + 30000);
  assert.equal(
    s.events.filter((e) => /no cuadra/.test(e.message)).length,
    1,
    "no se repite el aviso",
  );
});

test("orderGuard accepts a buy on a new internal account", () => {
  const vacia = internal();
  assert.equal(orderGuard(vacia, proposal(), T0), null);
  const copia = internal(50000, [
    {
      symbol: "MSFT",
      qty: "5",
      avg_entry_price: "490",
      current_price: "495",
    },
  ]);
  assert.equal(orderGuard(copia, proposal(), T0), null);
  assert.equal(
    orderGuard(
      copia,
      proposal({ action: "sell", qty: 6, symbol: "AAPL" }),
      T0,
    ) !== null,
    true,
    "vender lo que no se tiene sigue bloqueado",
  );
});

test("Cancelling open orders updates their decisions and fills queue an evaluation", () => {
  const s = internal();
  const ejecutada = place(s, "buy", 1, 201, T0);
  const abierta = place(s, "buy", 1, 150, T0, "AAPL");
  tick(s, "MSFT", 495, T0);
  const otra = place(s, "sell", 1, 490, T0, "MSFT");
  const espera = place(s, "buy", 1, 400, T0, "MSFT");
  assert.equal(s.queue.length, 1);
  assert.match(s.queue[0].reason, new RegExp(ejecutada.d.id));
  assert.equal(cancelOpenInternal(s, T0 + 1000), 2);
  assert.equal(abierta.order.status, "canceled");
  assert.equal(abierta.order.canceled_at, iso(T0 + 1000));
  assert.equal(abierta.d.status, "canceled");
  assert.equal(espera.d.status, "canceled");
  assert.equal(otra.d.status, "rejected", "sin acciones no llegó a esperar");
  assert.equal(ejecutada.d.status, "filled", "lo ejecutado no se toca");
  assert.ok(s.events.some((e) => e.message === "AAPL: canceled"));
  assert.equal(s.queue.length, 1, "cancelar no despierta al agente");
  assert.equal(cancelOpenInternal(s, T0 + 2000), 0);
});

test("Orders are trimmed to 100 without dropping open ones", () => {
  const s = internal(10000000);
  for (let i = 0; i < 120; i++) place(s, "buy", 1, 201, T0 + i);
  const abierta = place(s, "buy", 1, 100, T0 + 200).order;
  for (let i = 0; i < 20; i++) place(s, "buy", 1, 201, T0 + 300 + i);
  assert.equal(s.orders.length, INTERNAL_ORDERS_KEPT);
  assert.equal(
    s.orders[0].submitted_at,
    iso(T0 + 319),
    "las más nuevas primero",
  );
  assert.ok(s.orders.includes(abierta));
  s.orders = s.orders.map((o) => (o === abierta ? o : { ...o, status: "new" }));
  place(s, "buy", 1, 201, T0 + 400);
  assert.equal(s.orders.length, 101, "las abiertas no se recortan");
});

test("Accepting the same decision twice does not create a second order", () => {
  const s = internal();
  const { d, order } = place(s, "buy", 1, 150, T0);
  assert.equal(acceptInternalOrder(s, d, T0 + 1000), order);
  assert.equal(s.orders.length, 1);
});

test("startingBookFrom copies cash, positions and baseline from Alpaca", () => {
  const alpaca = {
    account: { cash: "81234.5678", equity: "100100.12", status: "ACTIVE" },
    positions: [
      {
        symbol: "AAPL",
        qty: "40",
        side: "long",
        avg_entry_price: "200.123456",
        current_price: "221.5",
        market_value: "8860",
      },
      {
        symbol: "MSFT",
        qty: "20",
        avg_entry_price: "490",
        current_price: "500.2",
        market_value: "10004",
      },
    ],
    baseline: 99000,
  };
  const b = startingBookFrom(alpaca);
  assert.equal(b.account.cash, 81234.5678);
  assert.equal(b.account.id, "internal");
  assert.equal(b.account.status, "ACTIVE");
  assert.equal(b.account.long_market_value, 18864);
  assert.equal(b.account.equity, 100098.5678);
  assert.equal(b.baseline, 99000);
  assert.deepEqual(b.orders, []);
  assert.deepEqual(b.fills, []);
  assert.deepEqual(b.positions[0], {
    symbol: "AAPL",
    qty: 40,
    side: "long",
    avg_entry_price: 200.1235,
    cost_basis: 8004.94,
    current_price: 221.5,
    market_value: 8860,
    unrealized_pl: 855.06,
    unrealized_plpc: 0.106817,
  });
  assert.equal(
    startingBookFrom({ ...alpaca, baseline: null }).baseline,
    100098.5678,
  );
  const inicio = comparisonStart(alpaca, T0);
  assert.equal(inicio.startedAt, iso(T0));
  assert.equal(inicio.equity, 100100.12);
  assert.deepEqual(inicio.positions[1], {
    symbol: "MSFT",
    qty: 20,
    avgPrice: 490,
  });
  assert.throws(
    () =>
      startingBookFrom({
        ...alpaca,
        positions: [{ symbol: "SPY", qty: "-3", avg_entry_price: "650" }],
      }),
    /no es larga/,
  );
  assert.throws(
    () => startingBookFrom({ ...alpaca, account: { cash: "-10" } }),
    /efectivo negativo/,
  );
});
