import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  watchState,
  orderGuard,
  proposalSchema,
  watchSchema,
  validWatch,
  watchProblem,
  adoptLessons,
  MAX_ACTIVE_LESSONS,
  RISK_PROFILE_KEYS,
  now,
  id,
} from "../src/domain.ts";
function state() {
  const s = initialState();
  s.paused = false;
  s.account = { status: "ACTIVE", equity: "10000", cash: "10000" };
  s.baseline = 10000;
  s.lastSync = now();
  s.quotes.AAPL = { price: 200, at: now() };
  return s;
}
const proposal = () =>
  proposalSchema.parse({
    action: "buy",
    symbol: "AAPL",
    qty: 1,
    limitPrice: 200,
    reason: "Hipótesis basada en precio",
    hypothesis: "Esperar confirmación",
    reviewAfterHours: 24,
    notify: false,
    note: "Sin novedad que contar al propietario",
    watches: [],
    lessons: [],
  });
const watch = () => ({
  ...watchSchema.parse({
    symbol: "AAPL",
    operator: "lte",
    price: 200,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    reason: "Reevaluar oportunidad",
  }),
  id: id(),
  status: "active" as const,
  createdAt: now(),
});
test("A valid paper buy passes and insufficient cash fails", () => {
  const s = state();
  assert.equal(orderGuard(s, proposal()), null);
  s.account.cash = "20";
  assert.match(orderGuard(s, proposal())!, /Saldo/);
});
test("No shorts, leverage, invalid data or stale quotes", () => {
  const s = state();
  // En ningún nivel de riesgo se vende lo que no se tiene.
  for (const level of RISK_PROFILE_KEYS) {
    s.settings.riskProfile = level;
    assert.equal(
      orderGuard(s, { ...proposal(), action: "sell" }),
      "No se permiten posiciones cortas",
      level,
    );
  }
  s.account.equity = "broken";
  assert.match(orderGuard(s, proposal())!, /Datos/);
  s.account.equity = "10000";
  s.quotes.AAPL.at = "invalid";
  assert.match(orderGuard(s, proposal())!, /Precio/);
  s.quotes.AAPL.at = new Date(Date.now() - 100000).toISOString();
  assert.match(orderGuard(s, proposal())!, /Precio/);
});
test("Pause and symbol allowlist are enforced outside model", () => {
  const s = state();
  s.paused = true;
  assert.match(orderGuard(s, proposal())!, /pausado/);
  s.paused = false;
  assert.match(orderGuard(s, { ...proposal(), symbol: "TSLA" })!, /permitido/);
});
test("Position, exposure, drawdown and per-order limits", () => {
  const s = state();
  s.settings.maxOrderUsd = 100;
  assert.match(orderGuard(s, proposal())!, /por orden/);
  s.settings.maxOrderUsd = 600;
  s.settings.maxPositionUsd = 100;
  assert.match(orderGuard(s, proposal())!, /posición/);
  s.settings.maxPositionUsd = 1200;
  s.settings.maxExposureUsd = 100;
  assert.match(orderGuard(s, proposal())!, /exposición/);
  s.settings.maxExposureUsd = 2000;
  s.account.equity = "8000";
  assert.match(orderGuard(s, proposal())!, /pérdida/);
});
test("An open order only blocks its own asset, and its money counts as spent", () => {
  const s = state();
  s.settings.symbols = ["AAPL", "MSFT"];
  s.settings.maxExposureUsd = 20000;
  s.orders = [
    {
      symbol: "MSFT",
      side: "buy",
      status: "new",
      qty: "10",
      limit_price: "500",
    },
  ];
  assert.equal(orderGuard(s, proposal()), null, "otro activo no se bloquea");
  s.orders[0].symbol = "AAPL";
  assert.match(orderGuard(s, proposal())!, /orden abierta de este activo/);
  // 10 x 500 comprometidos: con 5.100 de efectivo no caben 200 más.
  s.orders[0].symbol = "MSFT";
  s.account.cash = "5100";
  assert.match(orderGuard(s, proposal())!, /Saldo/);
  s.account.cash = "10000";
  s.settings.maxExposureUsd = 5100;
  assert.match(orderGuard(s, proposal())!, /exposición/);
  s.settings.maxExposureUsd = 20000;
  s.orders[0].limit_price = "roto";
  assert.match(orderGuard(s, proposal())!, /órdenes no válidos/);
  s.orders = [];
  s.decisions = [{ status: "unknown" } as any];
  assert.match(orderGuard(s, proposal())!, /intención/);
});
test("Lessons enter memory on their own, capped, and always in a new version", () => {
  const s = state();
  const first = s.activeVersion;
  const leccion = (n: number) => ({
    title: `Lección ${n}`,
    body: "Una regla concreta con sus límites",
    source: "revisión",
  });
  adoptLessons(s, [leccion(0)], "Primera");
  assert.notEqual(s.activeVersion, first);
  assert.equal(s.lessons[0].status, "accepted");
  assert.deepEqual(s.versions.at(-1)!.lessonIds, [s.lessons[0].id]);
  for (let n = 1; n <= MAX_ACTIVE_LESSONS; n++)
    adoptLessons(s, [leccion(n)], `Lección ${n}`);
  const activas = s.lessons.filter((l) => l.status === "accepted");
  assert.equal(activas.length, MAX_ACTIVE_LESSONS);
  assert.equal(s.lessons[0].status, "retired", "sale la más antigua");
  assert.equal(s.versions.at(-1)!.lessonIds.length, MAX_ACTIVE_LESSONS);
  const versiones = s.versions.length;
  assert.equal(adoptLessons(s, [], "Nada"), null);
  assert.equal(s.versions.length, versiones, "sin lecciones no hay versión");
});
test("Daily order budget counts submissions regardless of final status", () => {
  const s = state();
  s.settings.maxDailyOrders = 1;
  s.decisions = [{ status: "rejected", sentAt: now() } as any];
  assert.match(orderGuard(s, proposal())!, /diario/);
});
test("A watch is single-use and invalidation wins over activation", () => {
  const w = watch();
  const q = { price: 199, at: now() };
  assert.equal(watchState(w, q), "triggered");
  assert.equal(watchState({ ...w, status: "triggered" }, q), "triggered");
  assert.equal(watchState({ ...w, invalidateBelow: 200 }, q), "invalidated");
});
test("Expired, stale, future and malformed timestamps cannot activate", () => {
  const w = watch();
  assert.equal(
    watchState(
      { ...w, expiresAt: "2020-01-01T00:00:00Z" },
      { price: 199, at: now() },
    ),
    "expired",
  );
  for (const at of [
    "invalid",
    new Date(Date.now() - 100000).toISOString(),
    new Date(Date.now() + 60000).toISOString(),
  ])
    assert.equal(watchState(w, { price: 199, at }), "active");
});
test("Watch validation caps expiry and allowed symbols", () => {
  const s = state();
  assert.equal(validWatch(watch(), s), true);
  assert.equal(validWatch({ ...watch(), symbol: "TSLA" }, s), false);
  assert.equal(
    validWatch(
      {
        ...watch(),
        expiresAt: new Date(Date.now() + 40 * 86400000).toISOString(),
      },
      s,
    ),
    false,
  );
});
test("Model output is structured, finite and bounded", () => {
  assert.throws(() => proposalSchema.parse({ ...proposal(), qty: 1.2 }));
  assert.throws(() =>
    proposalSchema.parse({ ...proposal(), limitPrice: Infinity }),
  );
  assert.throws(() => proposalSchema.parse({ ...proposal(), action: "shell" }));
});
test("The same condition is not watched twice, and the reason is explicit", () => {
  const s = state();
  const w = watch();
  assert.equal(watchProblem(w, s), null);
  s.watches.push(w);
  assert.match(watchProblem(w, s)!, /ya se está vigilando/);
  // Distinto precio, distinto operador o distinto activo sí se admiten.
  assert.equal(watchProblem({ ...w, price: 195 }, s), null);
  assert.equal(watchProblem({ ...w, operator: "gte" }, s), null);
  // Una vigilancia ya cerrada no bloquea volver a poner la misma condición.
  s.watches[0].status = "triggered";
  assert.equal(watchProblem(w, s), null);
});
test("Each watch rejection says what is wrong", () => {
  const s = state();
  assert.match(
    watchProblem({ ...watch(), symbol: "TSLA" }, s)!,
    /no está en la lista/,
  );
  assert.match(
    watchProblem({ ...watch(), expiresAt: "2020-01-01T00:00:00Z" }, s)!,
    /futura/,
  );
  assert.match(
    watchProblem(
      {
        ...watch(),
        expiresAt: new Date(Date.now() + 40 * 86400000).toISOString(),
      },
      s,
    )!,
    /30 días/,
  );
  s.watches = Array.from({ length: 50 }, (_, i) => ({
    ...watch(),
    id: id(),
    price: 100 + i,
  }));
  assert.match(watchProblem(watch(), s)!, /50 vigilancias/);
});
