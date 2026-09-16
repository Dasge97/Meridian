export class AlpacaError extends Error {
  constructor(public status: number) {
    super(`Alpaca HTTP ${status}`);
  }
}
export const PAPER = "https://paper-api.alpaca.markets";
export const configured = () =>
  Boolean(process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY);
// Alpaca no respondió o la conexión falló. El mensaje dice qué petición fue,
// sin la parte de la consulta, que puede llevar identificadores largos.
export class AlpacaUnavailable extends Error {}
// El 14/09/2026 la sincronización falló casi sin parar la última hora de sesión
// con el límite de 15 s, y el registro no decía qué petición tardaba.
export const ALPACA_TIMEOUT_MS = 30000,
  ALPACA_RETRY_DELAY_MS = 1000,
  ALPACA_SLOW_MS = 5000;
export async function alpaca(
  path: string,
  method = "GET",
  body?: unknown,
  data = false,
) {
  if (!configured()) throw new Error("Alpaca Paper sin configurar");
  const peticion = `${method} ${path.split("?")[0]}`;
  // Solo se reintenta lo que no cambia nada en Alpaca. Reenviar o cancelar una
  // orden sin saber si la primera llegó podría duplicarla.
  const intentos = method === "GET" ? 2 : 1;
  for (let intento = 1; ; intento++) {
    const inicio = Date.now();
    let motivo: string;
    try {
      const r = await fetch(
        (data ? "https://data.alpaca.markets" : PAPER) + path,
        {
          method,
          headers: {
            "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID!,
            "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY!,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(ALPACA_TIMEOUT_MS),
        },
      );
      const tardo = Date.now() - inicio;
      if (tardo > ALPACA_SLOW_MS)
        console.warn(`Alpaca lenta: ${peticion} tardó ${tardo} ms`);
      if (r.ok) return r.status === 204 ? null : await r.json();
      if (r.status < 500 || intento >= intentos)
        throw new AlpacaError(r.status);
      motivo = `respondió HTTP ${r.status}`;
    } catch (e) {
      if (e instanceof AlpacaError) throw e;
      motivo =
        e instanceof Error && e.name === "TimeoutError"
          ? `no respondió en ${ALPACA_TIMEOUT_MS / 1000} s`
          : `falló la conexión (${e instanceof Error ? e.message : String(e)})`;
      if (intento >= intentos)
        throw new AlpacaUnavailable(`Alpaca ${motivo} en ${peticion}`);
    }
    console.warn(`Alpaca ${motivo} en ${peticion}; se reintenta`);
    await new Promise((r) => setTimeout(r, ALPACA_RETRY_DELAY_MS));
  }
}
// La cuenta de Alpaca: cuenta, posiciones y órdenes. Son obligatorias, porque
// los límites dependen de ellas; si falla una, falla la sincronización entera.
export async function accountSnapshot() {
  const [account, positions, orders] = await Promise.all([
    alpaca("/v2/account"),
    alpaca("/v2/positions"),
    alpaca("/v2/orders?status=all&limit=100&direction=desc"),
  ]);
  return { account, positions, orders };
}
// Calendario y últimos precios, compartidos por todas las simulaciones. Pueden
// faltar: sin precios recientes o sin saber que el mercado está abierto no se
// envían órdenes, pero el panel sigue mostrando la cuenta.
export async function marketSnapshot(symbols: string[]) {
  const [trades, clock] = await Promise.all([
    symbols.length
      ? alpaca(
          "/v2/stocks/trades/latest?feed=iex&symbols=" + symbols.join(","),
          "GET",
          undefined,
          true,
        ).catch(() => null)
      : { trades: {} },
    alpaca("/v2/clock").catch(() => null),
  ]);
  return { trades, clock };
}
// Velas diarias consolidadas. El feed sip cubre todo el mercado; el feed iex del
// WebSocket solo ve su propio parqué y sirve para el precio del momento, no para
// medir tendencia o volumen.
export const HISTORY_DAYS = 400,
  INTRADAY_DAYS = 4,
  BAR_PAGES_MAX = 10;
// Alpaca pagina las velas. Con 20 activos y velas de 5 minutos una sola respuesta
// no las trae todas, y sin seguir las páginas faltarían los últimos activos.
async function bars(params: Record<string, string>) {
  const all: Record<string, unknown[]> = {};
  let token: string | undefined;
  for (let page = 0; page < BAR_PAGES_MAX; page++) {
    const query = new URLSearchParams({
      ...params,
      limit: "10000",
      ...(token ? { page_token: token } : {}),
    });
    const r = await alpaca("/v2/stocks/bars?" + query, "GET", undefined, true);
    for (const [symbol, list] of Object.entries(
      (r?.bars ?? {}) as Record<string, unknown[]>,
    ))
      (all[symbol] ??= []).push(...list);
    token = r?.next_page_token || undefined;
    if (!token) break;
  }
  return all;
}
export async function dailyBars(symbols: string[], days = HISTORY_DAYS) {
  return bars({
    symbols: symbols.join(","),
    timeframe: "1Day",
    start: new Date(Date.now() - days * 86400000).toISOString().slice(0, 10),
    feed: "sip",
    adjustment: "split",
  });
}
// Velas de 5 minutos de los últimos días, para ver la sesión por dentro. En esta
// cuenta el feed sip llega con 15 minutos de retraso; el feed iex llega al
// momento pero solo cubre su propio parqué.
export async function intradayBars(
  symbols: string[],
  days = INTRADAY_DAYS,
  feed: "sip" | "iex" = "sip",
) {
  return bars({
    symbols: symbols.join(","),
    timeframe: "5Min",
    start: new Date(Date.now() - days * 86400000).toISOString(),
    feed,
    adjustment: "split",
  });
}
// Noticias de mercado del proveedor. Texto de terceros, nunca instrucciones.
export async function marketNews(symbols: string[], limit = 30) {
  const query = new URLSearchParams({
    symbols: symbols.join(","),
    limit: String(limit),
    sort: "desc",
    exclude_contentless: "true",
  });
  const r = await alpaca("/v1beta1/news?" + query, "GET", undefined, true);
  return (r?.news ?? []) as unknown[];
}
