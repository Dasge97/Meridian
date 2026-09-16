import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  restoreState,
  pruneSim,
  pruneShared,
  logShared,
  SYSTEM_EVENTS_KEPT,
  type State,
} from "../src/domain.ts";
import {
  composeState,
  decomposeState,
  restoreShared,
  restoreSim,
  sharedRows,
  simRows,
  sharedFingerprint,
  sharedDifferences,
  sharedHotKeys,
  sharedColdKeys,
  simHotKeys,
  simColdKeys,
  legacyHotKeys,
  legacyColdKeys,
  legacyRows,
  legacyProblem,
  splitLegacyState,
  initialShared,
  type SharedState,
  type SimState,
} from "../src/sim-state.ts";
import { productionLikeState } from "./synthetic-state.ts";

// Una vista con algo en cada campo que importa para repartirla.
function view(): State {
  const s = productionLikeState();
  s.settings.riskProfile = "aggressive";
  s.stories = s.stories.map((n) => ({ ...n, commented: Boolean(n.commented) }));
  s.modelJob = {
    id: "job-1",
    startedAt: "2026-09-16T14:59:00Z",
    kind: "decision",
    targetId: "q-1",
  };
  s.fills = [
    {
      orderId: "o-1",
      symbol: "AAPL",
      side: "buy",
      qty: 10,
      price: 230,
      at: "2026-09-15T14:00:00Z",
      realizedPl: 0,
      rule: "alpaca",
    },
  ];
  s.comparison = {
    startedAt: "2026-09-16T15:00:00Z",
    equity: 101987.65,
    cash: 91234.56,
    positions: [{ symbol: "AAPL", qty: 23, avgPrice: 231.12 }],
  };
  s.marketSync = "2026-09-16T14:59:30Z";
  s.startedAt = "2026-09-13T00:00:00Z";
  return s;
}

test("Composing a decomposed view gives back the same view", () => {
  const v = view();
  const { shared, sim } = decomposeState(v, []);
  assert.deepEqual(composeState(shared, sim), v);
});

test("Decomposing a composed view gives back the shared state and the simulation", () => {
  const { shared, sim } = decomposeState(view(), []);
  shared.systemEvents = [
    { id: "e1", at: "2026-09-16T10:00:00Z", type: "market", message: "m" },
  ];
  const again = decomposeState(composeState(shared, sim), shared.systemEvents);
  assert.deepEqual(again.shared, shared);
  assert.deepEqual(again.sim, sim);
});

test("The risk level and the commented news belong to the simulation", () => {
  const v = view();
  const { shared, sim } = decomposeState(v);
  assert.equal("riskProfile" in shared.settings, false);
  assert.equal(sim.riskProfile, "aggressive");
  assert.ok(shared.stories.every((n) => !("commented" in n)));
  assert.deepEqual(
    sim.commentedStories,
    v.stories.filter((n) => n.commented).map((n) => n.id),
  );
  const rows = { ...sharedRows(shared), ...simRows(sim) };
  assert.deepEqual(Object.keys(rows).sort(), [
    "shared:cold",
    "shared:hot",
    "sim:alpaca:cold",
    "sim:alpaca:hot",
  ]);
  const hot = rows["sim:alpaca:hot"] as Record<string, unknown>;
  assert.equal(hot.riskProfile, "aggressive");
  assert.equal("decisions" in hot, false, "el historial va en la fila fría");
  assert.equal(
    "quotes" in (rows["sim:alpaca:cold"] as object),
    false,
    "los precios no son de la simulación",
  );
  assert.equal(
    "analysis" in (rows["shared:hot"] as object),
    false,
    "el análisis no va en la fila que se reescribe cada 2 segundos",
  );
});

test("Every field lives in exactly one row", () => {
  const filas = [
    ...sharedHotKeys,
    ...sharedColdKeys,
    ...simHotKeys,
    ...simColdKeys,
  ];
  assert.equal(new Set(filas).size, filas.length, "ningún campo repetido");
  const legacy = [...legacyHotKeys, ...legacyColdKeys];
  assert.equal(new Set(legacy).size, legacy.length);
});

test("Commented news that no longer exists is forgotten", () => {
  const { shared, sim } = decomposeState(view());
  sim.commentedStories = [...sim.commentedStories, "ya-no-existe"];
  const v = composeState(shared, sim);
  assert.equal(
    decomposeState(v).sim.commentedStories.includes("ya-no-existe"),
    false,
  );
});

test("Missing fields come back with their initial value and foreign ones are ignored", () => {
  const sh = restoreShared([
    { settings: { maxOrderUsd: 5000, riskProfile: "prudent" }, extra: 1 },
    {
      stories: [
        {
          id: "1",
          at: "2026-09-16T10:00:00Z",
          source: "x",
          headline: "h",
          summary: "",
          symbols: ["SPY"],
          url: "",
          commented: true,
        },
      ],
    },
  ]);
  assert.equal(sh.settings.maxOrderUsd, 5000, "lo guardado se conserva");
  assert.equal(sh.settings.maxDailyCalls, 20, "lo que falta, el inicial");
  assert.equal("riskProfile" in sh.settings, false);
  assert.equal("commented" in sh.stories[0], false);
  assert.equal("extra" in sh, false);
  assert.deepEqual(sh.systemEvents, []);
  assert.deepEqual(sh.feeds, { trades: true, clock: true });
  const sim = restoreSim("alpaca", [{ paused: false, decisions: undefined }]);
  assert.equal(sim.id, "alpaca");
  assert.equal(sim.paused, false);
  assert.equal(sim.riskProfile, "balanced");
  assert.deepEqual(sim.fills, []);
  assert.equal(sim.comparison, null);
});

test("A change to shared data through a view is detected, even in place", () => {
  const v = view();
  const huella = sharedFingerprint(decomposeState(v).shared);
  // Lo de la simulación no cuenta.
  v.settings.riskProfile = "prudent";
  v.stories[25].commented = true;
  v.paused = true;
  assert.deepEqual(sharedDifferences(huella, decomposeState(v).shared), []);
  v.quotes.AAPL.price = 1;
  v.settings.symbols.push("IBM");
  assert.deepEqual(sharedDifferences(huella, decomposeState(v).shared).sort(), [
    "quotes",
    "settings",
  ]);
});

test("Pruning keeps shared and simulation history bounded separately", () => {
  const sh: SharedState = initialShared();
  for (let i = 0; i < SYSTEM_EVENTS_KEPT + 20; i++)
    logShared(sh, "market", `evento ${i}`);
  assert.equal(sh.systemEvents.length, SYSTEM_EVENTS_KEPT);
  sh.systemEvents.push(...sh.systemEvents.slice(0, 10));
  pruneShared(sh);
  assert.equal(sh.systemEvents.length, SYSTEM_EVENTS_KEPT);
  assert.equal(sh.systemEvents[0].message, `evento ${SYSTEM_EVENTS_KEPT + 19}`);
  const s = view();
  const fills = s.fills.length;
  pruneSim(s);
  assert.equal(s.fills.length, fills, "las ejecuciones no se recortan");
});

test("Migration refuses a state with open intentions or short positions", () => {
  const pendiente = productionLikeState();
  pendiente.decisions[3].status = "submitting";
  assert.match(legacyProblem(pendiente)!, /reconcilia o espera/);
  const corta = productionLikeState();
  corta.positions[0].qty = "-5";
  assert.match(legacyProblem(corta)!, /posición corta en Alpaca \(AAPL/);
  assert.equal(legacyProblem(productionLikeState()), null);
});

test("Splitting the old state keeps everything and only changes what it must", () => {
  const T = Date.parse("2026-09-16T16:00:00Z");
  const legacy = productionLikeState();
  legacy.settings.riskProfile = "active";
  legacy.modelJob = {
    id: "j",
    startedAt: "2026-09-16T15:59:00Z",
    kind: "decision",
    targetId: "q",
  };
  const { view: v, shared, sim } = splitLegacyState(legacy, T);
  assert.deepEqual(composeState(shared, sim), v);
  assert.equal(v.settings.riskProfile, "balanced");
  assert.match(v.events[0].message, /Nivel fijado en Equilibrado/);
  assert.match(v.events[1].message, /Evaluación interrumpida/);
  assert.equal(v.modelJob, null);
  assert.equal(v.events.length, legacy.events.length + 2);
  assert.deepEqual(v.decisions, legacy.decisions);
  assert.deepEqual(v.watches, legacy.watches);
  assert.deepEqual(v.analysis, legacy.analysis);
  // Solo las órdenes terminadas con algo ejecutado, y las manuales marcadas.
  const ejecutadas = legacy.orders.filter((o) => Number(o.filled_qty) > 0);
  assert.equal(sim.fills.length, ejecutadas.length);
  assert.ok(sim.fills.some((f) => f.manual));
  assert.ok(sim.fills.every((f) => f.rule === "alpaca"));
  assert.deepEqual(sim.comparison, {
    startedAt: new Date(T).toISOString(),
    equity: 101987.65,
    cash: 91234.56,
    positions: [
      { symbol: "AAPL", qty: 23, avgPrice: 231.12 },
      { symbol: "MSFT", qty: 11, avgPrice: 480.3 },
    ],
  });
  assert.equal(sim.startedAt, legacy.equity[0].at);
  assert.equal(
    sim.commentedStories.length,
    legacy.stories.filter((n) => n.commented).length,
  );
  assert.deepEqual(shared.systemEvents, []);
  // El estado de partida no se toca.
  assert.equal(legacy.settings.riskProfile, "active");
});

test("A fresh installation has no account and starts without a comparison", () => {
  const { sim } = splitLegacyState(initialState());
  assert.equal(sim.comparison, null);
  assert.deepEqual(sim.fills, []);
});

test("The old two-row layout written back can be read by the old code", () => {
  const v = view();
  const rows = legacyRows(v);
  const back = restoreState([
    JSON.parse(JSON.stringify(rows[1])),
    JSON.parse(JSON.stringify(rows[2])),
  ]);
  for (const k of [...legacyHotKeys, ...legacyColdKeys])
    assert.deepEqual(back[k], JSON.parse(JSON.stringify(v[k])), k);
  assert.equal("fills" in rows[1] || "fills" in rows[2], false);
});

test("The simulation rows never carry shared data and the other way round", () => {
  const { shared, sim } = decomposeState(view());
  const simKeysIn = Object.keys(sim as SimState);
  for (const k of [...sharedHotKeys, ...sharedColdKeys])
    if (k !== "settings" && k !== "systemEvents")
      assert.equal(simKeysIn.includes(k), false, k);
  assert.equal("paused" in shared, false);
});
