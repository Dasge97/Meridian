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
  applyNews,
  queueNewsBeforeOpen,
  failJob,
  queueSessionScan,
  NEWS_REVIEW_REASON,
  SCAN_REASON,
  type Job,
} from "../src/agent.ts";
function state(): State {
  const s = initialState();
  s.paused = false;
  s.account = { status: "ACTIVE", equity: "10000", cash: "10000" };
  s.baseline = 10000;
  s.lastSync = now();
  s.quotes.AAPL = { price: 200, at: now() };
  // Sesión abierta durante la próxima hora, salvo que la prueba diga otra cosa.
  s.market = {
    open: true,
    nextOpen: null,
    nextClose: new Date(Date.now() + 3600000).toISOString(),
  };
  return s;
}
// La bolsa cerrada, con la apertura dentro de los minutos indicados.
function closed(s: State, minutesToOpen: number) {
  s.market = {
    open: false,
    nextOpen: new Date(Date.now() + minutesToOpen * 60000).toISOString(),
    nextClose: new Date(
      Date.now() + (minutesToOpen + 390) * 60000,
    ).toISOString(),
  };
  return s;
}
const rawStory = (storyId: string) => ({
  id: storyId,
  created_at: now(),
  source: "benzinga",
  headline: "Titular sobre Apple",
  summary: "Resumen",
  symbols: ["AAPL"],
  url: "https://ejemplo.test",
});
const proposal = (over: Record<string, unknown> = {}) =>
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
test("A queued event goes before a due review, and a review retries at most three times", () => {
  const s = state();
  s.decisions = [
    decision(s, {
      status: "filled",
      orderId: "alpaca-1",
      reviewAt: new Date(Date.now() - 1000).toISOString(),
    }),
  ];
  s.queue = [{ id: id(), reason: "Vigilancia cumplida", at: now() }];
  assert.equal(claimJob(s, true)?.meta.kind, "decision");
  assert.equal(s.queue.length, 0);
  assert.equal(s.decisions[0].reviewAttempts, undefined, "la revisión espera");
  s.modelJob = null;
  s.lastDecision = null;
  assert.equal(claimJob(s, true)?.meta.kind, "review");
  assert.equal(s.decisions[0].reviewAttempts, 1);
  s.decisions[0].reviewAttempts = 3;
  s.modelJob = null;
  s.lastDecision = null;
  assert.equal(claimJob(s, true), null, "tras tres intentos no se insiste");
});
test("Only decisions that sent an order are reviewed", () => {
  const s = state();
  const pasada = new Date(Date.now() - 1000).toISOString();
  s.decisions = [
    decision(s, { proposal: waiting(), reviewAt: pasada }),
    decision(s, { status: "blocked", reviewAt: pasada }),
    decision(s, { status: "filled", orderId: "alpaca-1", reviewAt: pasada }),
  ];
  const trabajo = claimJob(s, true);
  assert.equal(trabajo?.due?.id, s.decisions[2].id, "la compra enviada sí");
  assert.match(s.decisions[0].reviewSkipped!, /esperas no se revisan/);
  assert.match(s.decisions[1].reviewSkipped!, /ninguna orden/);
  const futura = decision(s, {
    proposal: waiting(),
    reviewAt: new Date(Date.now() + 3600000).toISOString(),
  });
  s.decisions.push(futura);
  s.modelJob = null;
  s.lastDecision = null;
  claimJob(s, true);
  assert.equal(s.decisions.at(-1)!.reviewSkipped, undefined, "aún no le toca");
});
test("The market is scanned every half hour during the session", () => {
  // Lunes 14 de septiembre de 2026 a las 11:00 en Nueva York.
  const T = Date.parse("2026-09-14T15:00:00Z");
  const hace = (minutos: number) => new Date(T - minutos * 60000).toISOString();
  const sesion = {
    open: true,
    nextOpen: null,
    nextClose: "2026-09-14T20:00:00Z",
  };
  const s = state();
  s.market = { ...sesion };
  assert.equal(queueSessionScan(s, T), true, "sin evaluaciones previas");
  assert.equal(s.queue[0].reason, SCAN_REASON);
  assert.equal(queueSessionScan(s, T), false, "ya hay algo en cola");
  s.queue = [];
  s.lastDecision = hace(10);
  assert.equal(queueSessionScan(s, T), false, "evaluó hace 10 minutos");
  s.lastDecision = hace(31);
  assert.equal(queueSessionScan(s, T), true);
  s.queue = [];
  s.lastDecision = null;
  assert.equal(
    queueSessionScan(s, Date.parse("2026-09-14T13:35:00Z")),
    false,
    "a los 5 minutos de abrir aún no hay velas de la sesión",
  );
  assert.equal(queueSessionScan(s, Date.parse("2026-09-14T13:41:00Z")), true);
  s.queue = [];
  assert.equal(
    queueSessionScan(s, Date.parse("2026-09-14T19:50:00Z")),
    false,
    "a 10 minutos del cierre no",
  );
  const cerrada = state();
  cerrada.market = { ...sesion, open: false };
  assert.equal(queueSessionScan(cerrada, T), false, "cerrada no");
  const pausado = state();
  pausado.market = { ...sesion };
  pausado.paused = true;
  assert.equal(queueSessionScan(pausado, T), false);
});
test("A failed evaluation puts its event back once, then drops it", () => {
  const s = state();
  s.queue = [{ id: id(), reason: "Vigilancia cumplida", at: now() }];
  const primero = claimJob(s, true)!;
  failJob(s, primero, "la respuesta no cumple el esquema");
  assert.equal(s.modelJob, null);
  assert.equal(s.queue.length, 1);
  assert.equal(s.queue[0].attempts, 1);
  assert.match(s.events[0].message, /segundo intento/);
  s.lastDecision = null;
  const segundo = claimJob(s, true)!;
  failJob(s, segundo, "otra vez mal");
  assert.equal(s.queue.length, 0);
  assert.match(s.events[0].message, /se descarta/);
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
test("An accepted proposal saves its watches but no lessons", () => {
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
  assert.equal(
    s.lessons.length,
    0,
    "una decisión ve noticias de terceros: de ahí no nace una lección",
  );
});
test("A review stores its text and adopts its lessons in a new version", () => {
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
  assert.equal(s.lessons[0].status, "accepted", "entra sola en la memoria");
  assert.equal(s.lessons[0].decisionId, target.id);
  assert.equal(s.versions.length, 2, "con su propia versión");
  assert.deepEqual(s.versions.at(-1)!.lessonIds, [s.lessons[0].id]);
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
test("A price condition only fires during the regular session", () => {
  const s = closed(state(), 60);
  s.watches = [
    {
      id: id(),
      symbol: "AAPL",
      operator: "lte",
      price: 300,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      reason: "Reevaluar",
      invalidateBelow: null,
      invalidateAbove: null,
      status: "active",
      createdAt: now(),
    },
  ];
  // Operación de antes de la apertura: no debe gastar la vigilancia.
  applyMarket(s, { AAPL: { price: 100, at: now() } }, true, Date.now());
  assert.equal(s.watches[0].status, "active");
  assert.equal(s.queue.length, 0);
  s.market = {
    open: true,
    nextOpen: null,
    nextClose: new Date(Date.now() - 1000).toISOString(),
  };
  applyMarket(s, { AAPL: { price: 100, at: now() } }, true, Date.now());
  assert.equal(
    s.watches[0].status,
    "active",
    "pasado el cierre tampoco, aunque el calendario siga diciendo abierta",
  );
});
test("With the market closed news is saved but does not wake the agent", () => {
  const s = closed(state(), 600);
  assert.equal(applyNews(s, [rawStory("1")]), 1);
  assert.equal(s.stories.length, 1);
  assert.equal(s.queue.length, 0);
  assert.match(s.events[0].message, /antes de la apertura/);
  const abierta = state();
  applyNews(abierta, [rawStory("2")]);
  assert.equal(abierta.queue.length, 1, "con la bolsa abierta sí despierta");
  const sinCalendario = closed(state(), 600);
  sinCalendario.feeds.clock = false;
  applyNews(sinCalendario, [rawStory("3")]);
  assert.equal(
    sinCalendario.queue.length,
    1,
    "sin calendario no se arriesga a perderla",
  );
});
test("Pending news is reviewed once, in the half hour before the opening", () => {
  const s = closed(state(), 600);
  applyNews(s, [rawStory("1"), rawStory("2")]);
  assert.equal(queueNewsBeforeOpen(s), false, "faltan diez horas");
  closed(s, 20);
  s.market.nextClose = new Date(Date.now() + 410 * 60000).toISOString();
  assert.equal(queueNewsBeforeOpen(s), true);
  assert.equal(s.queue.length, 1);
  assert.match(s.queue[0].reason, new RegExp(NEWS_REVIEW_REASON));
  assert.match(s.queue[0].reason, /2 noticias/);
  s.queue = [];
  assert.equal(queueNewsBeforeOpen(s), false, "una sola vez por sesión");
  // Ya abierta, la misma sesión no vuelve a encolarlo.
  s.market.open = true;
  assert.equal(queueNewsBeforeOpen(s), false);
  const sinNoticias = closed(state(), 20);
  assert.equal(queueNewsBeforeOpen(sinNoticias), false, "nada que comentar");
});
test("If the worker missed the half hour, pending news is reviewed at the opening", () => {
  const s = closed(state(), 600);
  applyNews(s, [rawStory("1")]);
  s.market = {
    open: true,
    nextOpen: null,
    nextClose: new Date(Date.now() + 3600000).toISOString(),
  };
  assert.equal(queueNewsBeforeOpen(s), true);
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
test("A missing price or calendar feed still syncs the account and warns once", () => {
  const s = state();
  applySnapshot(s, {
    account: { equity: "9000", cash: "9000", status: "ACTIVE" },
    positions: [],
    orders: [],
    trades: null,
    clock: null,
  });
  assert.equal(s.account.equity, "9000", "la cuenta se sincroniza igual");
  assert.equal(s.feeds.trades, false);
  assert.equal(s.feeds.clock, false);
  assert.equal(s.events.length, 2, "un aviso por cada origen de datos caído");
  applySnapshot(s, {
    account: { equity: "9000", cash: "9000", status: "ACTIVE" },
    positions: [],
    orders: [],
    trades: null,
    clock: null,
  });
  assert.equal(
    s.events.length,
    2,
    "no se repite el aviso en cada sincronización",
  );
  applySnapshot(s, {
    account: { equity: "9000", cash: "9000", status: "ACTIVE" },
    positions: [],
    orders: [],
    trades: { trades: { AAPL: { p: 205, t: now() } } },
    clock: { is_open: true },
  });
  assert.equal(s.feeds.trades, true);
  assert.equal(s.feeds.clock, true);
  assert.equal(s.quotes.AAPL.price, 205);
  assert.equal(s.events.length, 4, "también se avisa de la recuperación");
});
test("Removing an asset from the list also drops its stale price", () => {
  const s = state();
  s.quotes.MSFT = { price: 495, at: now() };
  applyMarket(s, {}, true, Date.now());
  assert.ok(s.quotes.MSFT, "mientras está permitido, su precio se conserva");
  // El propietario lo quita de la lista desde Configuración.
  s.settings.symbols = ["SPY", "AAPL"];
  applyMarket(s, {}, true, Date.now());
  assert.ok(s.quotes.AAPL, "un activo permitido se conserva");
  assert.equal(s.quotes.MSFT, undefined, "un activo retirado no deja precio");
});
test("The agent is told whether the market is open and when it reopens", () => {
  assert.equal(
    initialState().market.open,
    false,
    "al empezar se asume cerrada",
  );
  const s = state();
  applySnapshot(s, {
    account: { equity: "100000", cash: "100000", status: "ACTIVE" },
    positions: [],
    orders: [],
    trades: null,
    clock: {
      is_open: true,
      next_open: "2026-09-14T13:30:00Z",
      next_close: "2026-09-11T20:00:00Z",
    },
  });
  assert.equal(s.market.open, true);
  assert.equal(s.market.nextOpen, "2026-09-14T13:30:00Z");
  // Sin calendario se conserva lo último que se supo, en vez de inventarlo.
  applySnapshot(s, {
    account: { equity: "100000", cash: "100000", status: "ACTIVE" },
    positions: [],
    orders: [],
    trades: null,
    clock: null,
  });
  assert.equal(s.market.open, true);
});
