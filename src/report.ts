// Qué merece que el propietario reciba un aviso, y cómo se redacta. Sin entrada
// ni salida: recibe el estado y devuelve texto, o null si no hay nada que contar.
import { escapeHtml } from "./telegram.ts";
import type { State, Decision } from "./domain.ts";
export type Notice = { kind: string; text: string };
// Una decisión de seguir esperando no se cuenta cada vez, aunque el agente lo
// pida: sin este freno el bot repetiría lo mismo varias veces por hora.
export const QUIET_HOURS = 4;
const money = (v: number | string | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? "—"
    : Number(v).toLocaleString("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }) + " USD";
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v} %`;
const titulo: Record<string, string> = {
  buy: "🟢 COMPRA",
  sell: "🔴 VENTA",
  wait: "⚪ Sin operar",
};
const estados: Record<string, string> = {
  filled: "ejecutada",
  partially_filled: "ejecutada en parte",
  canceled: "cancelada",
  expired: "caducada",
  rejected: "rechazada por Alpaca",
  new: "abierta en el mercado",
  accepted: "aceptada",
  not_submitted: "confirmada como no enviada",
};
function contexto(s: State, symbol: string | null) {
  if (!symbol) return "";
  const i = s.analysis[symbol]?.indicators;
  const q = s.quotes[symbol];
  if (!i && !q) return "";
  const partes = [
    q ? `precio ${money(q.price)}` : null,
    i?.distanceToSma20Pct !== null && i?.distanceToSma20Pct !== undefined
      ? `${pct(i.distanceToSma20Pct)} sobre su media de 20 sesiones`
      : null,
    i?.positionIn52wRangePct !== null && i?.positionIn52wRangePct !== undefined
      ? `al ${i.positionIn52wRangePct} % de su rango anual`
      : null,
    i?.volumeRatio20 ? `volumen ${i.volumeRatio20}x su media` : null,
  ].filter(Boolean);
  return partes.length ? `\n\n<i>${escapeHtml(partes.join(" · "))}</i>` : "";
}
// Las noticias que el agente tenía delante al decidir, para que el aviso se
// entienda sin abrir el panel.
function noticias(s: State, symbol: string | null, max = 2) {
  const recientes = s.stories
    .filter((n) => !symbol || n.symbols.includes(symbol))
    .slice(-max);
  if (!recientes.length) return "";
  const lineas = recientes
    .map((n) => `· ${escapeHtml(n.headline)} <i>(${escapeHtml(n.source)})</i>`)
    .join("\n");
  return `\n\n<b>Noticias que tenía delante:</b>\n${lineas}`;
}
export function decisionNotice(
  s: State,
  d: Decision,
  t = Date.now(),
): Notice | null {
  const p = d.proposal;
  // Que la bolsa esté cerrada no es un fallo ni algo que el propietario pueda
  // arreglar. Además, avisar aquí sería engañoso: la cabecera anunciaría una
  // compra que no ha ocurrido.
  if (d.error === "Mercado cerrado") return null;
  const opera = p.action !== "wait";
  const bloqueada = Boolean(d.error);
  // Operar o quedarse con las ganas siempre se cuenta. Esperar, solo de vez en
  // cuando y únicamente si el propio agente cree que hay algo que contar.
  if (!opera && !bloqueada) {
    if (!p.notify) return null;
    const ultimo = s.lastNotice;
    if (
      ultimo?.kind === "espera" &&
      t - Date.parse(ultimo.at) < QUIET_HOURS * 3600000
    )
      return null;
  }
  const cabecera = bloqueada
    ? `🚫 NO SE ENVIÓ · ${escapeHtml(p.symbol ?? "")}`
    : `${titulo[p.action] ?? p.action}${p.symbol ? ` · ${escapeHtml(p.symbol)}` : ""}`;
  const cuanto =
    opera && p.qty && p.limitPrice
      ? `\n${p.qty} ${p.qty === 1 ? "acción" : "acciones"} a ${money(p.limitPrice)} como máximo`
      : "";
  const motivo = bloqueada
    ? `\n\n<b>Motivo del bloqueo:</b> ${escapeHtml(d.error!)}`
    : "";
  return {
    kind: opera || bloqueada ? "operacion" : "espera",
    text:
      `<b>${cabecera}</b>${cuanto}\n\n` +
      escapeHtml(p.note) +
      motivo +
      `\n\n<b>Qué espera:</b> ${escapeHtml(p.hypothesis)}` +
      contexto(s, p.symbol) +
      noticias(s, p.symbol),
  };
}
export function orderNotice(
  s: State,
  d: Decision,
  estado: string,
): Notice | null {
  // Los estados intermedios de una orden no son noticia para el propietario.
  if (!["filled", "partially_filled", "rejected", "canceled"].includes(estado))
    return null;
  const p = d.proposal;
  const icono =
    estado === "filled" ? "✅" : estado === "rejected" ? "⛔" : "↩️";
  const pos = s.positions.find((x) => x.symbol === p.symbol);
  const cartera = pos
    ? `\n\nAhora tienes ${pos.qty} de ${escapeHtml(p.symbol ?? "")}, valen ${money(pos.market_value)} (${money(pos.unrealized_pl)} sin realizar).`
    : "";
  return {
    kind: "orden",
    text:
      `<b>${icono} Orden ${estados[estado] ?? escapeHtml(estado)} · ${escapeHtml(p.symbol ?? "")}</b>\n` +
      `${p.action === "buy" ? "Compra" : "Venta"} de ${p.qty} a ${money(p.limitPrice)}` +
      cartera +
      `\n\nEfectivo: ${money(s.account?.cash)} · Patrimonio: ${money(s.account?.equity)}`,
  };
}
export function reviewNotice(s: State, d: Decision): Notice | null {
  // Solo se cuenta la revisión de algo que llegó a operarse.
  if (!d.review || d.proposal.action === "wait") return null;
  const precio = d.review.price;
  const limite = d.proposal.limitPrice;
  const movimiento =
    precio && limite
      ? `\nDesde entonces el precio pasó de ${money(limite)} a ${money(precio)}.`
      : "";
  return {
    kind: "revision",
    text:
      `<b>📋 Revisión · ${escapeHtml(d.proposal.symbol ?? "")}</b>${movimiento}\n\n` +
      escapeHtml(d.review.text),
  };
}
export function problemNotice(mensaje: string): Notice {
  return {
    kind: "problema",
    text:
      `<b>🔴 Algo va mal</b>\n\n${escapeHtml(mensaje)}\n\n` +
      `Míralo en https://meridian.code-hive.space`,
  };
}
// Los comentarios del agente sobre las noticias que acaba de leer. Va aparte del
// aviso de la decisión: al propietario le interesa aunque no se opere nada.
export function newsNotice(s: State, d: Decision): Notice | null {
  const comentarios = d.newsCommented ?? [];
  if (!comentarios.length) return null;
  const bloques: string[] = [];
  for (const c of comentarios) {
    const n = s.stories.find((x) => x.id === c.storyId);
    // Un comentario sobre una noticia que ya no está guardada no se puede
    // presentar sin su titular, así que se descarta.
    if (!n) continue;
    // El icono deja ver de un vistazo cuáles merecen leerse y cuáles son ruido.
    bloques.push(
      `${c.matters ? "❗" : "➖"} <b>${escapeHtml(n.symbols.join(", "))}</b> · ${escapeHtml(n.headline)}\n` +
        escapeHtml(c.comment),
    );
  }
  if (!bloques.length) return null;
  const importantes = comentarios.filter((c) => c.matters).length;
  const cuenta =
    bloques.length === 1
      ? "Una noticia nueva"
      : `${bloques.length} noticias nuevas`;
  const encabezado = importantes
    ? `📰 ${cuenta} · ${importantes} ${importantes === 1 ? "importa" : "importan"}`
    : `📰 ${cuenta} · ninguna cambia nada`;
  return {
    kind: "noticias",
    text: `<b>${encabezado}</b>\n\n${bloques.join("\n\n")}`,
  };
}
