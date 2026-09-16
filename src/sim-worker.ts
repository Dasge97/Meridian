// Lo que el worker hace por cada simulación: vigilancias y ejecuciones simuladas,
// bróker, modelo y avisos. src/worker.ts monta los bucles y la conexión; esto va
// aparte para poder probarlo contra PostgreSQL con Alpaca, el modelo y Telegram
// sustituidos, sin arrancar un worker.
//
// La simulación de Alpaca envía sus órdenes a Alpaca Paper. La interna nunca
// llama a Alpaca: acepta y ejecuta sus órdenes con src/paper.ts dentro de la
// misma transacción que las reserva.
import { describeFailure } from "./worker-failures.ts";
import { changeSim, readSim, readHot } from "./db.ts";
import { alpaca, configured, accountSnapshot } from "./alpaca.ts";
import {
  decide,
  review,
  modelConfigured,
  ModelFailure,
  type Spent,
} from "./model.ts";
import {
  log,
  limitPriceString,
  assetProblem,
  intentLabel,
  riskProfileOf,
  type AssetInfo,
  type Decision,
  type State,
} from "./domain.ts";
import { sendTelegram, telegramConfigured } from "./telegram.ts";
import {
  decisionNotice,
  newsNotice,
  orderNotice,
  reviewNotice,
  problemNotice,
  withSim,
  newsSims,
  type Notice,
} from "./report.ts";
import {
  applyWatches,
  applyAccount,
  claimIntent,
  claimJob,
  applyDecision,
  applyReview,
  failJob,
  queueNewsBeforeOpen,
  queueSessionScan,
  pickSim,
  type SimCandidate,
} from "./agent.ts";
import { acceptInternalOrder, simulateFills, markInternal } from "./paper.ts";
import { sessionOpen } from "./clock.ts";
import { SIM_IDS, SIMS, type SimId } from "./sims.ts";

export const ACCOUNT_SYNC_MS = 30000;
// Cuántas llamadas al modelo a la vez. Con 2 o más, cada simulación tiene su
// bucle y una llamada de 45 s de una no frena a la otra. Con 1, un solo bucle
// elige con pickSim a quién atender. Un valor que no es un entero positivo vale 2.
export function modelConcurrency(value: string | undefined) {
  const n = Number(value ?? 2);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

export type SimWorkerDeps = {
  alpaca: typeof alpaca;
  accountSnapshot: typeof accountSnapshot;
  configured: () => boolean;
  modelConfigured: () => boolean;
  decide: (
    s: State,
    event: string,
  ) => Promise<Parameters<typeof applyDecision>[2]>;
  review: (
    s: State,
    d: Decision,
  ) => Promise<{ parsed: Parameters<typeof applyReview>[2]; spent: Spent }>;
  telegramConfigured: () => boolean;
  sendTelegram: (text: string) => Promise<unknown>;
  // Qué simulaciones mandan sus comentarios de noticias (TELEGRAM_NEWS_SIMS).
  newsSims: readonly SimId[];
  appOrigin: string | undefined;
  now: () => number;
};

// Las decisiones cuyo estado ha cambiado desde antes, como avisos de orden.
function orderNotices(s: State, antes: Map<string, string>) {
  return s.decisions
    .filter((d) => antes.get(d.id) !== d.status)
    .map((d) => orderNotice(s, d, d.status))
    .filter((n): n is Notice => n !== null);
}
const statuses = (s: State) =>
  new Map(s.decisions.map((d) => [d.id, d.status]));

export function simWorker(overrides: Partial<SimWorkerDeps> = {}) {
  const deps: SimWorkerDeps = {
    alpaca,
    accountSnapshot,
    configured,
    modelConfigured,
    decide,
    review,
    telegramConfigured,
    sendTelegram,
    newsSims: newsSims(process.env.TELEGRAM_NEWS_SIMS).sims,
    appOrigin: process.env.APP_ORIGIN,
    now: Date.now,
    ...overrides,
  };
  const lastAccountSync = {} as Record<SimId, number>,
    syncFailure = {} as Record<SimId, string>;
  let lastServed: SimId | null = null;

  // Enviar un aviso nunca puede impedir que el laboratorio siga funcionando: si
  // Telegram falla, se registra y se sigue. Cada aviso dice de qué simulación es
  // y con qué nivel.
  async function notify(sim: SimId, notice: Notice | null) {
    if (!notice || !deps.telegramConfigured()) return;
    if (notice.kind === "noticias" && !deps.newsSims.includes(sim)) return;
    const hot = (await readHot([sim])).sims[sim];
    const conSim = withSim(notice, {
      label: SIMS[sim].label,
      riskLabel: riskProfileOf({ riskProfile: hot.riskProfile }).label,
    })!;
    try {
      await deps.sendTelegram(conSim.text);
      await changeSim(sim, (s) => {
        s.lastNotice = {
          at: new Date(deps.now()).toISOString(),
          kind: notice.kind,
        };
      });
    } catch (e) {
      await changeSim(sim, (s) => {
        log(
          s,
          "error",
          `No se pudo avisar por Telegram: ${describeFailure(e)}`,
        );
      });
    }
  }

  // Las vigilancias de una simulación con los precios compartidos y, en la
  // interna, las ejecuciones simuladas de sus órdenes abiertas. Sin nada que
  // mirar se evita leer su historial cada 2 segundos. Las órdenes de la interna
  // se ejecutan y caducan aunque esté en pausa, como en Alpaca, que no sabe de
  // pausas.
  async function watchesStep(sim: SimId) {
    const interna = SIMS[sim].broker === "internal";
    const hot = (await readHot([sim])).sims[sim];
    const vigilancias = hot.watches.some((w) => w.status === "active");
    const abiertas =
      interna &&
      hot.orders.some((o) =>
        ["new", "accepted", "pending_new", "partially_filled"].includes(
          o.status,
        ),
      );
    if (!vigilancias && !abiertas) return;
    const t = deps.now();
    const avisos = await changeSim(sim, (s) => {
      const antes = statuses(s);
      applyWatches(s, t);
      if (interna) simulateFills(s, t);
      return orderNotices(s, antes);
    });
    for (const aviso of avisos) await notify(sim, aviso);
  }

  // Reconcile ambiguous submissions after a crash or timeout. Never blindly resend.
  async function reconcileStep(sim: SimId) {
    const ambiguous = (await readSim(sim)).decisions
      .filter((d) => ["submitting", "unknown"].includes(d.status))
      .map((d) => d.id);
    for (const id of ambiguous) {
      try {
        const o = await deps.alpaca(
          "/v2/orders:by_client_order_id?client_order_id=" + id,
        );
        await changeSim(sim, (s) => {
          const target = s.decisions.find((x) => x.id === id);
          if (!target) return;
          target.status = o.status;
          target.orderId = o.id;
        });
      } catch {
        const aviso = await changeSim(sim, (s) => {
          const target = s.decisions.find((x) => x.id === id);
          if (!target) return null;
          const primeraVez = target.status !== "unknown";
          if (primeraVez)
            log(
              s,
              "error",
              "Envío incierto. Agente pausado; comprueba la orden en Alpaca y reconcilia desde el panel.",
            );
          target.status = "unknown";
          s.paused = true;
          return primeraVez
            ? problemNotice(
                `No se sabe si la orden de ${target.proposal.symbol} llegó a Alpaca. El agente queda pausado hasta que lo resuelvas desde el panel. No se reenviará sola.`,
                deps.appOrigin,
              )
            : null;
        });
        await notify(sim, aviso);
      }
    }
  }

  async function submitStep(sim: SimId) {
    const intent = await changeSim(sim, (s) => claimIntent(s, sessionOpen(s)));
    if (!intent) return;
    const p = intent.proposal;
    // Consultar el activo no envía nada. Si falla, la orden no ha salido: se
    // bloquea con el motivo en lugar de pausar el agente como con un envío incierto.
    let asset: AssetInfo;
    try {
      asset = await deps.alpaca("/v2/assets/" + p.symbol);
    } catch (e) {
      await changeSim(sim, (s) => {
        const d = s.decisions.find((x) => x.id === intent.id);
        if (!d) return;
        d.status = "blocked";
        d.error = `No se pudo consultar el activo en Alpaca: ${describeFailure(e)}`;
      });
      return;
    }
    // Que el activo se pueda negociar. El resto de comprobaciones de orderGuard ya
    // las pasó claimIntent.
    const problema = assetProblem(asset);
    if (problema) {
      await changeSim(sim, (s) => {
        const d = s.decisions.find((x) => x.id === intent.id);
        if (!d) return;
        d.status = "blocked";
        d.error = problema;
      });
      return;
    }
    try {
      const order = await deps.alpaca("/v2/orders", "POST", {
        symbol: p.symbol,
        qty: String(p.qty),
        side: p.action,
        type: "limit",
        limit_price: limitPriceString(p.limitPrice!),
        time_in_force: "day",
        extended_hours: false,
        client_order_id: intent.id,
      });
      const aviso = await changeSim(sim, (s) => {
        const d = s.decisions.find((x) => x.id === intent.id);
        if (!d) return null;
        d.status = order.status;
        d.orderId = order.id;
        log(
          s,
          "order",
          `Orden enviada a Alpaca Paper: ${intentLabel(d.intent, p.action)} de ${p.symbol}`,
        );
        return orderNotice(s, d, order.status);
      });
      await notify(sim, aviso);
    } catch {
      const aviso = await changeSim(sim, (s) => {
        const d = s.decisions.find((x) => x.id === intent.id);
        if (d) d.status = "unknown";
        s.paused = true;
        log(
          s,
          "error",
          "Respuesta de orden incierta; pausa y reconciliación obligatoria.",
        );
        return problemNotice(
          `La orden de ${intent.proposal.symbol} se envió pero Alpaca no confirmó. El agente queda pausado y hay que reconciliar desde el panel.`,
          deps.appOrigin,
        );
      });
      await notify(sim, aviso);
    }
  }

  // La cuenta de una simulación de Alpaca cada 30 segundos, y después reconciliar
  // y enviar como siempre.
  async function alpacaBrokerStep(sim: SimId) {
    if (
      deps.configured() &&
      deps.now() - (lastAccountSync[sim] ?? 0) > ACCOUNT_SYNC_MS
    ) {
      lastAccountSync[sim] = deps.now();
      try {
        const x = await deps.accountSnapshot();
        const recuperada = Boolean(syncFailure[sim]);
        syncFailure[sim] = "";
        const avisos = await changeSim(sim, (s) => {
          const antes = statuses(s);
          applyAccount(s, x);
          queueNewsBeforeOpen(s);
          queueSessionScan(s);
          if (recuperada)
            log(s, "market", "Alpaca vuelve a sincronizar la cuenta.");
          return orderNotices(s, antes);
        });
        for (const aviso of avisos) await notify(sim, aviso);
      } catch (e) {
        // Se registra el motivo y solo la primera vez de una racha: antes quedaba
        // un aviso idéntico cada 30 segundos, sin decir qué fallaba.
        const motivo = describeFailure(e);
        if (motivo !== syncFailure[sim]) {
          syncFailure[sim] = motivo;
          await changeSim(sim, (s) => {
            log(
              s,
              "error",
              `No se pudo sincronizar Alpaca (${motivo}). No se enviarán órdenes con datos obsoletos.`,
            );
          });
        }
      }
    }
    await reconcileStep(sim);
    await submitStep(sim);
  }

  // Lo mismo para la interna, sin salir de PostgreSQL. Cada 30 segundos valora la
  // cuenta con los últimos precios, que es lo que orderGuard pide como cuenta
  // sincronizada, y encola el repaso de noticias y la revisión periódica. Después
  // reserva la intención y acepta la orden en la misma transacción: una orden
  // interna nunca pasa por submitting ni por unknown, y un reinicio la deja
  // entera o no la deja.
  async function internalBrokerStep(sim: SimId) {
    if (deps.now() - (lastAccountSync[sim] ?? 0) > ACCOUNT_SYNC_MS) {
      lastAccountSync[sim] = deps.now();
      const t = deps.now();
      const aviso = await changeSim(sim, (s) => {
        const estabaPausada = s.paused;
        const problema = markInternal(s, t);
        queueNewsBeforeOpen(s, t);
        queueSessionScan(s, t);
        return problema && !estabaPausada
          ? problemNotice(
              `La contabilidad de la simulación interna no cuadra: ${problema}. Queda pausada hasta que lo revises.`,
              deps.appOrigin,
            )
          : null;
      });
      await notify(sim, aviso);
    }
    const t = deps.now();
    const aviso = await changeSim(sim, (s) => {
      const intent = claimIntent(s, sessionOpen(s, t), t);
      if (!intent) return null;
      const d = s.decisions.find((x) => x.id === intent.id)!;
      const p = d.proposal;
      try {
        acceptInternalOrder(s, d, t);
      } catch (e) {
        // orderGuard ya lo comprobó; si aun así no es una orden válida, se bloquea
        // en lugar de reintentarla cada 2 segundos.
        d.status = "blocked";
        d.error = describeFailure(e);
        return null;
      }
      log(
        s,
        "order",
        `Orden simulada aceptada: ${intentLabel(d.intent, p.action)} de ${p.symbol}`,
      );
      return orderNotice(s, d, d.status);
    });
    await notify(sim, aviso);
  }

  async function brokerStep(sim: SimId) {
    if (SIMS[sim].broker === "internal") return internalBrokerStep(sim);
    return alpacaBrokerStep(sim);
  }

  // Model calls run here, outside any transaction and outside the market loop.
  // Devuelve si llegó a reservar un trabajo.
  async function modelStep(sim: SimId) {
    const job = await changeSim(sim, (s) =>
      claimJob(s, deps.configured() && deps.modelConfigured(), deps.now()),
    );
    if (!job) return false;
    // Lo gastado en una llamada que respondió bien pero no se llegó a guardar.
    let unsaved: Spent | undefined;
    try {
      if (job.due) {
        const result = await deps.review(job.state, job.due);
        unsaved = result.spent;
        const aviso = await changeSim(sim, (s) => {
          const due = applyReview(
            s,
            job,
            result.parsed,
            result.spent,
            deps.now(),
          );
          return due ? reviewNotice(s, due) : null;
        });
        unsaved = undefined;
        await notify(sim, aviso);
        return true;
      }
      const result = await deps.decide(job.state, job.event!);
      unsaved = result.spent;
      const avisos = await changeSim(sim, (s) => {
        const t = deps.now();
        const d = applyDecision(s, job, result, sessionOpen(s, t), t);
        return [newsNotice(s, d), decisionNotice(s, d, t)];
      });
      unsaved = undefined;
      for (const aviso of avisos) await notify(sim, aviso);
    } catch (e) {
      // Sin el motivo concreto no hay forma de saber si falló el proveedor, si
      // tardó demasiado o si la respuesta no cumplía el esquema. El fallo del
      // modelo lleva dentro lo que llegó a cobrar el proveedor.
      const failure = e instanceof ModelFailure ? e : null;
      const motivo = describeFailure(failure ? failure.original : e);
      await changeSim(sim, (s) =>
        failJob(s, job, motivo, failure ? failure.spent : unsaved, deps.now()),
      );
    }
    return true;
  }

  // Con MODEL_CONCURRENCY=1: una llamada cada vez, para la simulación que elija
  // pickSim. Si la elegida no tiene nada que hacer (espera entre llamadas, límite
  // diario, sin revisiones vencidas), se prueba la siguiente. La reserva del
  // trabajo va justo antes de la llamada: si se reservara mientras espera, el
  // panel diría «Evaluando» y un reinicio la contaría como interrumpida.
  async function scheduledModelStep() {
    const hot = (await readHot()).sims;
    let candidatas: SimCandidate[] = SIM_IDS.filter(
      // Una pausada solo entra para recuperar una evaluación interrumpida.
      (x) => !hot[x].paused || hot[x].modelJob !== null,
    ).map((x) => ({
      sim: x,
      trigger: hot[x].queue[0]
        ? (hot[x].queue[0].trigger ?? "other")
        : "review",
      queuedAt: hot[x].queue[0]?.at ?? null,
    }));
    while (candidatas.length) {
      const sim = pickSim(candidatas, lastServed)!;
      if (await modelStep(sim)) {
        lastServed = sim;
        return sim;
      }
      candidatas = candidatas.filter((c) => c.sim !== sim);
    }
    return null;
  }

  return {
    notify,
    watchesStep,
    brokerStep,
    modelStep,
    scheduledModelStep,
  };
}
