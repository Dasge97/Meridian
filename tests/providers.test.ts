import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alpaca,
  PAPER,
  AlpacaError,
  AlpacaUnavailable,
} from "../src/alpaca.ts";
import { decide, review, ModelFailure } from "../src/model.ts";
import { initialState, proposalSchema } from "../src/domain.ts";
import { describeFailure } from "../src/worker-failures.ts";
import { analyse } from "../src/market.ts";
test("Broker requests cannot select a live endpoint; provider errors retain status", async () => {
  process.env.ALPACA_KEY_ID = "test-key";
  process.env.ALPACA_SECRET_KEY = "test-secret";
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts) => {
      assert.equal(String(url), PAPER + "/v2/account");
      assert.equal((opts?.headers as any)["APCA-API-KEY-ID"], "test-key");
      return new Response(JSON.stringify({ cash: "1000" }), { status: 200 });
    };
    assert.equal((await alpaca("/v2/account")).cash, "1000");
    globalThis.fetch = async () => new Response("{}", { status: 404 });
    await assert.rejects(
      () => alpaca("/v2/orders:by_client_order_id?client_order_id=test"),
      (e: unknown) => e instanceof AlpacaError && e.status === 404,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("A slow or failing Alpaca query is retried once and says which request failed", async () => {
  process.env.ALPACA_KEY_ID = "test-key";
  process.env.ALPACA_SECRET_KEY = "test-secret";
  const original = globalThis.fetch;
  const agotado = () => {
    const e = new Error("The operation was aborted");
    e.name = "TimeoutError";
    return e;
  };
  try {
    let llamadas = 0;
    globalThis.fetch = async () => {
      llamadas++;
      if (llamadas === 1) throw agotado();
      return new Response(JSON.stringify({ cash: "1000" }), { status: 200 });
    };
    assert.equal((await alpaca("/v2/account")).cash, "1000");
    assert.equal(llamadas, 2, "una consulta se reintenta una vez");
    llamadas = 0;
    globalThis.fetch = async () => {
      llamadas++;
      throw agotado();
    };
    await assert.rejects(
      () => alpaca("/v2/orders?status=all&limit=100"),
      (e: unknown) =>
        e instanceof AlpacaUnavailable &&
        /no respondió en 30 s en GET \/v2\/orders$/.test(e.message),
    );
    assert.equal(llamadas, 2);
    assert.match(
      describeFailure(await alpaca("/v2/positions").catch((e: unknown) => e)),
      /GET \/v2\/positions/,
      "el registro dice qué petición falló",
    );
    llamadas = 0;
    await assert.rejects(() =>
      alpaca("/v2/orders", "POST", { symbol: "AAPL" }),
    );
    assert.equal(llamadas, 1, "una orden nunca se reenvía");
    llamadas = 0;
    globalThis.fetch = async () => {
      llamadas++;
      return new Response("{}", { status: llamadas === 1 ? 503 : 200 });
    };
    assert.deepEqual(await alpaca("/v2/clock"), {});
    assert.equal(llamadas, 2, "un error del servidor de Alpaca se reintenta");
  } finally {
    globalThis.fetch = original;
  }
});
test("Agent receives approved memory and emits validated structured decisions", async () => {
  const s = initialState();
  s.analysis = {
    AAPL: analyse(
      [
        ...Array.from({ length: 60 }, (_, i) => ({
          t: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
          o: 100 + i - 0.5,
          h: 100 + i + 1,
          l: 100 + i - 1,
          c: 100 + i,
          v: 1000,
        })),
        { vela: "rota" },
      ],
      160,
      "prueba",
    ),
  };
  s.lessons = [
    {
      id: "yes",
      title: "Accepted",
      body: "Contextual evidence",
      source: "test",
      createdAt: new Date().toISOString(),
      status: "accepted",
    },
    {
      id: "no",
      title: "Unapproved",
      body: "Do not use as a rule",
      source: "test",
      createdAt: new Date().toISOString(),
      status: "proposed",
    },
  ];
  s.versions[0].lessonIds = ["yes"];
  const original = globalThis.fetch;
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";
  try {
    globalThis.fetch = async (url, opts) => {
      const req = JSON.parse(String(opts?.body));
      const context = JSON.parse(req.messages[1].content);
      assert.equal(context.lessons.length, 1);
      assert.equal(context.lessons[0].id, "yes");
      // El agente debe recibir el análisis, no solo el precio del momento.
      assert.ok(context.analysis, "falta el análisis en el contexto");
      assert.equal(context.analysis.AAPL.indicators.sma20, 149.5);
      assert.equal(context.analysis.AAPL.barsDiscarded, 1);
      assert.equal(context.analysis.AAPL.recentBars.length, 10);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "wait",
                  symbol: null,
                  qty: null,
                  limitPrice: null,
                  reason: "No hay evidencia suficiente",
                  hypothesis: "Esperar una cotización reciente",
                  reviewAfterHours: 24,
                  notify: false,
                  note: "Sin novedad que contar al propietario",
                  watches: [],
                  lessons: [],
                }),
              },
            },
          ],
          usage: { total_tokens: 123 },
        }),
      );
    };
    const result = await decide(s, "test");
    assert.equal(result.proposal.action, "wait");
    assert.equal(result.tokens, 123);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"action":"execute_shell"}' } }],
        }),
      );
    await assert.rejects(() => decide(s, "test"));
  } finally {
    globalThis.fetch = original;
  }
});
test("A truncated answer is reported as such, not as a schema error", async () => {
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            { finish_reason: "length", message: { content: '{"action":"wa' } },
          ],
        }),
      );
    await assert.rejects(
      () => decide(initialState(), "test"),
      (e: unknown) =>
        e instanceof Error && /agotó su límite de tokens/.test(e.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("Failures are described so the log says what actually went wrong", () => {
  const schemaError = (() => {
    try {
      proposalSchema.parse({ action: "comprar todo" });
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.match(describeFailure(schemaError), /no cumple el esquema/);
  assert.match(describeFailure(new Error("Modelo HTTP 429")), /HTTP 429/);
  const timeout = new Error("The operation was aborted");
  timeout.name = "TimeoutError";
  assert.match(describeFailure(timeout), /no respondió a tiempo/);
  assert.equal(describeFailure("x".repeat(500)).length, 300);
});
test("A model call reports what it spent and how big each part of the context was", async () => {
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";
  const original = globalThis.fetch;
  const answer = (content: unknown, extra: Record<string, unknown> = {}) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) }, ...extra }],
        usage: {
          prompt_tokens: 9000,
          completion_tokens: 300,
          total_tokens: 9300,
          prompt_tokens_details: { cached_tokens: 4000 },
        },
      }),
    );
  const wait = {
    action: "wait",
    symbol: null,
    qty: null,
    limitPrice: null,
    reason: "No hay evidencia suficiente",
    hypothesis: "Esperar una cotización reciente",
    reviewAfterHours: 24,
    notify: false,
    note: "Sin novedad que contar al propietario",
    watches: [],
  };
  try {
    let sent: any;
    globalThis.fetch = async (_url, opts) => {
      sent = JSON.parse(String(opts?.body));
      return answer(wait);
    };
    const s = initialState();
    const result = await decide(s, "Revisión periódica del mercado");
    const context = JSON.parse(sent.messages[1].content);
    const { sections, ...spent } = result.spent;
    assert.deepEqual(spent, {
      model: "test-model",
      tokens: 9300,
      promptTokens: 9000,
      completionTokens: 300,
      cachedTokens: 4000,
    });
    assert.deepEqual(Object.keys(sections!).sort(), [
      "analysis",
      "decisions",
      "instructions",
      "intraday",
      "lessons",
      "news",
      "portfolio",
      "watches",
    ]);
    assert.equal(sections!.instructions, sent.messages[0].content.length);
    assert.equal(
      sections!.analysis,
      JSON.stringify({ analysis: context.analysis }).length,
    );
    assert.equal(
      sections!.lessons,
      JSON.stringify({
        lessons: context.lessons,
        lessonsOmitted: context.lessonsOmitted,
      }).length,
    );
    const { event, at, settings, clock, account, positions, quotes } = context;
    assert.equal(
      sections!.portfolio,
      JSON.stringify({ event, at, settings, clock, account, positions, quotes })
        .length,
    );

    s.decisions = [
      {
        id: "d1",
        at: new Date().toISOString(),
        versionId: s.activeVersion,
        event: "evento",
        input: { news: [{ headline: "no llega a la revisión" }] },
        proposal: proposalSchema.parse({ ...wait, action: "wait" }),
        status: "filled",
        reviewAt: new Date().toISOString(),
      },
    ];
    globalThis.fetch = async (_url, opts) => {
      sent = JSON.parse(String(opts?.body));
      return answer({ text: "Evaluación suficientemente larga", lessons: [] });
    };
    const revision = await review(s, s.decisions[0]);
    assert.equal(revision.parsed.text, "Evaluación suficientemente larga");
    assert.equal(revision.tokens, 9300);
    const rc = JSON.parse(sent.messages[1].content);
    assert.deepEqual(revision.spent.sections, {
      instructions: sent.messages[0].content.length,
      reviewed: JSON.stringify({ decision: rc.decision }).length,
      portfolio: JSON.stringify({
        currentQuotes: rc.currentQuotes,
        currentPositions: rc.currentPositions,
        orders: rc.orders,
      }).length,
    });
  } finally {
    globalThis.fetch = original;
  }
});
test("A failed model call still carries what the provider charged", async () => {
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";
  const original = globalThis.fetch;
  const usage = {
    prompt_tokens: 9000,
    completion_tokens: 8000,
    total_tokens: 17000,
  };
  const failure = (call: () => Promise<unknown>) =>
    call().then(
      () => assert.fail("tenía que fallar"),
      (e: unknown) => {
        assert.ok(e instanceof ModelFailure, String(e));
        return e;
      },
    );
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "length", message: { content: '{"a' } }],
          usage,
        }),
      );
    const cortada = await failure(() => decide(initialState(), "test"));
    assert.equal(cortada.spent.tokens, 17000);
    assert.equal(cortada.spent.completionTokens, 8000);
    assert.ok(cortada.spent.sections!.instructions! > 0);
    assert.match(describeFailure(cortada.original), /agotó su límite/);

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "no es json" } }],
          usage,
        }),
      );
    const noJson = await failure(() => decide(initialState(), "test"));
    assert.equal(noJson.spent.tokens, 17000);
    assert.ok(noJson.original instanceof SyntaxError);

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"action":"execute_shell"}' } }],
          usage,
        }),
      );
    const esquema = await failure(() => decide(initialState(), "test"));
    assert.equal(esquema.spent.promptTokens, 9000);
    assert.match(describeFailure(esquema.original), /no cumple el esquema/);

    globalThis.fetch = async () => new Response("{}", { status: 500 });
    const http = await failure(() => decide(initialState(), "test"));
    assert.equal(http.spent.tokens, 0, "sin respuesta no hay tokens");
    assert.equal(http.spent.promptTokens, undefined);
    assert.equal(http.spent.model, "test-model");
    assert.ok(http.spent.sections, "lo que se intentó enviar sí se sabe");
    assert.match(http.message, /HTTP 500/);

    globalThis.fetch = async () => {
      const e = new Error("The operation was aborted");
      e.name = "TimeoutError";
      throw e;
    };
    const tarde = await failure(() => decide(initialState(), "test"));
    assert.equal(tarde.spent.tokens, 0);
    assert.match(describeFailure(tarde.original), /no respondió en 45 s/);
  } finally {
    globalThis.fetch = original;
  }
});
