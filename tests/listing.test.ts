import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision, State } from "../src/domain.ts";
import { UserError } from "../src/domain.ts";
import {
  listDecisions,
  listEvents,
  decisionFilter,
  eventFilter,
  paginate,
} from "../src/listing.ts";

const decision = (
  n: number,
  x: {
    action?: "buy" | "sell" | "wait";
    symbol?: string | null;
    status?: string;
    note?: string;
  } = {},
): Decision => ({
  id: "d" + n,
  // Una decisión por hora desde el 1 de septiembre, de la más antigua a la más reciente.
  at: new Date(Date.UTC(2026, 8, 1, n)).toISOString(),
  versionId: "v1",
  event: "Revisión periódica del mercado",
  input: { contexto: "pesado" },
  status: x.status ?? "observed",
  reviewAt: new Date(Date.UTC(2026, 8, 2, n)).toISOString(),
  proposal: {
    action: x.action ?? "wait",
    symbol: x.symbol === undefined ? "SPY" : x.symbol,
    qty: null,
    limitPrice: null,
    reason: "Sin una entrada clara frente a su media de 20.",
    hypothesis: "Rebote hacia el máximo de la semana.",
    reviewAfterHours: 24,
    notify: false,
    note: x.note ?? "Espero: no hay entrada clara.",
    newsComments: [],
    watches: [],
    lessons: [],
  },
});
const filter = (q: Record<string, string> = {}) => decisionFilter(q);

test("Decisions come newest first, without their saved context", () => {
  const r = listDecisions([decision(0), decision(1), decision(2)], filter());
  assert.deepEqual(
    r.items.map((d) => d.id),
    ["d2", "d1", "d0"],
  );
  assert.ok(r.items.every((d) => d.input === null));
  assert.equal(r.total, 3);
  assert.equal(r.page, 1);
  assert.equal(r.size, 25);
  const shuffled = listDecisions(
    [decision(2), decision(0), decision(1)],
    filter(),
  );
  assert.deepEqual(
    shuffled.items.map((d) => d.id),
    ["d2", "d1", "d0"],
    "ordena por fecha aunque se guardaran desordenadas",
  );
});

test("Both date limits are included", () => {
  const all = [0, 1, 2, 3, 4].map((n) => decision(n));
  const r = listDecisions(all, filter({ from: all[1].at, to: all[3].at }));
  assert.deepEqual(
    r.items.map((d) => d.id),
    ["d3", "d2", "d1"],
  );
  const oneMs = listDecisions(
    all,
    filter({
      from: new Date(Date.parse(all[1].at) + 1).toISOString(),
      to: new Date(Date.parse(all[3].at) - 1).toISOString(),
    }),
  );
  assert.deepEqual(
    oneMs.items.map((d) => d.id),
    ["d2"],
  );
});

test("Text search ignores case and accents in every searched field", () => {
  const all = [
    decision(0, { note: "Revisión del mínimo de agosto" }),
    decision(1, { symbol: "NVDA" }),
    decision(2, { symbol: null }),
  ];
  const find = (q: string) =>
    listDecisions(all, filter({ q })).items.map((d) => d.id);
  assert.deepEqual(find("REVISION DEL MINIMO"), ["d0"]);
  assert.deepEqual(find("mínimo"), ["d0"]);
  assert.deepEqual(find("nvda"), ["d1"]);
  assert.equal(find("periodica").length, 3, "busca en el evento");
  assert.equal(find("máximo de la SEMANA").length, 3, "busca en la hipótesis");
  assert.equal(find("media de 20").length, 3, "busca en el razonamiento");
  assert.deepEqual(find("no existe"), []);
});

test("Counts ignore the kind filter but respect date, text and asset", () => {
  const all = [
    decision(0, { action: "buy", status: "filled" }),
    decision(1, { action: "buy", status: "blocked" }),
    decision(2, { action: "sell", status: "unknown" }),
    decision(3, { action: "sell", status: "submitting", symbol: "NVDA" }),
    decision(4),
  ];
  const r = listDecisions(all, filter({ kind: "buy" }));
  assert.deepEqual(r.counts, {
    all: 5,
    buy: 2,
    sell: 2,
    wait: 1,
    blocked: 1,
    unresolved: 2,
  });
  assert.equal(r.total, 2, "el total sí aplica el tipo");
  const spy = listDecisions(all, filter({ kind: "unresolved", symbol: "SPY" }));
  assert.equal(spy.counts.all, 4);
  assert.equal(spy.counts.unresolved, 1);
  assert.deepEqual(
    spy.items.map((d) => d.id),
    ["d2"],
  );
});

test("A page past the last one returns the last page", () => {
  const all = Array.from({ length: 60 }, (_, n) => decision(n));
  const r = listDecisions(all, filter({ page: "9", size: "25" }));
  assert.equal(r.page, 3);
  assert.equal(r.items.length, 10);
  assert.equal(r.items.at(-1)!.id, "d0");
  const empty = listDecisions([], filter({ page: "4" }));
  assert.equal(empty.page, 1);
  assert.equal(empty.total, 0);
  assert.deepEqual(paginate([1, 2, 3], 2, 2), {
    items: [3],
    total: 3,
    page: 2,
    size: 2,
  });
});

test("Page size goes from 1 to 100 and defaults to 25", () => {
  const all = Array.from({ length: 150 }, (_, n) => decision(n));
  assert.equal(listDecisions(all, filter()).items.length, 25);
  assert.equal(listDecisions(all, filter({ size: "100" })).items.length, 100);
  assert.equal(listDecisions(all, filter({ size: "1" })).items.length, 1);
  assert.throws(() => filter({ size: "101" }), /entre 1 y 100/);
  assert.throws(() => filter({ size: "0" }), /entre 1 y 100/);
});

test("Invalid parameters fail with a concrete message", () => {
  const bad = (q: Record<string, unknown>, message: RegExp) =>
    assert.throws(
      () => decisionFilter(q),
      (e) => e instanceof UserError && message.test(e.message),
    );
  bad({ page: "0" }, /página/);
  bad({ page: "2.5" }, /página/);
  bad({ page: "abc" }, /página/);
  bad({ from: "ayer" }, /fecha de inicio/);
  bad({ to: "2026-09-15" }, /fecha de fin/);
  bad(
    { from: "2026-09-15T00:00:00Z", to: "2026-09-14T00:00:00Z" },
    /posterior/,
  );
  bad({ kind: "todas" }, /tipo/);
  bad({ symbol: "spy" }, /activo/);
  bad({ page: ["1", "2"] }, /una vez/);
  bad({ q: "x".repeat(201) }, /200/);
  assert.equal(decisionFilter({ q: "", kind: "", page: "" }).kind, "all");
  assert.equal(
    decisionFilter({ from: "2026-09-15T00:00:00.000+02:00" }).from,
    Date.parse("2026-09-14T22:00:00Z"),
  );
});

test("Events keep newest first and count types without the type filter", () => {
  const at = (n: number) =>
    new Date(Date.UTC(2026, 8, 1, 10 - n)).toISOString();
  const events: State["events"] = [
    { id: "e0", at: at(0), type: "order", message: "Orden ejecutada" },
    { id: "e1", at: at(1), type: "sync", message: "Cuenta sincronizada" },
    { id: "e2", at: at(2), type: "order", message: "Orden cancelada" },
    { id: "e3", at: at(3), type: "error", message: "Alpaca tardó más de 5 s" },
  ];
  const r = listEvents(events, eventFilter({ type: "order" }));
  assert.deepEqual(
    r.items.map((e) => e.id),
    ["e0", "e2"],
  );
  assert.equal(r.total, 2);
  assert.deepEqual(r.types, [
    { type: "order", count: 2 },
    { type: "error", count: 1 },
    { type: "sync", count: 1 },
  ]);
  const text = listEvents(events, eventFilter({ q: "TARDO" }));
  assert.deepEqual(
    text.items.map((e) => e.id),
    ["e3"],
  );
  assert.deepEqual(text.types, [{ type: "error", count: 1 }]);
  assert.equal(
    listEvents(events, eventFilter({ q: "sync" })).total,
    1,
    "también busca en el tipo",
  );
  const range = listEvents(events, eventFilter({ from: at(2), to: at(1) }));
  assert.deepEqual(
    range.items.map((e) => e.id),
    ["e1", "e2"],
  );
  assert.throws(() => eventFilter({ type: "x".repeat(51) }), /50/);
});
