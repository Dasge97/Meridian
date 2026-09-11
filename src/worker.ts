import WebSocket from "ws";
import { z } from "zod";
import { pool, change, read } from "./db.ts";
import { alpaca, configured, snapshot } from "./alpaca.ts";
import { decide, review, modelConfigured } from "./model.ts";
import {
  id,
  now,
  log,
  enqueue,
  validWatch,
  watchState,
  orderGuard,
  lessonSchema,
  type Quote,
} from "./domain.ts";
// One worker owns the market connection and outbox, including across rolling restarts.
const lock = await pool.connect();
if (!(await lock.query("SELECT pg_try_advisory_lock(746391) AS ok")).rows[0].ok)
  throw new Error("Otro worker está activo");
lock.on("error", () => process.exit(1));
let stopping = false,
  ws: WebSocket | undefined,
  retryAt = 0,
  lastSync = 0,
  lastTick = 0,
  streamSymbols = "",
  marketOpen = false;
const quotes: Record<string, Quote> = {};
function connect(symbols: string[]) {
  if (!configured() || Date.now() < retryAt) return;
  streamSymbols = symbols.join(",");
  retryAt = Date.now() + 10000;
  ws = new WebSocket("wss://stream.data.alpaca.markets/v2/iex");
  ws.on("open", () =>
    ws?.send(
      JSON.stringify({
        action: "auth",
        key: process.env.ALPACA_KEY_ID,
        secret: process.env.ALPACA_SECRET_KEY,
      }),
    ),
  );
  ws.on("message", (buffer) => {
    lastTick = Date.now();
    try {
      for (const m of JSON.parse(buffer.toString())) {
        if (m.T === "success" && m.msg === "authenticated")
          ws?.send(JSON.stringify({ action: "subscribe", trades: symbols }));
        if (
          m.T === "t" &&
          symbols.includes(m.S) &&
          Number.isFinite(m.p) &&
          m.p > 0
        )
          quotes[m.S] = { price: m.p, at: m.t };
        if (m.T === "error") {
          console.error("Market stream error", m.code);
          ws?.close();
        }
      }
    } catch {
      console.error("Invalid market message");
    }
  });
  ws.on("error", () => ws?.close());
  ws.on("close", () => {
    ws = undefined;
    retryAt = Date.now() + 10000;
  });
}
async function tick() {
  const state = await read();
  if (ws && streamSymbols !== state.settings.symbols.join(",")) ws.close();
  if (!ws) connect(state.settings.symbols);
  if (configured() && Date.now() - lastSync > 30000) {
    lastSync = Date.now();
    try {
      const x = await snapshot(state.settings.symbols);
      marketOpen = Boolean(x.clock.is_open);
      await change((s) => {
        s.account = x.account;
        s.positions = x.positions;
        s.orders = x.orders;
        s.lastSync = now();
        if (s.baseline === null) s.baseline = Number(x.account.equity);
        for (const [symbol, t] of Object.entries(x.trades.trades ?? {}) as [
          string,
          any,
        ][])
          if (t?.p > 0) s.quotes[symbol] = { price: t.p, at: t.t };
        if (
          !s.equity.length ||
          Date.now() - Date.parse(s.equity.at(-1)!.at) > 300000
        )
          s.equity.push({ at: now(), value: Number(x.account.equity) });
        for (const d of s.decisions) {
          const o = x.orders.find((o: any) => o.client_order_id === d.id);
          if (o && d.status !== o.status) {
            d.status = o.status;
            d.orderId = o.id;
            log(s, "order", `${d.proposal.symbol}: ${o.status}`);
            if (o.status === "filled") enqueue(s, `Orden ejecutada: ${d.id}`);
          }
        }
      });
    } catch {
      await change((s) => {
        log(
          s,
          "error",
          "No se pudo sincronizar Alpaca; no se enviarán órdenes con datos obsoletos.",
        );
      });
    }
  }
  await change((s) => {
    s.heartbeat = now();
    s.stream =
      ws?.readyState === WebSocket.OPEN && Date.now() - lastTick < 120000
        ? "connected"
        : "disconnected";
    for (const [symbol, q] of Object.entries(quotes))
      if (
        s.settings.symbols.includes(symbol) &&
        (!s.quotes[symbol] ||
          Date.parse(q.at) > Date.parse(s.quotes[symbol].at))
      )
        s.quotes[symbol] = q;
    for (const w of s.watches) {
      const next = watchState(w, s.paused ? undefined : s.quotes[w.symbol]);
      if (next !== w.status) {
        w.status = next;
        log(s, "watch", `${w.symbol}: vigilancia ${next}`);
        if (next === "triggered") enqueue(s, `Vigilancia ${w.id}: ${w.reason}`);
      }
    }
  });
  // Reconcile ambiguous submissions after a crash or timeout. Never blindly resend.
  const current = await read();
  for (const d of current.decisions.filter((d) =>
    ["submitting", "unknown"].includes(d.status),
  )) {
    try {
      const o = await alpaca(
        "/v2/orders:by_client_order_id?client_order_id=" + d.id,
      );
      await change((s) => {
        const target = s.decisions.find((x) => x.id === d.id)!;
        target.status = o.status;
        target.orderId = o.id;
      });
    } catch {
      await change((s) => {
        const target = s.decisions.find((x) => x.id === d.id)!;
        if (target.status !== "unknown")
          log(
            s,
            "error",
            "Envío incierto. Agente pausado; comprueba la orden en Alpaca y reconcilia desde el panel.",
          );
        target.status = "unknown";
        s.paused = true;
      });
    }
  }
  const intent = await change((s) => {
    const d = s.decisions.find((x) => x.status === "pending");
    if (!d) return null;
    const shadow = {
      ...s,
      decisions: s.decisions.filter((x) => x.id !== d.id),
    };
    const error = !marketOpen
      ? "Mercado cerrado"
      : orderGuard(shadow, d.proposal);
    if (error) {
      d.status = "blocked";
      d.error = error;
      return null;
    }
    d.status = "submitting";
    d.sentAt = now();
    return structuredClone(d);
  });
  if (intent) {
    try {
      const p = intent.proposal;
      const asset = await alpaca("/v2/assets/" + p.symbol);
      if (!asset.tradable || asset.status !== "active") {
        await change((s) => {
          const d = s.decisions.find((x) => x.id === intent.id)!;
          d.status = "blocked";
          d.error = "Activo no negociable";
        });
        return;
      }
      const order = await alpaca("/v2/orders", "POST", {
        symbol: p.symbol,
        qty: String(p.qty),
        side: p.action,
        type: "limit",
        limit_price: p.limitPrice!.toFixed(2),
        time_in_force: "day",
        extended_hours: false,
        client_order_id: intent.id,
      });
      await change((s) => {
        const d = s.decisions.find((x) => x.id === intent.id)!;
        d.status = order.status;
        d.orderId = order.id;
        log(s, "order", `Orden enviada a Alpaca Paper: ${p.symbol}`);
      });
    } catch {
      await change((s) => {
        s.decisions.find((x) => x.id === intent.id)!.status = "unknown";
        s.paused = true;
        log(
          s,
          "error",
          "Respuesta de orden incierta; pausa y reconciliación obligatoria.",
        );
      });
    }
    return;
  }
  // Reserve model work durably before spending tokens. Network calls never lock the panel.
  const job = await change((s) => {
    if (s.modelJob) {
      log(
        s,
        "error",
        "Evaluación interrumpida recuperada. El intento ya cuenta para el límite diario.",
      );
      s.modelJob = null;
    }
    if (s.paused || !configured() || !modelConfigured()) return null;
    const day = now().slice(0, 10);
    if (s.calls.day !== day) s.calls = { day, count: 0 };
    if (s.calls.count >= s.settings.maxDailyCalls) return null;
    if (
      s.lastDecision &&
      Date.now() - Date.parse(s.lastDecision) <
        s.settings.cooldownSeconds * 1000
    )
      return null;
    const due = s.decisions.find(
      (d) =>
        !d.review &&
        (d.reviewAttempts ?? 0) < 3 &&
        Date.parse(d.reviewAt) <= Date.now(),
    );
    const event = s.queue[0];
    if (!due && !event) return null;
    s.calls.count++;
    s.lastDecision = now();
    if (due) due.reviewAttempts = (due.reviewAttempts ?? 0) + 1;
    else s.queue.shift();
    s.modelJob = {
      id: id(),
      startedAt: now(),
      kind: due ? "review" : "decision",
      targetId: due?.id ?? event.id,
    };
    return {
      meta: s.modelJob,
      state: structuredClone(s),
      due: due ? structuredClone(due) : null,
      event: event?.reason,
    };
  });
  if (!job) return;
  try {
    if (job.due) {
      const result = await review(job.state, job.due);
      const parsed = z
        .object({
          text: z.string().min(10).max(6000),
          lessons: z.array(lessonSchema).max(3),
        })
        .parse(result.value);
      await change((s) => {
        const due = s.decisions.find((d) => d.id === job.due!.id)!;
        due.review = {
          at: now(),
          text: parsed.text,
          price: due.proposal.symbol
            ? (job.state.quotes[due.proposal.symbol]?.price ?? null)
            : null,
        };
        for (const l of parsed.lessons)
          s.lessons.push({
            ...l,
            id: id(),
            status: "proposed",
            createdAt: now(),
            decisionId: due.id,
          });
        s.usage.push({ at: now(), tokens: result.tokens });
        s.modelJob = null;
        log(s, "review", `Revisión completada: ${due.id}`);
      });
      return;
    }
    const result = await decide(job.state, job.event!);
    await change((s) => {
      const p = result.proposal;
      const obsolete =
        s.activeVersion !== job.state.activeVersion ||
        JSON.stringify(s.settings) !== JSON.stringify(job.state.settings);
      let error: string | null = null;
      if (p.action !== "wait")
        error = obsolete
          ? "Configuración modificada durante la evaluación"
          : !marketOpen
            ? "Mercado cerrado"
            : orderGuard(s, p);
      const d = {
        id: id(),
        at: now(),
        versionId: job.state.activeVersion,
        event: job.event!,
        input: result.input,
        proposal: p,
        status:
          p.action === "wait" ? "observed" : error ? "blocked" : "pending",
        error: error ?? undefined,
        reviewAt: new Date(
          Date.now() + p.reviewAfterHours * 3600000,
        ).toISOString(),
      };
      s.decisions.push(d);
      s.usage.push({ at: now(), tokens: result.tokens });
      if (!obsolete && !s.paused)
        for (const w of p.watches)
          if (validWatch(w, s))
            s.watches.push({
              ...w,
              id: id(),
              status: "active",
              createdAt: now(),
              decisionId: d.id,
            });
      for (const l of p.lessons)
        s.lessons.push({
          ...l,
          id: id(),
          status: "proposed",
          createdAt: now(),
          decisionId: d.id,
        });
      s.modelJob = null;
      log(s, "decision", `${p.action}: ${p.reason.slice(0, 200)}`);
    });
  } catch {
    await change((s) => {
      s.modelJob = null;
      log(
        s,
        "error",
        "Falló la evaluación del modelo o su esquema. El intento cuenta para el límite diario. Puedes solicitar otra reevaluación. Las revisiones se intentan como máximo 3 veces.",
      );
    });
  }
}
process.on("SIGTERM", () => {
  stopping = true;
  ws?.close();
});
process.on("SIGINT", () => {
  stopping = true;
  ws?.close();
});
console.log("Meridian worker: paper only");
while (!stopping) {
  try {
    await tick();
  } catch {
    console.error("Worker tick failed");
  }
  await new Promise((r) => setTimeout(r, 2000));
}
await lock.query("SELECT pg_advisory_unlock(746391)");
lock.release();
await pool.end();
