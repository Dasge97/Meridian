import { test } from "node:test";
import assert from "node:assert/strict";
import { UserError, type Usage } from "../src/domain.ts";
import {
  estimate,
  listUsage,
  summariseUsage,
  usageFilter,
} from "../src/usage.ts";

const at = (day: number, hour = 12) =>
  new Date(Date.UTC(2026, 8, day, hour)).toISOString();
const filter = (q: Record<string, string> = {}) => usageFilter(q);
const decision = (over: Partial<Usage> = {}): Usage => ({
  at: at(10),
  tokens: 11000,
  kind: "decision",
  trigger: "periodic",
  event: "Revisión periódica del mercado",
  decisionId: "d1",
  model: "modelo",
  promptTokens: 10000,
  completionTokens: 1000,
  sections: { instructions: 2000, portfolio: 1000, analysis: 5000, news: 2000 },
  ok: true,
  ...over,
});

test("Input tokens are shared out in proportion to the characters of each part", () => {
  assert.deepEqual(estimate(decision()), {
    instructions: 2000,
    portfolio: 1000,
    analysis: 5000,
    news: 2000,
  });
  assert.deepEqual(
    estimate(
      decision({
        promptTokens: 1000,
        sections: { instructions: 1, reviewed: 1, portfolio: 1 },
      }),
    ),
    { instructions: 333, reviewed: 333, portfolio: 333 },
    "redondeado",
  );
  assert.equal(estimate({ at: at(1), tokens: 500 }), null, "registro antiguo");
  assert.equal(
    estimate(decision({ promptTokens: undefined })),
    null,
    "sin tokens de entrada no hay reparto",
  );
  assert.equal(estimate(decision({ sections: undefined })), null);
  assert.equal(estimate(decision({ sections: {} })), null);
});

test("Items come newest first and carry the estimate only when it can be made", () => {
  const r = listUsage(
    [
      decision({ at: at(1), decisionId: "a" }),
      { at: at(3), tokens: 700 },
      decision({ at: at(2), decisionId: "b" }),
    ],
    filter(),
  );
  assert.deepEqual(
    r.items.map((u) => u.at),
    [at(3), at(2), at(1)],
  );
  assert.equal(r.items[0].estimated, undefined);
  assert.equal(r.items[1].estimated!.analysis, 5000);
  assert.equal(r.total, 3);
  assert.equal(r.size, 25);
});

test("A page past the last one returns the last one", () => {
  const all = Array.from({ length: 12 }, (_, i) => decision({ at: at(i + 1) }));
  const r = listUsage(all, filter({ page: "9", size: "5" }));
  assert.equal(r.page, 3);
  assert.equal(r.items.length, 2);
  assert.equal(r.summary.calls, 12, "el resumen no se pagina");
});

test("The summary follows the date, kind and trigger filters", () => {
  const all: Usage[] = [
    decision({ at: at(1), trigger: "watch", tokens: 100 }),
    decision({ at: at(2), trigger: "news", tokens: 200 }),
    decision({
      at: at(3),
      kind: "review",
      trigger: "review",
      tokens: 300,
    }),
    { at: at(4), tokens: 400 },
  ];
  const fechas = listUsage(all, filter({ from: at(2), to: at(3) }));
  assert.equal(fechas.summary.calls, 2);
  assert.equal(fechas.summary.tokens, 500);
  const revisiones = listUsage(all, filter({ kind: "review" }));
  assert.equal(revisiones.total, 1);
  assert.equal(revisiones.summary.tokens, 300);
  const antiguos = listUsage(all, filter({ trigger: "unknown" }));
  assert.equal(antiguos.total, 1);
  assert.equal(antiguos.items[0].tokens, 400);
  assert.equal(listUsage(all, filter({ trigger: "watch" })).total, 1);
});

test("Totals, failures and averages add up, old records included", () => {
  const s = summariseUsage([
    decision({ tokens: 11000, promptTokens: 10000, completionTokens: 1000 }),
    decision({
      ok: false,
      error: "Modelo HTTP 500",
      tokens: 0,
      promptTokens: undefined,
      completionTokens: undefined,
    }),
    { at: at(10), tokens: 4000 },
  ]);
  assert.equal(s.calls, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.tokens, 15000);
  assert.equal(s.promptTokens, 10000);
  assert.equal(s.completionTokens, 1000);
  assert.equal(s.avgTokens, 5000);
  assert.equal(s.withBreakdown, 1, "ni el fallo sin respuesta ni el antiguo");
  assert.deepEqual(s.byTrigger, [
    { trigger: "periodic", calls: 2, tokens: 11000 },
    { trigger: "unknown", calls: 1, tokens: 4000 },
  ]);
  const vacio = summariseUsage([]);
  assert.equal(vacio.avgTokens, 0);
  assert.deepEqual(vacio.byDay, []);
  assert.deepEqual(vacio.bySection, []);
});

test("Each part is summed and averaged over the calls that sent it", () => {
  const s = summariseUsage([
    decision(),
    decision({
      promptTokens: 20000,
      sections: {
        instructions: 2000,
        portfolio: 1000,
        analysis: 5000,
        news: 2000,
      },
    }),
    decision({
      kind: "review",
      trigger: "review",
      promptTokens: 3000,
      sections: { instructions: 1000, reviewed: 1000, portfolio: 1000 },
    }),
  ]);
  assert.deepEqual(s.bySection, [
    { section: "analysis", tokens: 15000, avgTokens: 7500 },
    { section: "instructions", tokens: 7000, avgTokens: 2333 },
    { section: "news", tokens: 6000, avgTokens: 3000 },
    { section: "portfolio", tokens: 4000, avgTokens: 1333 },
    { section: "reviewed", tokens: 1000, avgTokens: 1000 },
  ]);
});

test("Days are UTC, in order and without gaps", () => {
  const s = summariseUsage([
    decision({ at: at(14, 23), tokens: 50, trigger: "news" }),
    decision({ at: at(10, 1), tokens: 100, trigger: "watch" }),
    decision({ at: at(10, 5), tokens: 30, trigger: "watch" }),
    { at: at(10, 9), tokens: 20 },
    // Las 23:30 del 12 en UTC son ya el 13 en España: cuenta el día UTC.
    decision({
      at: "2026-09-12T23:30:00Z",
      tokens: 10,
      trigger: "manual",
    }),
    { at: "fecha rota", tokens: 5 },
  ]);
  assert.deepEqual(
    s.byDay.map((d) => d.day),
    ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"],
  );
  assert.deepEqual(s.byDay[0], {
    day: "2026-09-10",
    tokens: 150,
    calls: 3,
    byTrigger: { watch: 130, unknown: 20 },
  });
  assert.deepEqual(s.byDay[1], {
    day: "2026-09-11",
    tokens: 0,
    calls: 0,
    byTrigger: {},
  });
  assert.equal(s.byDay[2].byTrigger.manual, 10);
  assert.equal(s.calls, 6, "una fecha rota cuenta, pero no tiene día");
});

test("Query parameters are validated with a message naming the parameter", () => {
  assert.deepEqual(filter(), {
    page: 1,
    size: 25,
    from: null,
    to: null,
    kind: null,
    trigger: null,
  });
  assert.equal(
    filter({ kind: "review", trigger: "unknown" }).trigger,
    "unknown",
  );
  for (const [q, message] of [
    [{ size: "0" }, /tamaño de página/],
    [{ size: "101" }, /entre 1 y 100/],
    [{ page: "0" }, /página/],
    [{ kind: "wait" }, /El tipo tiene que ser uno de estos: decision, review/],
    [{ trigger: "vigilancia" }, /El origen tiene que ser uno de estos: watch/],
    [{ from: "ayer" }, /fecha de inicio/],
    [{ from: at(3), to: at(2) }, /posterior/],
  ] as const)
    assert.throws(
      () => filter(q as Record<string, string>),
      (e: unknown) => e instanceof UserError && message.test(e.message),
      JSON.stringify(q),
    );
  assert.throws(
    () => usageFilter({ kind: ["decision", "review"] }),
    /solo se puede indicar una vez/,
  );
});
