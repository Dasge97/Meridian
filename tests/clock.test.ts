import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/domain.ts";
import {
  sessionOpen,
  marketClock,
  newYorkDate,
  todayStarted,
} from "../src/clock.ts";
// Caso real: lunes 14 de septiembre de 2026, 08:26 en España. La bolsa abría ese
// mismo día y el agente escribía que estaba «cerrada hasta el lunes».
const LUNES = Date.parse("2026-09-14T06:26:40Z");
const cerrada = () => {
  const s = initialState();
  s.market = {
    open: false,
    nextOpen: "2026-09-14T09:30:00-04:00",
    nextClose: "2026-09-14T16:00:00-04:00",
  };
  return s;
};
test("The model is told the weekday and how long until the opening", () => {
  const c = marketClock(cerrada(), LUNES);
  assert.equal(c.open, false);
  assert.match(c.nowNewYork, /^lunes/);
  assert.match(c.nowSpain, /^lunes.*08:26/);
  assert.match(c.nextOpenSpain!, /^lunes.*15:30/);
  assert.equal(c.opensToday, true);
  assert.equal(c.minutesToOpen, 423, "de 08:26 a 15:30 en España");
  assert.equal(c.minutesToClose, null);
  assert.equal(c.todayNewYork, "2026-09-14");
});
test("An open session reports its close and not the next opening", () => {
  const s = cerrada();
  s.market.open = true;
  const t = Date.parse("2026-09-14T14:00:00Z");
  const c = marketClock(s, t);
  assert.equal(c.open, true);
  assert.equal(c.minutesToOpen, null);
  assert.equal(c.minutesToClose, 360);
  assert.match(c.nextCloseNewYork!, /16:00/);
});
test("The session counts as closed after its close even if the calendar is late", () => {
  const s = cerrada();
  s.market.open = true;
  assert.equal(sessionOpen(s, Date.parse("2026-09-14T19:59:00Z")), true);
  // El calendario se sincroniza cada 30 segundos: aún dice abierta al cerrar.
  assert.equal(sessionOpen(s, Date.parse("2026-09-14T20:00:10Z")), false);
  s.feeds.clock = false;
  assert.equal(
    sessionOpen(s, Date.parse("2026-09-14T19:59:00Z")),
    false,
    "sin calendario se asume cerrada",
  );
  s.feeds.clock = true;
  s.market.nextClose = null;
  assert.equal(sessionOpen(s, Date.parse("2026-09-14T19:59:00Z")), false);
});
test("Daily bars are dated in New York, and today starts at the opening", () => {
  assert.equal(newYorkDate("2026-09-11T04:00:00Z"), "2026-09-11");
  assert.equal(newYorkDate("2026-01-12T05:00:00Z"), "2026-01-12");
  assert.equal(todayStarted(cerrada(), LUNES), false, "lunes antes de abrir");
  const sabado = cerrada();
  assert.equal(
    todayStarted(sabado, Date.parse("2026-09-12T15:00:00Z")),
    true,
    "el sábado la próxima apertura es otro día",
  );
});
