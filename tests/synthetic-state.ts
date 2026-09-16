// Un estado sintético con el tamaño y la forma del de producción del 16/09/2026:
// 54 decisiones con contexto, 270 eventos, 877 muestras de patrimonio, 69
// registros de consumo, 42 lecciones, 4 versiones, vigilancias activas y
// cerradas, 20 activos con su año de velas, y cuenta, posiciones y órdenes con la
// forma que da Alpaca. No es una prueba: lo usan las pruebas de la migración.
import { initialState, type State } from "../src/domain.ts";

const T0 = Date.parse("2026-09-01T13:30:00Z");
const iso = (t: number) => new Date(t).toISOString();
const uuid = (n: number, prefix = "0000") =>
  `${prefix}0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SYMBOLS = [
  "SPY",
  "QQQ",
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "GOOGL",
  "META",
  "TSLA",
  "AMD",
  "AVGO",
  "JPM",
  "V",
  "MA",
  "XOM",
  "UNH",
  "COST",
  "NFLX",
  "CRM",
  "ORCL",
];
const bar = (t: number, price: number) => ({
  t: iso(t),
  o: price,
  h: price * 1.01,
  l: price * 0.99,
  c: price * 1.002,
  v: 1234567,
});

export function productionLikeState(t = Date.parse("2026-09-16T15:00:00Z")) {
  const s: State = initialState();
  s.paused = false;
  s.settings = {
    symbols: SYMBOLS,
    maxOrderUsd: 5000,
    maxPositionUsd: 15000,
    maxExposureUsd: 40000,
    maxDailyOrders: 10,
    maxDailyCalls: 60,
    maxDrawdownPct: 10,
    cooldownSeconds: 120,
    riskProfile: "balanced",
  };
  s.versions = Array.from({ length: 4 }, (_, i) => ({
    id: uuid(i + 1, "1111"),
    instructions: "Instrucciones de prueba. ".repeat(40),
    lessonIds: Array.from({ length: i * 3 }, (_, j) => uuid(j + 1, "2222")),
    createdAt: iso(T0 + i * 86400000),
    note: `Versión ${i + 1}`,
  }));
  s.activeVersion = s.versions[3].id;
  s.lessons = Array.from({ length: 42 }, (_, i) => ({
    id: uuid(i + 1, "2222"),
    title: `Lección ${i + 1}`,
    body: "Una ganancia aislada no valida una estrategia. ".repeat(6),
    source: "Revisión de una operación",
    status: i < 15 ? "accepted" : i < 35 ? "retired" : "rejected",
    createdAt: iso(T0 + i * 3600000),
    decisionId: uuid(i + 1, "3333"),
  }));
  s.decisions = Array.from({ length: 54 }, (_, i) => {
    const compra = i % 9 === 0;
    return {
      id: uuid(i + 1, "3333"),
      at: iso(T0 + i * 1800000),
      versionId: s.versions[Math.min(3, Math.floor(i / 14))].id,
      event: "Revisión periódica del mercado",
      // El contexto guardado es lo que más pesa: unos 20 KB cada uno.
      input: {
        portfolio: { cash: 91234.5, positions: 2 },
        analysis: "x".repeat(20000),
      },
      proposal: {
        action: compra ? ("buy" as const) : ("wait" as const),
        symbol: compra ? "AAPL" : null,
        qty: compra ? 10 : null,
        limitPrice: compra ? 230.5 : null,
        reason: "Razonamiento con cifras sobre los activos permitidos. ".repeat(
          8,
        ),
        hypothesis: "Hipótesis verificable",
        reviewAfterHours: 24,
        notify: false,
        note: "Nota para el propietario, sin novedades",
        newsComments: [],
        watches: [],
        lessons: [],
      },
      status: compra ? "filled" : "observed",
      ...(compra
        ? {
            orderId: uuid(i + 1, "4444"),
            sentAt: iso(T0 + i * 1800000 + 5000),
            intent: "open_long" as const,
          }
        : {}),
      reviewAt: iso(T0 + i * 1800000 + 86400000),
      ...(i < 40
        ? {
            reviewSkipped:
              "Las esperas no se revisan: el agente aprende de operaciones reales.",
          }
        : {}),
      newsCommented: [],
    };
  });
  s.events = Array.from({ length: 270 }, (_, i) => ({
    id: uuid(i + 1, "5555"),
    at: iso(t - i * 600000),
    type: ["decision", "order", "watch", "news", "market"][i % 5],
    message: `Evento sintético ${i + 1}`,
  }));
  s.queue = [
    {
      id: uuid(1, "6666"),
      reason: "Revisión periódica del mercado",
      at: iso(t),
      trigger: "periodic",
    },
  ];
  s.watches = Array.from({ length: 60 }, (_, i) => ({
    id: uuid(i + 1, "7777"),
    symbol: SYMBOLS[i % SYMBOLS.length],
    operator: i % 2 ? ("gte" as const) : ("lte" as const),
    price: 100 + i,
    expiresAt: iso(t + 86400000),
    reason: "Salida de la operación si se cumple",
    invalidateBelow: null,
    invalidateAbove: null,
    status: i < 6 ? ("active" as const) : ("expired" as const),
    createdAt: iso(T0 + i * 3600000),
    decisionId: uuid((i % 54) + 1, "3333"),
  }));
  s.quotes = Object.fromEntries(
    SYMBOLS.map((x, i) => [x, { price: 100 + i * 10, at: iso(t - 1000) }]),
  );
  s.account = {
    id: "acc-1",
    status: "ACTIVE",
    currency: "USD",
    cash: "91234.56",
    equity: "101987.65",
    portfolio_value: "101987.65",
    long_market_value: "10753.09",
    buying_power: "182469.12",
    trading_blocked: false,
    account_blocked: false,
  };
  s.positions = [
    {
      symbol: "AAPL",
      qty: "23",
      side: "long",
      avg_entry_price: "231.12",
      cost_basis: "5315.76",
      current_price: "236.4",
      market_value: "5437.2",
      unrealized_pl: "121.44",
    },
    {
      symbol: "MSFT",
      qty: "11",
      side: "long",
      avg_entry_price: "480.3",
      cost_basis: "5283.3",
      current_price: "483.99",
      market_value: "5323.89",
      unrealized_pl: "40.59",
    },
  ];
  s.orders = Array.from({ length: 8 }, (_, i) => {
    const filled = i % 3 !== 2;
    return {
      id: uuid(i + 1, "4444"),
      client_order_id: i < 6 ? uuid(i * 9 + 1, "3333") : `manual-${i}`,
      symbol: i % 2 ? "MSFT" : "AAPL",
      side: i === 4 ? "sell" : "buy",
      type: "limit",
      time_in_force: "day",
      qty: "10",
      filled_qty: filled ? "10" : "0",
      filled_avg_price: filled ? String(230 + i) : null,
      limit_price: String(231 + i),
      status: filled ? "filled" : "canceled",
      submitted_at: iso(T0 + i * 86400000),
      filled_at: filled ? iso(T0 + i * 86400000 + 60000) : null,
    };
  });
  s.equity = Array.from({ length: 877 }, (_, i) => ({
    at: iso(t - (877 - i) * 300000),
    value: 100000 + i,
  }));
  s.heartbeat = iso(t);
  s.lastSync = iso(t - 5000);
  s.lastDecision = iso(t - 600000);
  s.calls = { day: "2026-09-16", count: 12 };
  s.baseline = 100000;
  s.stream = "connected";
  s.feeds = { trades: true, clock: true };
  s.market = {
    open: true,
    nextOpen: "2026-09-17T13:30:00Z",
    nextClose: "2026-09-16T20:00:00Z",
  };
  // Un año de velas por activo, como guarda el análisis.
  s.analysis = Object.fromEntries(
    SYMBOLS.map((x, i) => [
      x,
      {
        symbol: x,
        barsDiscarded: 0,
        bars: Array.from({ length: 252 }, (_, j) =>
          bar(T0 - (252 - j) * 86400000, 100 + i + j / 10),
        ),
        sma20: 101,
        sma50: 100,
        atr14: 2.5,
      } as unknown as State["analysis"][string],
    ]),
  );
  s.intraday = Object.fromEntries(
    SYMBOLS.map((x, i) => [
      x,
      {
        bars: Array.from({ length: 78 }, (_, j) =>
          bar(t - (78 - j) * 300000, 100 + i),
        ),
        vwap: 100 + i,
      } as unknown as State["intraday"][string],
    ]),
  );
  s.stories = Array.from({ length: 30 }, (_, i) => ({
    id: String(40000000 + i),
    at: iso(t - (30 - i) * 3600000),
    source: "benzinga",
    headline: `Titular ${i + 1} sobre ${SYMBOLS[i % SYMBOLS.length]}`,
    summary: "Resumen de la noticia. ".repeat(10),
    symbols: [SYMBOLS[i % SYMBOLS.length]],
    url: "https://ejemplo.test/noticia",
    ...(i < 20 ? { commented: true } : {}),
  }));
  s.lastNotice = { at: iso(t - 7200000), kind: "decision" };
  s.preOpenNews = "2026-09-16T20:00:00Z";
  s.usage = Array.from({ length: 69 }, (_, i) => ({
    at: iso(T0 + i * 3600000),
    tokens: 12000 + i,
    kind: "decision" as const,
    trigger: "periodic" as const,
    promptTokens: 11000,
    completionTokens: 1000 + i,
    sections: { instructions: 4000, portfolio: 1500, analysis: 3000 },
    ok: true,
  }));
  s.modelJob = null;
  return s;
}
