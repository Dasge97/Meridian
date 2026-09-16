// Ejecución simulada de la simulación interna, sin entrada ni salida. Sus órdenes
// no salen a Alpaca: se aceptan y se ejecutan aquí contra los últimos precios
// guardados. La cuenta, las posiciones y las órdenes tienen la forma de las de
// Alpaca, para que orderGuard, el contexto del modelo y el panel las lean igual.
import {
  id,
  log,
  type Book,
  type Decision,
  type Fill,
  type State,
} from "./domain.ts";
import { reconcileDecisions, sampleEquity } from "./agent.ts";
import { sessionOpen, newYorkMinutes, SESSION_OPEN_MINUTE } from "./clock.ts";
// Los tipos y las funciones de la cuenta viven en domain.ts, porque forman parte
// del estado. Se reexportan para quien los busque aquí.
export { bookOf, comparisonStart } from "./domain.ts";
export type { Fill, Book, BookPosition, ComparisonStart } from "./domain.ts";

export const INTERNAL_ACCOUNT_ID = "internal",
  INTERNAL_ORDERS_KEPT = 100,
  QUOTE_MAX_AGE_MS = 90000,
  QUOTE_MAX_AHEAD_MS = 5000;
const OPEN = ["new", "accepted", "pending_new", "partially_filled"];
const iso = (t: number) => new Date(t).toISOString();
// Precios de hasta 4 decimales por cantidades enteras: redondear a 4 quita el
// ruido de coma flotante sin perder nada.
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const isOpen = (o: { status: string }) => OPEN.includes(o.status);

// La posición tras una ejecución. La usan el motor y replayFills, así que el
// libro reconstruido y el guardado hacen exactamente las mismas cuentas.
function holdingAfter(
  prev: { qty: number; avgPrice: number } | undefined,
  side: Fill["side"],
  qty: number,
  price: number,
) {
  const q0 = prev?.qty ?? 0,
    avg0 = prev?.avgPrice ?? 0;
  if (side === "buy")
    return {
      qty: q0 + qty,
      avgPrice: r4((q0 * avg0 + qty * price) / (q0 + qty)),
      cashDelta: -r4(qty * price),
      realizedPl: 0,
    };
  return {
    qty: q0 - qty,
    avgPrice: avg0,
    cashDelta: r4(qty * price),
    realizedPl: r4((price - avg0) * qty),
  };
}

function position(symbol: string, qty: number, avg: number, price: number) {
  const cost = r4(qty * avg),
    value = r4(qty * price);
  return {
    symbol,
    qty,
    side: "long",
    avg_entry_price: avg,
    cost_basis: cost,
    current_price: price,
    market_value: value,
    unrealized_pl: r4(value - cost),
    unrealized_plpc: cost ? Math.round(((value - cost) / cost) * 1e6) / 1e6 : 0,
  };
}
function account(cash: number, positions: { market_value: number }[]) {
  const long = r4(positions.reduce((a, x) => a + x.market_value, 0));
  const equity = r4(cash + long);
  return {
    id: INTERNAL_ACCOUNT_ID,
    status: "ACTIVE",
    currency: "USD",
    cash,
    equity,
    portfolio_value: equity,
    long_market_value: long,
    buying_power: cash,
    trading_blocked: false,
    account_blocked: false,
  };
}
// Valora con el último precio que haya, aunque sea viejo: fuera de sesión Alpaca
// también enseña el último. Sin ninguno, al precio medio.
function revalue(s: State) {
  s.positions = s.positions.map((x) => {
    const q = s.quotes[x.symbol];
    const price =
      q && Number.isFinite(q.price) && q.price > 0
        ? q.price
        : Number(x.current_price) > 0
          ? Number(x.current_price)
          : Number(x.avg_entry_price);
    return position(
      x.symbol,
      Number(x.qty),
      Number(x.avg_entry_price),
      r4(price),
    );
  });
  s.account = account(Number(s.account.cash), s.positions);
}

// El libro de partida de la interna: copia de la cuenta de Alpaca con su efectivo,
// sus posiciones con precio medio y valor, y el mismo baseline. Sin órdenes
// abiertas ni ejecuciones. Lanza un error con el motivo si la cuenta no se puede
// copiar tal cual, para que la migración lo cuente en vez de arrancar mal.
export function startingBookFrom(
  s: Pick<State, "account" | "positions" | "baseline">,
) {
  const cash = r4(Number(s.account?.cash));
  if (!s.account || !Number.isFinite(cash))
    throw new Error("La cuenta de Alpaca no trae un efectivo válido");
  if (cash < 0)
    throw new Error(
      "La cuenta de Alpaca tiene efectivo negativo: la simulación interna no opera con margen",
    );
  const positions = s.positions.map((x) => {
    const qty = Number(x.qty),
      avg = r4(Number(x.avg_entry_price)),
      price = r4(Number(x.current_price));
    if (!Number.isFinite(qty) || qty <= 0)
      throw new Error(
        `La posición de ${x.symbol} en Alpaca no es larga (qty ${x.qty}): ciérrala antes de copiar la cuenta`,
      );
    if (!Number.isFinite(avg) || avg <= 0)
      throw new Error(
        `La posición de ${x.symbol} no trae un precio medio válido`,
      );
    return position(
      String(x.symbol),
      qty,
      avg,
      Number.isFinite(price) && price > 0 ? price : avg,
    );
  });
  const cuenta = account(cash, positions);
  return {
    account: cuenta,
    positions,
    orders: [] as any[],
    fills: [] as Fill[],
    baseline: s.baseline ?? cuenta.equity,
  };
}

// Las abiertas se conservan siempre: aquí no hay otra copia de ellas, y perder
// una dejaría su decisión esperando para siempre.
function trimOrders(orders: any[]) {
  let terminales = INTERNAL_ORDERS_KEPT - orders.filter(isOpen).length;
  return orders.filter((o) => isOpen(o) || terminales-- > 0);
}

// Acepta la orden de una decisión recién reservada por claimIntent, en la misma
// transacción, e intenta ejecutarla al llegar. Nunca pasa por unknown.
export function acceptInternalOrder(s: State, d: Decision, t = Date.now()) {
  const p = d.proposal;
  if (
    (p.action !== "buy" && p.action !== "sell") ||
    !p.symbol ||
    !p.qty ||
    !Number.isInteger(p.qty) ||
    p.qty < 1 ||
    !p.limitPrice ||
    !(p.limitPrice > 0)
  )
    throw new Error(`La decisión ${d.id} no es una orden válida`);
  const repetida = s.orders.find((o) => o.client_order_id === d.id);
  if (repetida) return repetida;
  const at = iso(t);
  const order = {
    id: id(),
    client_order_id: d.id,
    symbol: p.symbol,
    side: p.action,
    type: "limit",
    time_in_force: "day",
    qty: p.qty,
    filled_qty: 0,
    limit_price: r4(p.limitPrice),
    status: "new",
    created_at: at,
    submitted_at: at,
    updated_at: at,
    // Sin cierre conocido caduca en el acto: una orden del día no puede quedarse
    // abierta sin saber cuándo acaba la sesión.
    expires_at: s.market.nextClose ?? at,
    filled_at: null as string | null,
    filled_avg_price: null as number | null,
    canceled_at: null as string | null,
    expired_at: null as string | null,
    failed_at: null as string | null,
  };
  s.orders.unshift(order);
  s.orders = trimOrders(s.orders);
  d.status = "new";
  d.orderId = order.id;
  simulateFills(s, t, { arrivalOrderId: order.id });
  return order;
}

// Recorre las órdenes abiertas, de la más antigua a la más nueva: caducan las
// que pasaron su cierre y se ejecutan las que cruzan con un precio fiable.
//
// Regla de precio. Si la orden es ejecutable al llegar, entra al último precio,
// que es igual o mejor que su límite. Si espera y el precio cruza después, se
// ejecuta a su límite. Así funciona una orden limitada: la que llega ejecutable
// toma el precio que hay y la que espera se llena cuando el precio llega a ella.
// Dar siempre el mejor de los dos sería optimista: se mira cada 2 s y el precio
// visto suele haber atravesado ya el límite, el último trade de IEX no incluye el
// diferencial, y favorecería al nivel que más opera frente a Alpaca, que ejecuta
// de verdad.
export function simulateFills(
  s: State,
  t = Date.now(),
  opts: { arrivalOrderId?: string } = {},
) {
  const abierta = sessionOpen(s, t);
  let ejecutadas = 0;
  for (const o of [...s.orders].reverse()) {
    if (!isOpen(o)) continue;
    const expira = Date.parse(o.expires_at);
    // Por hora y sin calendario: vale tras un reinicio o en un festivo.
    if (!Number.isFinite(expira) || t >= expira) {
      o.status = "expired";
      o.expired_at = o.updated_at = iso(t);
      continue;
    }
    if (!abierta) continue;
    const q = s.quotes[o.symbol];
    const llegada = o.id === opts.arrivalOrderId;
    const quoteAt = q ? Date.parse(q.at) : NaN;
    if (
      !q ||
      !Number.isFinite(q.price) ||
      q.price <= 0 ||
      !Number.isFinite(quoteAt) ||
      t - quoteAt > QUOTE_MAX_AGE_MS ||
      quoteAt > t + QUOTE_MAX_AHEAD_MS ||
      // IEX da operaciones antes de la apertura, fuera del mercado de la sesión.
      newYorkMinutes(q.at) < SESSION_OPEN_MINUTE ||
      // Un tick anterior al envío no puede ejecutar una orden que ya esperaba.
      (!llegada && !(quoteAt > Date.parse(o.submitted_at)))
    )
      continue;
    const limit = Number(o.limit_price),
      qty = Number(o.qty);
    const cruza = o.side === "buy" ? q.price <= limit : q.price >= limit;
    if (!cruza) continue;
    const price = r4(llegada ? q.price : limit);
    const cash = Number(s.account.cash);
    const pos = s.positions.find((x) => x.symbol === o.symbol);
    const prev = pos
      ? { qty: Number(pos.qty), avgPrice: Number(pos.avg_entry_price) }
      : undefined;
    // orderGuard ya lo comprobó y solo hay una orden por activo; queda como
    // invariante por si cambian el efectivo o las posiciones entre medias.
    const falta =
      o.side === "buy"
        ? r4(qty * price) > cash
          ? "falta efectivo"
          : null
        : (prev?.qty ?? 0) < qty
          ? "faltan acciones"
          : null;
    if (falta) {
      o.status = "rejected";
      o.failed_at = o.updated_at = iso(t);
      log(s, "error", `Orden simulada de ${o.symbol} rechazada: ${falta}`);
      continue;
    }
    const next = holdingAfter(prev, o.side, qty, price);
    const cashAfter = r4(cash + next.cashDelta);
    if (next.qty === 0)
      s.positions = s.positions.filter((x) => x.symbol !== o.symbol);
    else {
      const nueva = position(o.symbol, next.qty, next.avgPrice, r4(q.price));
      if (pos) s.positions[s.positions.indexOf(pos)] = nueva;
      else s.positions.push(nueva);
    }
    s.account = { ...s.account, cash: cashAfter };
    o.status = "filled";
    o.filled_qty = qty;
    o.filled_avg_price = price;
    o.filled_at = o.updated_at = iso(t);
    s.fills.push({
      orderId: o.id,
      decisionId: o.client_order_id,
      symbol: o.symbol,
      side: o.side,
      qty,
      price,
      at: iso(t),
      quoteAt: q.at,
      cashAfter,
      realizedPl: next.realizedPl,
      rule: llegada ? "arrival" : "resting",
    });
    ejecutadas++;
  }
  // Sin esto orderGuard vería el efectivo nuevo con el valor de las posiciones
  // de antes hasta la siguiente valoración.
  if (ejecutadas) revalue(s);
  reconcileDecisions(s, s.orders);
  return ejecutadas;
}

// Lo que para la interna es sincronizar la cuenta: valorar las posiciones con los
// últimos precios, marcar lastSync y muestrear el patrimonio. Si el libro deja de
// cuadrar, pausa la simulación y devuelve el motivo.
export function markInternal(s: State, t = Date.now()) {
  // Se crea con startingBookFrom. Sin cuenta no hay nada que valorar.
  if (!s.account) return pauseInternal(s, "la simulación no tiene cuenta");
  revalue(s);
  s.lastSync = iso(t);
  if (s.baseline === null) s.baseline = Number(s.account.equity);
  sampleEquity(s, Number(s.account.equity), t);
  const problema =
    !Number.isFinite(Number(s.account.cash)) || Number(s.account.cash) < 0
      ? "efectivo negativo o no válido"
      : s.positions.some(
            (x) =>
              !Number.isFinite(x.qty) ||
              x.qty <= 0 ||
              !(Number(x.avg_entry_price) > 0),
          )
        ? "una posición con cantidad o precio medio no válido"
        : null;
  return problema ? pauseInternal(s, problema) : null;
}
// Solo avisa al pausar, no en cada valoración mientras siga pausada.
function pauseInternal(s: State, problema: string) {
  if (!s.paused)
    log(
      s,
      "error",
      `La contabilidad de la simulación interna no cuadra: ${problema}. Queda pausada.`,
    );
  s.paused = true;
  return problema;
}

// Cancela las órdenes abiertas. Devuelve cuántas.
export function cancelOpenInternal(s: State, t = Date.now()) {
  let canceladas = 0;
  for (const o of s.orders)
    if (isOpen(o)) {
      o.status = "canceled";
      o.canceled_at = o.updated_at = iso(t);
      canceladas++;
    }
  reconcileDecisions(s, s.orders);
  return canceladas;
}

// Reconstruye efectivo y posiciones desde un libro de partida y las ejecuciones.
// Debe dar lo mismo que bookOf del estado: si no, alguna ejecución no quedó
// apuntada o algo tocó el libro por fuera.
export function replayFills(start: Book, fills: Fill[]): Book {
  let cash = start.cash;
  const held = new Map(start.positions.map((x) => [x.symbol, { ...x }]));
  for (const f of fills) {
    const next = holdingAfter(held.get(f.symbol), f.side, f.qty, f.price);
    cash = r4(cash + next.cashDelta);
    if (next.qty === 0) held.delete(f.symbol);
    else
      held.set(f.symbol, {
        symbol: f.symbol,
        qty: next.qty,
        avgPrice: next.avgPrice,
      });
  }
  return {
    cash,
    positions: [...held.values()].sort((a, b) =>
      a.symbol.localeCompare(b.symbol),
    ),
  };
}
