import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  proposalSchema,
  limitPriceString,
  prune,
  pruneEquity,
  now,
  id,
  type State,
} from "../src/domain.ts";
import {
  applyMarket,
  applySnapshot,
  claimIntent,
  claimJob,
  applyDecision,
  applyReview,
  type Job,
} from "../src/agent.ts";
function state(): State {
  const s = initialState();
  s.paused = false;
  s.account = { status: "ACTIVE", equity: "10000", cash: "10000" };
  s.baseline = 10000;
  s.lastSync = now();
  s.quotes.AAPL = { price: 200, at: now() };
  return s;
}
const proposal = (over: Record<string, unknown> = {}) =>
  proposalSchema.parse({
    action: "buy",
    symbol: "AAPL",
    qty: 1,
    limitPrice: 200,
    reason: "Hipótesis basada en precio",
    hypothesis: "Esperar confirmación",
    reviewAfterHours: 24,
    watches: [],
    lessons: [],
    ...over,
  });
const waiting = () =>
  proposal({ action: "wait", symbol: null, qty: null, limitPrice: null });
const job = (s: State, event = "Prueba"): Job => ({
  meta: { id: id(), startedAt: now(), kind: "decision", targetId: id() },
  state: structuredClone(s),
  due: null,
  event,
});
const decision = (s: State, over: Record<string, unknown> = {}) => ({
  id: id(),
  at: now(),
  versionId: s.activeVersion,
  event: "evento",
  input: null,
  proposal: proposal(),
  status: "observed",
  reviewAt: now(),
  ...over,
});
test("Limit prices keep four decimals below one dollar", () => {
  assert.equal(limitPriceString(200), "200.00");
  assert.equal(limitPriceString(0.4321), "0.4321");
  assert.equal(limitPriceString(1), "1.00");
});
test("A saved intention is only sent while the market is open", () => {
  const s = state();
  s.decisions = [decision(s, { status: "pending" })];
  assert.equal(claimIntent(s, false), null);
  assert.equal(s.decisions[0].status, "blocked");
  assert.match(s.decisions[0].error!, /Mercado cerrado/);
  s.decisions[0].status = "pending";
  const intent = claimIntent(s, true);
  assert.ok(intent);
  assert.equal(s.decisions[0].status, "submitting");
  assert.ok(s.decisions[0].sentAt);
});
test("Model work is reserved only when pause, budget and cooldown allow it", () => {
  const s = state();
  s.queue = [{ id: id(), reason: "Evento", at: now() }];
  s.paused = true;
  assert.equal(claimJob(s, true), null);
  s.paused = false;
  assert.equal(claimJob(s, false), null);
  assert.ok(claimJob(s, true));
  assert.equal(s.calls.count, 1);
  assert.equal(s.queue.length, 0);
  assert.ok(s.modelJob);
  s.modelJob = null;
  s.queue = [{ id: id(), reason: "Otro", at: now() }];
  assert.equal(claimJob(s, true), null, "la espera mínima debe impedirlo");
  s.lastDecision = null;
  s.calls.count = s.settings.maxDailyCalls;
  assert.equal(claimJob(s, true), null, "el límite diario debe impedirlo");
});
test("A due review is preferred over a queued event and retries at most three times", () => {
  const s = state();
  s.decisions = [
    decision(s, {
      proposal: waiting(),
      reviewAt: new Date(Date.now() - 1000).toISOString(),
    }),
  ];
  s.queue = [{ id: id(), reason: "Evento", at: now() }];
  assert.equal(claimJob(s, true)?.meta.kind, "review");
  assert.equal(s.queue.length, 1, "el evento sigue en cola");
  assert.equal(s.decisions[0].reviewAttempts, 1);
  s.decisions[0].reviewAttempts = 3;
  s.modelJob = null;
  s.lastDecision = null;
  assert.equal(claimJob(s, true)?.meta.kind, "decision");
});
test("An interrupted evaluation is cleared and reported once", () => {
  const s = state();
  s.modelJob = { id: id(), startedAt: now(), kind: "decision", targetId: id() };
  claimJob(s, true);
  assert.equal(s.modelJob, null);
  assert.match(s.events[0].message, /interrumpida/);
});
test("Waiting is stored as an observation and never becomes an order", () => {
  const s = state();
  const d = applyDecision(
    s,
    job(s),
    { input: {}, proposal: waiting(), tokens: 10 },
    true,
  );
  assert.equal(d.status, "observed");
  assert.equal(s.usage.at(-1)!.tokens, 10);
});
test("A proposal is blocked when settings changed during the evaluation", () => {
  const s = state();
  const stale = job(s);
  s.settings.maxOrderUsd = 900;
  const d = applyDecision(
    s,
    stale,
    { input: {}, proposal: proposal(), tokens: 1 },
    true,
  );
  assert.equal(d.status, "blocked");
  assert.match(d.error!, /Configuración modificada/);
});
test("An accepted proposal saves its watches and proposed lessons", () => {
  const s = state();
  const d = applyDecision(
    s,
    job(s),
    {
      input: {},
      proposal: proposal({
        watches: [
          {
            symbol: "AAPL",
            operator: "lte",
            price: 190,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            reason: "Reevaluar si cae",
            invalidateBelow: null,
            invalidateAbove: null,
          },
        ],
        lessons: [
          {
            title: "Una hipótesis",
            body: "Cuerpo suficientemente largo",
            source: "prueba",
          },
        ],
      }),
      tokens: 5,
    },
    true,
  );
  assert.equal(d.status, "pending");
  assert.equal(s.watches.length, 1);
  assert.equal(s.watches[0].decisionId, d.id);
  assert.equal(s.lessons[0].status, "proposed");
});
test("A review stores its text and leaves its lessons as proposals", () => {
  const s = state();
  const target = decision(s, { status: "filled" });
  s.decisions = [target];
  const reviewJob: Job = {
    meta: { id: id(), startedAt: now(), kind: "review", targetId: target.id },
    state: structuredClone(s),
    due: structuredClone(target),
  };
  applyReview(
    s,
    reviewJob,
    {
      text: "El proceso fue razonable pese al resultado.",
      lessons: [
        { title: "Título", body: "Cuerpo de la lección", source: target.id },
      ],
    },
    42,
  );
  assert.equal(s.decisions[0].review!.price, 200);
  assert.equal(s.lessons[0].status, "proposed");
  assert.equal(s.modelJob, null);
});
test("A filled order queues a new evaluation and sets the first baseline", () => {
  const s = state();
  s.baseline = null;
  s.decisions = [decision(s, { id: "order-1", status: "new" })];
  applySnapshot(s, {
    account: { equity: "9500", cash: "100", status: "ACTIVE" },
    positions: [],
    orders: [{ client_order_id: "order-1", id: "alpaca-1", status: "filled" }],
    trades: { trades: { AAPL: { p: 210, t: now() } } },
    clock: { is_open: true },
  });
  assert.equal(s.baseline, 9500);
  assert.equal(s.decisions[0].status, "filled");
  assert.equal(s.decisions[0].orderId, "alpaca-1");
  assert.equal(s.quotes.AAPL.price, 210);
  assert.equal(s.equity.length, 1);
  assert.match(s.queue[0].reason, /Orden ejecutada/);
});
test("While paused no price condition fires", () => {
  const s = state();
  s.watches = [
    {
      id: id(),
      symbol: "AAPL",
      operator: "lte",
      price: 300,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      reason: "Reevaluar",
      invalidateBelow: null,
      invalidateAbove: null,
      status: "active",
      createdAt: now(),
    },
  ];
  s.paused = true;
  applyMarket(s, { AAPL: { price: 100, at: now() } }, true, Date.now());
  assert.equal(s.watches[0].status, "active");
  assert.equal(s.queue.length, 0);
  s.paused = false;
  applyMarket(s, { AAPL: { price: 100, at: now() } }, true, Date.now());
  assert.equal(s.watches[0].status, "triggered");
  assert.equal(s.queue.length, 1);
});
test("The stream is reported as disconnected after two minutes without trades", () => {
  const s = state();
  applyMarket(s, {}, true, Date.now());
  assert.equal(s.stream, "connected");
  applyMarket(s, {}, true, Date.now() - 200000);
  assert.equal(s.stream, "disconnected");
  applyMarket(s, {}, false, Date.now());
  assert.equal(s.stream, "disconnected");
});
test("Equity keeps recent samples in full and one per hour before that", () => {
  const t = Date.parse("2026-01-20T12:00:00Z");
  const points = Array.from({ length: 4000 }, (_, i) => ({
    at: new Date(t - (4000 - i) * 300000).toISOString(),
    value: i,
  }));
  const pruned = pruneEquity(points, t);
  assert.ok(pruned.length < points.length);
  assert.equal(pruned.at(-1)!.value, points.at(-1)!.value);
  const cut = t - 3 * 86400000;
  const recent = points.filter((p) => Date.parse(p.at) >= cut);
  assert.equal(
    pruned.filter((p) => Date.parse(p.at) >= cut).length,
    recent.length,
  );
  const old = pruned.filter((p) => Date.parse(p.at) < cut);
  assert.ok(old.length > 0);
  for (let i = 1; i < old.length; i++)
    assert.ok(Date.parse(old[i].at) - Date.parse(old[i - 1].at) >= 3600000);
});
test("Pruning bounds history and drops the saved context of old decisions", () => {
  const s = state();
  s.decisions = Array.from({ length: 2600 }, () =>
    decision(s, { input: { heavy: "x".repeat(100) } }),
  );
  s.events = Array.from({ length: 1500 }, () => ({
    id: id(),
    at: now(),
    type: "t",
    message: "m",
  }));
  prune(s);
  assert.equal(s.decisions.length, 2000);
  assert.equal(s.events.length, 1000);
  assert.equal(s.decisions[0].input, null);
  assert.notEqual(s.decisions.at(-1)!.input, null);
});
test("Pruning never drops accepted lessons or active watches", () => {
  const s = state();
  const lesson = (
    status: "rejected" | "accepted",
    lessonId: string = id(),
  ) => ({
    id: lessonId,
    title: "Título",
    body: "Cuerpo",
    source: "fuente",
    status,
    createdAt: now(),
  });
  const watch = (status: "expired" | "active", watchId: string = id()) => ({
    id: watchId,
    symbol: "AAPL",
    operator: "lte" as const,
    price: 1,
    expiresAt: now(),
    reason: "motivo",
    invalidateBelow: null,
    invalidateAbove: null,
    status,
    createdAt: now(),
  });
  s.lessons = [
    ...Array.from({ length: 600 }, () => lesson("rejected")),
    lesson("accepted", "kept"),
  ];
  s.watches = [
    ...Array.from({ length: 600 }, () => watch("expired")),
    watch("active", "vigilando"),
  ];
  prune(s);
  assert.ok(s.lessons.some((l) => l.id === "kept"));
  assert.equal(s.lessons.filter((l) => l.status === "rejected").length, 500);
  assert.ok(s.watches.some((w) => w.id === "vigilando"));
  assert.equal(s.watches.filter((w) => w.status !== "active").length, 500);
});
