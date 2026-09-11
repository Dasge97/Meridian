export class AlpacaError extends Error {
  constructor(public status: number) {
    super(`Alpaca HTTP ${status}`);
  }
}
export const PAPER = "https://paper-api.alpaca.markets";
export const configured = () =>
  Boolean(process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY);
export async function alpaca(
  path: string,
  method = "GET",
  body?: unknown,
  data = false,
) {
  if (!configured()) throw new Error("Alpaca Paper sin configurar");
  const r = await fetch((data ? "https://data.alpaca.markets" : PAPER) + path, {
    method,
    headers: {
      "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID!,
      "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY!,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new AlpacaError(r.status);
  return r.status === 204 ? null : r.json();
}
export async function snapshot(symbols: string[]) {
  const [account, positions, orders, trades, clock] = await Promise.all([
    alpaca("/v2/account"),
    alpaca("/v2/positions"),
    alpaca("/v2/orders?status=all&limit=100&direction=desc"),
    alpaca(
      "/v2/stocks/trades/latest?feed=iex&symbols=" + symbols.join(","),
      "GET",
      undefined,
      true,
    ),
    alpaca("/v2/clock"),
  ]);
  return { account, positions, orders, trades, clock };
}
