import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usableBar,
  cleanBars,
  atr,
  indicators,
  todayFrom,
  analyse,
  type Bar,
} from "../src/market.ts";
const bar = (over: Partial<Bar> = {}): Bar => ({
  t: "2026-09-01T04:00:00Z",
  o: 100,
  h: 102,
  l: 99,
  c: 101,
  v: 1000,
  ...over,
});
// Serie ascendente y estable, para poder comprobar los indicadores a mano.
const serie = (n: number, from = 100, step = 1) =>
  Array.from({ length: n }, (_, i) => {
    const close = from + i * step;
    return bar({
      t: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
      o: close - 0.5,
      h: close + 1,
      l: close - 1,
      c: close,
      v: 1000,
    });
  });
test("A bar with an impossible low is discarded, not repaired", () => {
  // Caso real: Alpaca dio SPY el 2026-02-02 con minimo 69.005 en vez de 690.05.
  assert.equal(
    usableBar({
      t: "2026-02-02T05:00:00Z",
      o: 689.58,
      h: 696.93,
      l: 69.005,
      c: 695.41,
      v: 79286521,
    }),
    null,
  );
  assert.ok(
    usableBar({
      t: "2026-02-02T05:00:00Z",
      o: 689.58,
      h: 696.93,
      l: 688.0,
      c: 695.41,
      v: 79286521,
    }),
  );
});
test("Incoherent, non-numeric or non-positive bars are discarded", () => {
  assert.equal(
    usableBar({ ...bar(), h: 100, c: 101 }),
    null,
    "máximo por debajo del cierre",
  );
  assert.equal(
    usableBar({ ...bar(), l: 102, o: 100 }),
    null,
    "mínimo por encima de la apertura",
  );
  assert.equal(usableBar({ ...bar(), c: 0 }), null);
  assert.equal(usableBar({ ...bar(), c: "101" }), null);
  assert.equal(usableBar({ ...bar(), v: -1 }), null);
  assert.equal(usableBar({ ...bar(), t: "no es una fecha" }), null);
  assert.equal(usableBar(null), null);
});
test("Cleaning counts what it dropped and orders by date", () => {
  const { bars, discarded } = cleanBars([
    bar({ t: "2026-09-03T04:00:00Z", c: 103, h: 104, l: 102, o: 102.5 }),
    { roto: true },
    bar({ t: "2026-09-01T04:00:00Z", c: 101 }),
  ]);
  assert.equal(bars.length, 2);
  assert.equal(discarded, 1);
  assert.equal(bars[0].t.slice(0, 10), "2026-09-01");
  assert.equal(bars[1].t.slice(0, 10), "2026-09-03");
});
test("Moving averages need enough sessions before they report a number", () => {
  const pocas = indicators(serie(10), 110)!;
  assert.equal(pocas.sma20, null);
  assert.equal(pocas.sma50, null);
  const muchas = indicators(serie(60), 160)!;
  // Serie 100..159: la media de los 20 ultimos cierres es 149.5.
  assert.equal(muchas.sma20, 149.5);
  assert.equal(muchas.sma50, 134.5);
  assert.equal(muchas.sma200, null);
});
test("Distance to the average and recent change are reported as percentages", () => {
  const i = indicators(serie(60), 160)!;
  assert.equal(i.distanceToSma20Pct, 7.02, "160 está un 7,02% sobre 149,5");
  assert.equal(i.changePct1d, 0.63, "de 158 a 159");
  assert.equal(i.changePct5d, 3.25, "de 154 a 159");
});
test("The 52 week range and the position inside it", () => {
  const i = indicators(serie(300), 300)!;
  // Solo cuentan las ultimas 252 sesiones, no las 300.
  assert.equal(i.high52w, 400);
  assert.equal(i.low52w, 147);
  assert.equal(i.positionIn52wRangePct, 60.47);
});
test("Average true range measures the daily move including gaps", () => {
  const plana = serie(30);
  // Cada vela abarca 2 puntos y el cierre anterior cae dentro: rango verdadero 2.
  assert.equal(atr(plana, 14), 2);
  assert.equal(atr(serie(10), 14), null, "no hay sesiones suficientes");
  const i = indicators(serie(30), 130)!;
  assert.equal(i.atr14, 2);
  assert.equal(i.atr14Pct, 1.54);
});
test("Volume is compared with its own twenty session average", () => {
  const bars = serie(25);
  bars[bars.length - 1] = { ...bars.at(-1)!, v: 3000 };
  const i = indicators(bars, 124)!;
  assert.equal(i.volumeRatio20, 3, "el triple de su volumen normal");
});
test("Today summarises the last session against the previous close", () => {
  const t = todayFrom(serie(5))!;
  assert.equal(t.close, 104);
  assert.equal(t.prevClose, 103);
  assert.equal(t.changePct, 0.97);
  assert.equal(todayFrom([]), null);
});
test("The analysis keeps only recent bars and says what it discarded", () => {
  const raw: unknown[] = [...serie(60), { roto: true }];
  const a = analyse(raw, 160, "prueba", "2026-09-11T17:00:00Z");
  assert.equal(a.bars.length, 20, "solo se guardan las veinte ultimas");
  assert.equal(a.barsUsed, 60);
  assert.equal(a.barsDiscarded, 1);
  assert.equal(a.indicators!.sma20, 149.5);
  assert.equal(a.source, "prueba");
});
test("Without bars or without a price there are no indicators, and it does not crash", () => {
  const vacio = analyse([], 100, "prueba");
  assert.equal(vacio.indicators, null);
  assert.equal(vacio.today, null);
  assert.equal(vacio.barsUsed, 0);
  assert.equal(indicators(serie(30), 0), null);
  assert.equal(indicators(serie(30), NaN), null);
});
