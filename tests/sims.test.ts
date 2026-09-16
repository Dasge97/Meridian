import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  proposalSchema,
  enqueue,
  id,
  now,
  type State,
  type Decision,
} from "../src/domain.ts";
import {
  pickSim,
  claimJob,
  claimIntent,
  applyDecision,
  applyReview,
  type SimCandidate,
} from "../src/agent.ts";
import {
  withSim,
  newsSims,
  decisionNotice,
  orderNotice,
  reviewNotice,
  problemNotice,
  newsNotice,
} from "../src/report.ts";
import {
  acceptInternalOrder,
  simulateFills,
  markInternal,
  startingBookFrom,
} from "../src/paper.ts";
import {
  internalFromAlpaca,
  splitLegacyState,
  composeState,
  decomposeState,
  simSummary,
  INTERNAL_STARTING_CASH,
} from "../src/sim-state.ts";
import { SIM_IDS, SIMS } from "../src/sims.ts";
import { modelConcurrency } from "../src/sim-worker.ts";
import { productionLikeState } from "./synthetic-state.ts";

const iso = (t: number) => new Date(t).toISOString();
const proposal = (over: Record<string, unknown> = {}) =>
  proposalSchema.parse({
    action: "buy",
    symbol: "AAPL",
    qty: 10,
    limitPrice: 199,
    reason: "Hipótesis basada en precio",
    hypothesis: "Rebote hacia 205",
    reviewAfterHours: 24,
    notify: true,
    note: "Compro 10 AAPL en el soporte",
    watches: [],
    lessons: [],
    ...over,
  });

test("The internal simulation exists next to Alpaca", () => {
  assert.deepEqual([...SIM_IDS], ["alpaca", "internal"]);
  assert.deepEqual(SIMS.internal, { label: "Interna", broker: "internal" });
  assert.equal(SIMS.alpaca.broker, "alpaca");
});

const cand = (
  sim: "alpaca" | "internal",
  trigger: SimCandidate["trigger"],
  queuedAt: string | null = null,
): SimCandidate => ({ sim, trigger, queuedAt });

test("pickSim serves the most urgent event first", () => {
  assert.equal(pickSim([], null), null);
  assert.equal(
    pickSim(
      [cand("alpaca", "periodic"), cand("internal", "watch")],
      "internal",
    ),
    "internal",
    "una vigilancia cumplida va antes aunque le tocara a la otra",
  );
  assert.equal(
    pickSim([cand("alpaca", "other"), cand("internal", "manual")], null),
    "alpaca",
    "una orden ejecutada cuenta como vigilancia",
  );
  assert.equal(
    pickSim([cand("alpaca", undefined), cand("internal", "manual")], null),
    "alpaca",
    "un evento sin origen cuenta como other",
  );
  const orden: SimCandidate["trigger"][] = [
    "manual",
    "news",
    "periodic",
    "review",
  ];
  for (let i = 0; i < orden.length - 1; i++)
    assert.equal(
      pickSim(
        [cand("alpaca", orden[i + 1]), cand("internal", orden[i])],
        "internal",
      ),
      "internal",
      `${orden[i]} antes que ${orden[i + 1]}`,
    );
  assert.equal(
    pickSim([cand("alpaca", "preopen"), cand("internal", "news")], "alpaca"),
    "internal",
    "noticias y repaso de apertura empatan",
  );
});

test("pickSim takes turns when both are equally urgent", () => {
  const ambas = [cand("alpaca", "periodic"), cand("internal", "periodic")];
  assert.equal(pickSim(ambas, "alpaca"), "internal");
  assert.equal(pickSim(ambas, "internal"), "alpaca");
  let ultima: "alpaca" | "internal" | null = null;
  const servidas: string[] = [];
  for (let i = 0; i < 4; i++) {
    ultima = pickSim(ambas, ultima)!;
    servidas.push(ultima);
  }
  assert.deepEqual(servidas, ["alpaca", "internal", "alpaca", "internal"]);
  // Sin turno previo, la que lleva más tiempo esperando.
  assert.equal(
    pickSim(
      [
        cand("alpaca", "news", "2026-09-16T15:00:00Z"),
        cand("internal", "news", "2026-09-16T14:00:00Z"),
      ],
      null,
    ),
    "internal",
  );
  assert.equal(pickSim([cand("internal", "review")], "internal"), "internal");
});

test("withSim puts the simulation and its level in front of every notice", () => {
  const s = initialState();
  s.sim = "internal";
  s.broker = "internal";
  s.settings.symbols = ["AAPL"];
  s.account = { status: "ACTIVE", equity: 100000, cash: 98000 };
  s.stories = [
    {
      id: "n1",
      at: now(),
      source: "benzinga",
      headline: "Titular",
      summary: "",
      symbols: ["AAPL"],
      url: "",
    },
  ];
  const d: Decision = {
    id: id(),
    at: now(),
    versionId: s.activeVersion,
    event: "prueba",
    input: null,
    proposal: proposal(),
    status: "filled",
    reviewAt: now(),
    review: { at: now(), text: "Buena entrada", price: 201 },
    newsCommented: [
      { storyId: "n1", comment: "No cambia nada", matters: false },
    ],
  };
  const avisos = [
    decisionNotice(s, d),
    decisionNotice(s, { ...d, error: "Límite por orden" }),
    decisionNotice(s, {
      ...d,
      proposal: proposal({
        action: "wait",
        symbol: null,
        qty: null,
        limitPrice: null,
      }),
    }),
    orderNotice(s, d, "filled"),
    orderNotice(s, d, "canceled"),
    orderNotice(s, d, "rejected"),
    reviewNotice(s, d),
    problemNotice("La contabilidad no cuadra", "https://panel.test"),
    newsNotice(s, d),
  ];
  for (const aviso of avisos) {
    assert.ok(aviso, "cada tipo de aviso existe en este caso");
    const con = withSim(aviso, { label: "Interna", riskLabel: "Agresivo" })!;
    assert.equal(con.kind, aviso.kind);
    assert.equal(con.text, "<b>[Interna · Agresivo]</b>\n" + aviso.text);
  }
  assert.equal(
    withSim(null, { label: "Interna", riskLabel: "Agresivo" }),
    null,
  );
  assert.equal(
    withSim(avisos[0], { label: "<b>", riskLabel: "A&B" })!.text.split("\n")[0],
    "<b>[&lt;b&gt; · A&amp;B]</b>",
    "la etiqueta se escapa",
  );
  // La interna no tiene a Alpaca delante: una orden rechazada lo es por el motor.
  assert.doesNotMatch(orderNotice(s, d, "rejected")!.text, /Alpaca/);
  s.broker = "alpaca";
  assert.match(orderNotice(s, d, "rejected")!.text, /rechazada por Alpaca/);
});

test("TELEGRAM_NEWS_SIMS picks which simulations send news comments", () => {
  assert.deepEqual(newsSims(undefined), {
    sims: ["alpaca", "internal"],
    unknown: [],
  });
  assert.deepEqual(newsSims(""), { sims: ["alpaca", "internal"], unknown: [] });
  assert.deepEqual(newsSims("internal"), { sims: ["internal"], unknown: [] });
  assert.deepEqual(newsSims(" alpaca , nada "), {
    sims: ["alpaca"],
    unknown: ["nada"],
  });
  assert.deepEqual(newsSims("nada"), {
    sims: ["alpaca", "internal"],
    unknown: ["nada"],
  });
});

test("MODEL_CONCURRENCY defaults to one call per simulation", () => {
  assert.equal(modelConcurrency(undefined), 2);
  assert.equal(modelConcurrency("1"), 1);
  assert.equal(modelConcurrency("3"), 3);
  for (const malo of ["0", "-1", "1.5", "dos", ""])
    assert.equal(modelConcurrency(malo), 2, malo);
});

// La vista de Alpaca tal como queda tras separar el estado de producción.
function alpacaView(t: number) {
  const { view } = splitLegacyState(productionLikeState(), t);
  return view;
}

test("The internal simulation is born as a full copy of Alpaca", () => {
  const T = Date.parse("2026-09-16T16:00:00Z");
  const alpaca = alpacaView(T);
  // Una orden que sigue abierta en Alpaca y un gasto que no se copia.
  alpaca.decisions[9].status = "new";
  alpaca.calls = { day: "2026-09-16", count: 12 };
  alpaca.modelJob = null;
  const antes = structuredClone(alpaca);
  const v = internalFromAlpaca(alpaca, T);
  assert.deepEqual(alpaca, antes, "la vista de Alpaca no se toca");

  assert.equal(v.sim, "internal");
  assert.equal(v.broker, "internal");
  assert.equal(v.settings.riskProfile, "aggressive");
  assert.equal(alpaca.settings.riskProfile, "balanced");
  assert.equal(v.paused, alpaca.paused, "nace con la misma pausa");
  // La cuenta: efectivo, posiciones con su precio medio y valor, y el baseline.
  assert.equal(v.account.cash, 91234.56);
  assert.equal(v.account.equity, 91234.56 + 23 * 236.4 + 11 * 483.99);
  assert.deepEqual(
    v.positions.map((x) => [
      x.symbol,
      x.qty,
      x.avg_entry_price,
      x.current_price,
    ]),
    [
      ["AAPL", 23, 231.12, 236.4],
      ["MSFT", 11, 480.3, 483.99],
    ],
  );
  assert.equal(v.baseline, alpaca.baseline);
  // Lo que no se copia.
  assert.deepEqual(v.orders, []);
  assert.deepEqual(v.fills, []);
  assert.deepEqual(v.usage, []);
  assert.deepEqual(v.queue, []);
  assert.equal(v.modelJob, null);
  assert.deepEqual(v.calls, { day: "", count: 0 });
  assert.equal(v.lastNotice, null);
  // Memoria e historial, iguales.
  assert.deepEqual(v.lessons, alpaca.lessons);
  assert.deepEqual(v.versions, alpaca.versions);
  assert.equal(v.activeVersion, alpaca.activeVersion);
  assert.deepEqual(v.equity, alpaca.equity);
  assert.equal(v.startedAt, alpaca.startedAt);
  assert.equal(v.decisions.length, alpaca.decisions.length);
  assert.deepEqual(
    v.decisions.map((d) => d.input),
    alpaca.decisions.map((d) => d.input),
    "las decisiones conservan su contexto",
  );
  assert.equal(v.decisions[9].status, "canceled", "empieza sin órdenes");
  assert.equal(v.decisions[0].status, alpaca.decisions[0].status);
  assert.deepEqual(
    decomposeState(v).sim.commentedStories,
    decomposeState(alpaca).sim.commentedStories,
  );
  assert.equal(v.events.length, alpaca.events.length + 2);
  assert.match(v.events[1].message, /Simulación Interna creada como copia/);
  assert.match(v.events[0].message, /orden abierta en Alpaca/);
  assert.deepEqual(v.events.slice(2), alpaca.events);
  // Solo las vigilancias activas, con ids nuevos.
  const activas = alpaca.watches.filter((w) => w.status === "active");
  assert.equal(v.watches.length, activas.length);
  assert.ok(v.watches.every((w) => w.status === "active"));
  const ids = new Set(alpaca.watches.map((w) => w.id));
  assert.ok(v.watches.every((w) => !ids.has(w.id)));
  assert.deepEqual(
    v.watches.map(({ id: _i, ...w }) => w),
    activas.map(({ id: _i, ...w }) => w),
  );
  // El punto de partida, en el mismo instante que el de Alpaca.
  assert.equal(v.comparison!.startedAt, alpaca.comparison!.startedAt);
  assert.equal(v.comparison!.startedAt, iso(T));
  assert.equal(v.comparison!.cash, 91234.56);
  assert.equal(v.comparison!.equity, v.account.equity);
  assert.deepEqual(v.comparison!.positions, alpaca.comparison!.positions);
  // Se guarda y se lee igual que cualquier vista.
  const partes = decomposeState(v);
  assert.deepEqual(composeState(partes.shared, partes.sim), v);
  assert.equal(partes.sim.id, "internal");

  const pausada = alpacaView(T);
  pausada.paused = true;
  assert.equal(internalFromAlpaca(pausada, T).paused, true);
});

test("The internal copy leaves inherited trades to Alpaca's review, so they are not paid twice", () => {
  const T = Date.parse("2026-09-16T16:00:00Z");
  const alpaca = alpacaView(T);
  // 45: operación enviada y sin revisar. 36: ya revisada. 27: sin intentos
  // que gastar. 0: una espera ya descartada.
  const pendiente = alpaca.decisions[45],
    revisada = alpaca.decisions[36],
    agotada = alpaca.decisions[27];
  assert.ok(pendiente.orderId && !pendiente.review && !pendiente.reviewSkipped);
  delete revisada.reviewSkipped;
  revisada.review = { at: iso(T - 3600000), text: "Revisada", price: 230 };
  delete agotada.reviewSkipped;
  agotada.reviewAttempts = 3;
  const v = internalFromAlpaca(alpaca, T);
  const copia = (d: Decision) => v.decisions.find((x) => x.id === d.id)!;
  assert.equal(
    copia(pendiente).reviewSkipped,
    "Revisada en la simulación de Alpaca: es una operación anterior a la separación",
  );
  assert.equal(pendiente.reviewSkipped, undefined, "Alpaca la sigue revisando");
  assert.equal(copia(revisada).reviewSkipped, undefined);
  assert.deepEqual(copia(revisada).review, revisada.review);
  assert.equal(copia(agotada).reviewSkipped, undefined);
  assert.equal(
    copia(alpaca.decisions[0]).reviewSkipped,
    alpaca.decisions[0].reviewSkipped,
  );
  // En la interna, claimJob no la elige; en Alpaca, sí.
  for (const s of [alpaca, v]) {
    s.paused = false;
    s.queue = [];
    s.calls = { day: "", count: 0 };
    s.lastDecision = null;
    s.modelJob = null;
    for (const d of s.decisions)
      if (d.id !== pendiente.id && !d.reviewSkipped && !d.review)
        d.reviewSkipped = "Fuera de la prueba";
  }
  const later = Date.parse(pendiente.reviewAt) + 1000;
  assert.equal(claimJob(v, true, later), null, "la interna no la revisa");
  const job = claimJob(alpaca, true, later);
  assert.equal(job?.meta.kind, "review");
  assert.equal(job?.due?.id, pendiente.id);
  assert.equal(alpaca.modelJob?.targetId, pendiente.id);
});

test("Copying Alpaca fails with the reason when its account cannot be copied", () => {
  const T = Date.parse("2026-09-16T16:00:00Z");
  const corta = alpacaView(T);
  corta.positions[0].qty = "-5";
  assert.throws(() => internalFromAlpaca(corta, T), /no es larga/);
  const sinEfectivo = alpacaView(T);
  sinEfectivo.account.cash = "-10";
  assert.throws(() => internalFromAlpaca(sinEfectivo, T), /efectivo negativo/);
});

test("On a fresh installation the internal simulation starts with 100,000 USD", () => {
  const T = Date.parse("2026-09-16T16:00:00Z");
  const { view } = splitLegacyState(initialState(), T);
  const v = internalFromAlpaca(view, T);
  assert.equal(v.account.cash, INTERNAL_STARTING_CASH);
  assert.equal(v.account.equity, INTERNAL_STARTING_CASH);
  assert.equal(v.baseline, INTERNAL_STARTING_CASH);
  assert.equal(v.comparison!.equity, INTERNAL_STARTING_CASH);
  assert.equal(v.paused, true);
});

test("The selector summary comes from the hot row alone", () => {
  const T = Date.parse("2026-09-16T16:00:00Z");
  const alpaca = alpacaView(T);
  alpaca.decisions[3].status = "unknown";
  alpaca.decisions[4].status = "submitting";
  alpaca.modelJob = {
    id: "j",
    startedAt: iso(T),
    kind: "decision",
    targetId: "q",
  };
  const { sim } = decomposeState(alpaca);
  assert.equal(sim.unresolved, 2, "se recalcula al guardar");
  assert.deepEqual(simSummary(sim), {
    id: "alpaca",
    label: "Alpaca Paper",
    broker: "alpaca",
    riskProfile: "balanced",
    paused: false,
    evaluating: true,
    equity: 101987.65,
    baseline: 100000,
    unresolved: 2,
  });
  const fresca = decomposeState(initialState()).sim;
  assert.equal(simSummary(fresca).equity, null);
  assert.equal(simSummary({ ...fresca, unresolved: undefined }).unresolved, 0);
});

test("An internal order goes from the decision to its review without leaving Meridian", () => {
  // 10:00 en Nueva York, con la sesión abierta hasta las 16:00.
  const T0 = Date.parse("2026-09-16T14:00:00Z");
  const s: State = initialState();
  s.sim = "internal";
  s.broker = "internal";
  s.paused = false;
  s.settings = {
    ...s.settings,
    symbols: ["AAPL"],
    maxOrderUsd: 5000,
    maxPositionUsd: 15000,
    maxExposureUsd: 40000,
  };
  s.market = { open: true, nextOpen: null, nextClose: "2026-09-16T20:00:00Z" };
  Object.assign(
    s,
    startingBookFrom({
      account: { cash: 100000 },
      positions: [],
      baseline: null,
    }),
  );
  s.quotes.AAPL = { price: 200, at: iso(T0) };
  assert.equal(markInternal(s, T0), null);

  // 1. La evaluación decide comprar por debajo del precio.
  enqueue(s, "Revisión periódica del mercado", "periodic");
  const job = claimJob(s, true, T0)!;
  assert.equal(job.event, "Revisión periódica del mercado");
  const d = applyDecision(
    s,
    job,
    {
      input: {},
      proposal: proposal({ reviewAfterHours: 2 }),
      tokens: 1000,
    },
    true,
    T0 + 1000,
  );
  assert.equal(d.status, "pending");

  // 2. claimIntent y acceptInternalOrder, juntos como en la transacción del worker.
  const t2 = T0 + 2000;
  const intent = claimIntent(s, true, t2)!;
  assert.equal(intent.id, d.id);
  const real = s.decisions.find((x) => x.id === d.id)!;
  const order = acceptInternalOrder(s, real, t2);
  assert.equal(order.status, "new", "a 200 no cruza su límite de 199");
  assert.equal(real.status, "new");
  assert.equal(real.orderId, order.id);
  assert.equal(s.queue.length, 0);

  // 3. El precio baja y la orden se ejecuta a su límite.
  const t3 = T0 + 60000;
  s.quotes.AAPL = { price: 198.8, at: iso(t3) };
  assert.equal(simulateFills(s, t3 + 1000), 1);
  assert.equal(real.status, "filled");
  assert.deepEqual(
    [s.fills[0].price, s.fills[0].rule, s.fills[0].decisionId],
    [199, "resting", d.id],
  );
  assert.equal(s.account.cash, 100000 - 1990);
  assert.equal(s.positions[0].qty, 10);
  assert.equal(
    s.queue.length,
    0,
    "una compra ejecutada no despierta al agente",
  );
  assert.match(orderNotice(s, real, real.status)!.text, /Orden ejecutada/);

  // 4. La siguiente revisión periódica lo despierta.
  const t4 = t3 + s.settings.cooldownSeconds * 1000 + 2000;
  enqueue(s, "Revisión periódica del mercado", "periodic");
  const job2 = claimJob(s, true, t4)!;
  assert.match(job2.event!, /Revisión periódica/);
  applyDecision(
    s,
    job2,
    {
      input: {},
      proposal: proposal({
        action: "wait",
        symbol: null,
        qty: null,
        limitPrice: null,
      }),
      tokens: 800,
    },
    true,
    t4,
  );

  // 5. Pasado su plazo, la compra se revisa.
  const t5 = T0 + 2 * 3600000 + 10 * 60000;
  const job3 = claimJob(s, true, t5)!;
  assert.equal(job3.due?.id, d.id);
  const revisada = applyReview(
    s,
    job3,
    { text: "Entró en el soporte y rebotó", lessons: [] },
    { tokens: 500 },
    t5,
  )!;
  assert.equal(revisada.review?.text, "Entró en el soporte y rebotó");
  assert.equal(s.modelJob, null);
  assert.equal(s.usage.length, 3);
});
