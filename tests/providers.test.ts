import { test } from "node:test";
import assert from "node:assert/strict";
import { alpaca, PAPER, AlpacaError } from "../src/alpaca.ts";
import { decide } from "../src/model.ts";
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
      assert.equal(context.analysis.AAPL.recentBars.length, 20);
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
