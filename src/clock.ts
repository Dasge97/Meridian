// Horario de la bolsa de Nueva York, ya calculado. Sin entrada ni salida: recibe
// el estado y la hora, y devuelve datos, para poder probarlo sin red.
import type { State } from "./domain.ts";
export const NEW_YORK = "America/New_York",
  SPAIN = "Europe/Madrid",
  PRE_OPEN_MINUTES = 30;
type Market = Pick<State, "market" | "feeds">;
// La sesión se da por abierta solo si Alpaca respondió al calendario, dijo que
// está abierta y aún no ha llegado su cierre. El calendario se sincroniza cada
// 30 segundos: sin comprobar el cierre, una orden podría salir ya cerrada la
// bolsa y quedarse esperando a la sesión del día siguiente.
export function sessionOpen(s: Market, t = Date.now()) {
  if (!s.feeds.clock || !s.market.open || !s.market.nextClose) return false;
  const close = Date.parse(s.market.nextClose);
  return Number.isFinite(close) && t < close;
}
// Fecha AAAA-MM-DD en Nueva York, que es la que usan las velas diarias.
export function newYorkDate(t: number | string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: NEW_YORK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
}
const texto = (t: number, timeZone: string) =>
  new Date(t).toLocaleString("es-ES", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
const minutos = (from: number, to: string | null) => {
  const x = to === null ? NaN : Date.parse(to);
  return Number.isFinite(x) ? Math.round((x - from) / 60000) : null;
};
// Lo que el modelo necesita para hablar de días y horas sin calcularlos él. Una
// fecha en UTC no le basta: el lunes de madrugada seguía diciendo que la bolsa
// abría «el lunes», copiando lo que había escrito el fin de semana.
export function marketClock(s: Market, t = Date.now()) {
  const open = sessionOpen(s, t);
  const nextOpen = s.market.nextOpen ? Date.parse(s.market.nextOpen) : NaN;
  const nextClose = s.market.nextClose ? Date.parse(s.market.nextClose) : NaN;
  return {
    calendarAvailable: s.feeds.clock,
    open,
    nowNewYork: texto(t, NEW_YORK),
    nowSpain: texto(t, SPAIN),
    todayNewYork: newYorkDate(t),
    nextOpenNewYork: Number.isFinite(nextOpen)
      ? texto(nextOpen, NEW_YORK)
      : null,
    nextOpenSpain: Number.isFinite(nextOpen) ? texto(nextOpen, SPAIN) : null,
    opensToday:
      Number.isFinite(nextOpen) && newYorkDate(nextOpen) === newYorkDate(t),
    minutesToOpen: open ? null : minutos(t, s.market.nextOpen),
    minutesToClose: open ? minutos(t, s.market.nextClose) : null,
    nextCloseNewYork:
      open && Number.isFinite(nextClose) ? texto(nextClose, NEW_YORK) : null,
  };
}
// Si la sesión de hoy ya ha empezado en Nueva York. Antes de la apertura, una
// vela con la fecha de hoy solo puede traer operaciones previas a la sesión.
export function todayStarted(s: Market, t = Date.now()) {
  if (sessionOpen(s, t)) return true;
  if (!s.market.nextOpen) return false;
  return newYorkDate(s.market.nextOpen) !== newYorkDate(t);
}
