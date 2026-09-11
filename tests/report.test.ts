import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  proposalSchema,
  now,
  id,
  type State,
  type Decision,
} from "../src/domain.ts";
import {
  usableStory,
  mergeStories,
  summarise,
  type Story,
} from "../src/news.ts";
import { escapeHtml } from "../src/telegram.ts";
import {
  decisionNotice,
  orderNotice,
  reviewNotice,
  problemNotice,
  newsNotice,
  QUIET_HOURS,
} from "../src/report.ts";
import { applyDecision } from "../src/agent.ts";
const ALLOWED = ["SPY", "AAPL", "TSLA"];
const cruda = (over: Record<string, unknown> = {}) => ({
  id: "1001",
  created_at: new Date().toISOString(),
  source: "benzinga",
  headline: "Morgan Stanley ve una oportunidad en el camión de Tesla",
  summary: "El banco estima el mercado en 80.000 millones.",
  symbols: ["TSLA"],
  url: "https://ejemplo.test/noticia",
  ...over,
});
function state(): State {
  const s = initialState();
  s.paused = false;
  s.settings.symbols = ALLOWED;
  s.account = { status: "ACTIVE", equity: "100000", cash: "95000" };
  s.quotes.TSLA = { price: 365.4, at: now() };
  return s;
}
const proposal = (over: Record<string, unknown> = {}) =>
  proposalSchema.parse({
    action: "buy",
    symbol: "TSLA",
    qty: 13,
    limitPrice: 365.4,
    reason: "Motivo suficientemente largo para el esquema",
    hypothesis: "Espero que aguante por encima de 355",
    reviewAfterHours: 24,
    notify: true,
    note: "Compro Tesla porque la noticia del camión no se ha recogido aún en el precio",
    watches: [],
    lessons: [],
    ...over,
  });
const decision = (over: Record<string, unknown> = {}): Decision => ({
  id: id(),
  at: now(),
  versionId: "v1",
  event: "prueba",
  input: null,
  proposal: proposal(),
  status: "pending",
  reviewAt: now(),
  ...over,
});
test("A story only counts when it names one of the watched assets", () => {
  assert.ok(usableStory(cruda(), ALLOWED));
  assert.equal(usableStory(cruda({ symbols: ["NFLX"] }), ALLOWED), null);
  assert.equal(usableStory(cruda({ symbols: [] }), ALLOWED), null);
  // Una noticia sobre varios activos se queda solo con los propios.
  const varios = usableStory(
    cruda({ symbols: ["NFLX", "TSLA", "NVDA"] }),
    ALLOWED,
  )!;
  assert.deepEqual(varios.symbols, ["TSLA"]);
});
test("Malformed stories are discarded instead of half-saved", () => {
  assert.equal(usableStory(cruda({ headline: "" }), ALLOWED), null);
  assert.equal(usableStory(cruda({ created_at: "ayer" }), ALLOWED), null);
  assert.equal(usableStory(cruda({ id: null }), ALLOWED), null);
  assert.equal(usableStory(null, ALLOWED), null);
});
test("Long text is trimmed and whitespace collapsed", () => {
  const s = usableStory(
    cruda({
      headline: "  titular   con    espacios  ",
      summary: "x".repeat(900),
    }),
    ALLOWED,
  )!;
  assert.equal(s.headline, "titular con espacios");
  assert.equal(s.summary.length, 600);
});
test("Only genuinely new stories are reported as new", () => {
  const uno = mergeStories(
    [],
    [cruda({ id: "a" }), cruda({ id: "b" })],
    ALLOWED,
  );
  assert.equal(uno.stories.length, 2);
  assert.equal(uno.fresh.length, 2);
  // La misma tanda otra vez no aporta ninguna novedad.
  const dos = mergeStories(
    uno.stories,
    [cruda({ id: "a" }), cruda({ id: "b" })],
    ALLOWED,
  );
  assert.equal(dos.fresh.length, 0);
  assert.equal(dos.stories.length, 2);
  const tres = mergeStories(dos.stories, [cruda({ id: "c" })], ALLOWED);
  assert.equal(tres.fresh.length, 1);
  assert.equal(tres.stories.length, 3);
});
test("Stale stories and stories about dropped assets are forgotten", () => {
  const vieja: Story = {
    id: "vieja",
    at: new Date(Date.now() - 72 * 3600000).toISOString(),
    source: "x",
    headline: "titular",
    summary: "",
    symbols: ["TSLA"],
    url: "",
  };
  const ajena: Story = { ...vieja, id: "ajena", at: now(), symbols: ["MSFT"] };
  const r = mergeStories([vieja, ajena], [], ALLOWED);
  assert.equal(r.stories.length, 0);
});
test("The wake-up message names the assets and counts the rest", () => {
  const fresh = Array.from({ length: 6 }, (_, i) =>
    usableStory(cruda({ id: String(i), headline: `Titular ${i}` }), ALLOWED)!,
  );
  const texto = summarise(fresh);
  assert.match(texto, /6 noticias nuevas/);
  assert.match(texto, /TSLA/);
  assert.match(texto, /y 2 más/);
  assert.match(summarise(fresh.slice(0, 1)), /1 noticia nueva/);
});
test("Buying and being blocked are always reported", () => {
  const s = state();
  const compra = decisionNotice(s, decision())!;
  assert.equal(compra.kind, "operacion");
  assert.match(compra.text, /COMPRA/);
  assert.match(compra.text, /13 acciones/);
  assert.match(compra.text, /Qué espera/);
  const bloqueada = decisionNotice(
    s,
    decision({ status: "blocked", error: "Saldo insuficiente" }),
  )!;
  assert.match(bloqueada.text, /NO SE ENVIÓ/);
  assert.match(bloqueada.text, /Saldo insuficiente/);
});
test("Waiting is only reported when the agent asks and enough time has passed", () => {
  const s = state();
  const espera = decision({
    proposal: proposal({
      action: "wait",
      symbol: null,
      qty: null,
      limitPrice: null,
    }),
    status: "observed",
  });
  assert.ok(decisionNotice(s, espera), "la primera vez sí se cuenta");
  // El agente dice que no merece la pena contarlo.
  const callado = decision({
    proposal: proposal({
      action: "wait",
      symbol: null,
      qty: null,
      limitPrice: null,
      notify: false,
    }),
    status: "observed",
  });
  assert.equal(decisionNotice(s, callado), null);
  // Acaba de avisar de una espera: no repite hasta pasadas las horas de silencio.
  s.lastNotice = { at: now(), kind: "espera" };
  assert.equal(decisionNotice(s, espera), null);
  const t = Date.now() + (QUIET_HOURS + 1) * 3600000;
  assert.ok(
    decisionNotice(s, espera, t),
    "pasadas las horas de silencio vuelve",
  );
  // Una compra no queda nunca en silencio, aunque acabe de avisar.
  s.lastNotice = { at: now(), kind: "operacion" };
  assert.ok(decisionNotice(s, decision()));
});
test("Order notices only fire on outcomes the owner cares about", () => {
  const s = state();
  s.positions = [
    { symbol: "TSLA", qty: "13", market_value: "4750", unrealized_pl: "30" },
  ];
  const d = decision({ status: "filled" });
  const ejecutada = orderNotice(s, d, "filled")!;
  assert.match(ejecutada.text, /ejecutada/);
  assert.match(ejecutada.text, /Ahora tienes 13 de TSLA/);
  assert.match(orderNotice(s, d, "rejected")!.text, /rechazada por Alpaca/);
  // Estados intermedios no interrumpen al propietario.
  assert.equal(orderNotice(s, d, "new"), null);
  assert.equal(orderNotice(s, d, "accepted"), null);
});
test("Reviews are reported only for decisions that actually traded", () => {
  const s = state();
  const operada = decision({
    status: "filled",
    review: { at: now(), text: "El proceso fue razonable", price: 370 },
  });
  const aviso = reviewNotice(s, operada)!;
  assert.match(aviso.text, /Revisión/);
  assert.match(aviso.text, /365,40 USD a 370,00 USD/);
  const esperada = decision({
    proposal: proposal({
      action: "wait",
      symbol: null,
      qty: null,
      limitPrice: null,
    }),
    review: { at: now(), text: "Esperar estuvo bien", price: null },
  });
  assert.equal(reviewNotice(s, esperada), null);
  assert.equal(reviewNotice(s, decision()), null, "sin revisión no hay aviso");
});
test("Text from the model and from third parties cannot break the message", () => {
  assert.equal(
    escapeHtml("<b>hola</b> & <i>adiós</i>"),
    "&lt;b&gt;hola&lt;/b&gt; &amp; &lt;i&gt;adiós&lt;/i&gt;",
  );
  const s = state();
  const d = decision({
    proposal: proposal({
      note: "Compro <b>TSLA</b> & subo, mira <script>alert(1)</script>",
    }),
  });
  const aviso = decisionNotice(s, d)!;
  assert.ok(!aviso.text.includes("<script>"), "no debe colarse marcado ajeno");
  assert.match(aviso.text, /&lt;script&gt;/);
});
test("A problem notice points at the panel", () => {
  const aviso = problemNotice("La orden quedó en estado incierto");
  assert.equal(aviso.kind, "problema");
  assert.match(aviso.text, /Algo va mal/);
  assert.match(aviso.text, /meridian\.code-hive\.space/);
});
const story = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  at: now(),
  source: "benzinga",
  headline: "Morgan Stanley ve una oportunidad en el camión de Tesla",
  summary: "",
  symbols: ["TSLA"],
  url: "",
  ...over,
});
const job = (s: State, event = "noticias") => ({
  meta: {
    id: id(),
    startedAt: now(),
    kind: "decision" as const,
    targetId: id(),
  },
  state: structuredClone(s),
  due: null,
  event,
});
const waiting = (over: Record<string, unknown> = {}) =>
  proposal({
    action: "wait",
    symbol: null,
    qty: null,
    limitPrice: null,
    ...over,
  });
test("Each comment stays with the story the agent was actually shown", () => {
  const s = state();
  s.stories = [
    story({ id: "a", headline: "Titular sobre Tesla", symbols: ["TSLA"] }),
    story({ id: "b", headline: "Titular sobre el índice", symbols: ["SPY"] }),
  ];
  const j = job(s);
  // Mientras el modelo piensa entra otra noticia: no debe descolocar nada.
  s.stories.push(story({ id: "c", headline: "Titular que llegó después" }));
  const d = applyDecision(
    s,
    j,
    {
      input: {},
      proposal: waiting({
        newsComments: [
          {
            ref: "N1",
            matters: false,
            comment: "Tesis a largo plazo, no cambia nada hoy",
          },
          {
            ref: "N2",
            matters: true,
            comment: "Dato ya recogido por el precio",
          },
        ],
      }),
      tokens: 1,
    },
    true,
  );
  assert.deepEqual(
    d.newsCommented,
    [
      {
        storyId: "a",
        comment: "Tesis a largo plazo, no cambia nada hoy",
        matters: false,
      },
      {
        storyId: "b",
        comment: "Dato ya recogido por el precio",
        matters: true,
      },
    ],
    "N1 es la primera que se le enseñó, N2 la segunda",
  );
  const aviso = newsNotice(s, d)!;
  assert.match(aviso.text, /2 noticias nuevas/);
  // Cada comentario aparece pegado a su propio titular.
  const tesla = aviso.text.indexOf("Titular sobre Tesla");
  const largoPlazo = aviso.text.indexOf("Tesis a largo plazo");
  const indice = aviso.text.indexOf("Titular sobre el índice");
  assert.ok(tesla < largoPlazo && largoPlazo < indice);
});
test("A story is commented once, and unknown references are ignored", () => {
  const s = state();
  s.stories = [story({ id: "a" })];
  const j = job(s);
  applyDecision(
    s,
    j,
    {
      input: {},
      proposal: waiting({
        newsComments: [
          { ref: "N1", matters: false, comment: "Ruido, no cambia nada" },
        ],
      }),
      tokens: 1,
    },
    true,
  );
  assert.equal(s.stories[0].commented, true);
  // Ya comentada: en la siguiente evaluación no se le ofrece ni se repite.
  const segundo = applyDecision(
    s,
    job(s),
    {
      input: {},
      proposal: waiting({
        newsComments: [
          { ref: "N1", matters: false, comment: "Otra vez lo mismo" },
        ],
      }),
      tokens: 1,
    },
    true,
  );
  assert.deepEqual(segundo.newsCommented, []);
  assert.equal(newsNotice(s, segundo), null);
});
test("Short references are what the schema accepts, not raw provider ids", () => {
  assert.throws(() =>
    waiting({
      newsComments: [
        { ref: "61747603", matters: false, comment: "x".repeat(20) },
      ],
    }),
  );
  assert.throws(() =>
    waiting({
      newsComments: [{ ref: "n1", matters: false, comment: "x".repeat(20) }],
    }),
  );
  assert.ok(
    waiting({
      newsComments: [{ ref: "N12", matters: false, comment: "x".repeat(20) }],
    }),
  );
});
test("The heading says at a glance how many stories actually matter", () => {
  const s = state();
  s.stories = [
    story({ id: "a", headline: "Titular que importa" }),
    story({ id: "b", headline: "Titular que no importa" }),
  ];
  const conImportante = decision({
    newsCommented: [
      { storyId: "a", comment: "Esto sí cambia algo", matters: true },
      { storyId: "b", comment: "Esto es ruido", matters: false },
    ],
  });
  const aviso = newsNotice(s, conImportante)!;
  assert.match(aviso.text, /2 noticias nuevas · 1 importa/);
  assert.match(aviso.text, /❗ .*Titular que importa/);
  assert.match(aviso.text, /➖ .*Titular que no importa/);
  const soloRuido = decision({
    newsCommented: [{ storyId: "a", comment: "Ruido", matters: false }],
  });
  assert.match(newsNotice(s, soloRuido)!.text, /ninguna cambia nada/);
});
test("A news comment stays short enough to read on a phone", () => {
  // Un comentario largo se rechaza en el esquema, antes de llegar a Telegram.
  assert.throws(() =>
    proposal({
      newsComments: [{ ref: "N1", matters: false, comment: "x".repeat(400) }],
    }),
  );
  assert.ok(
    proposal({
      newsComments: [{ ref: "N1", matters: false, comment: "x".repeat(300) }],
    }),
  );
});
