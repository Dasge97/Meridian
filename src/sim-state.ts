// Dónde se guarda cada campo del estado y cómo se arma la vista de una
// simulación. Sin entrada ni salida: src/db.ts lee y escribe las filas, y esto
// decide qué va en cada una, así que se prueba directamente.
//
// Lo compartido (límites, precios, calendario, análisis, noticias) vive en
// shared:hot y shared:cold. Lo de cada simulación (nivel de riesgo, cuenta,
// memoria, decisiones, eventos) vive en sim:<id>:hot y sim:<id>:cold. Las filas
// calientes se reescriben a menudo y son pequeñas; las frías guardan el
// historial y solo se escriben cuando pasa algo.
//
// Las transiciones del agente trabajan sobre la vista State, que junta lo
// compartido con lo de una simulación y tiene la misma forma que el estado de
// cuando solo había una. Así no cambian de firma.
import {
  initialState,
  comparisonStart,
  id,
  log,
  DEFAULT_RISK_PROFILE,
  riskProfileOf,
  REVIEW_ATTEMPTS,
  type State,
  type Settings,
  type Event,
  type RiskProfile,
} from "./domain.ts";
import { recordAlpacaFills } from "./agent.ts";
import { startingBookFrom } from "./paper.ts";
import { SIMS, type SimId, type SimSummary } from "./sims.ts";

export const sharedHotKeys = [
  "settings",
  "quotes",
  "heartbeat",
  "stream",
  "feeds",
  "market",
  "marketSync",
] as const;
export const sharedColdKeys = [
  "analysis",
  "intraday",
  "stories",
  "systemEvents",
] as const;
export const simHotKeys = [
  "riskProfile",
  "paused",
  "activeVersion",
  "watches",
  "queue",
  "account",
  "positions",
  "orders",
  "lastSync",
  "lastDecision",
  "calls",
  "baseline",
  "lastNotice",
  "preOpenNews",
  "modelJob",
  "commentedStories",
  "startedAt",
  "unresolved",
] as const;
export const simColdKeys = [
  "versions",
  "lessons",
  "decisions",
  "events",
  "equity",
  "usage",
  "fills",
  "comparison",
] as const;

type SharedRowKey =
  (typeof sharedHotKeys)[number] | (typeof sharedColdKeys)[number];
type SimRowKey = (typeof simHotKeys)[number] | (typeof simColdKeys)[number];
// Los campos que pasan tal cual de la vista a las filas y de vuelta.
type SharedPlainKey = Exclude<SharedRowKey, "settings" | "systemEvents">;
type SimPlainKey = Exclude<
  SimRowKey,
  "riskProfile" | "commentedStories" | "unresolved"
>;

export type SharedSettings = Omit<Settings, "riskProfile">;
export type SharedState = Pick<State, SharedPlainKey> & {
  // Sin riskProfile: es de cada simulación.
  settings: SharedSettings;
  // Eventos de lo compartido. Las noticias van sin commented: qué se ha
  // comentado lo guarda cada simulación en commentedStories.
  systemEvents: Event[];
};
export type SimState = Pick<State, SimPlainKey> & {
  id: SimId;
  riskProfile: RiskProfile;
  commentedStories: string[];
  // Cuántas decisiones tienen la orden incierta o enviándose. Sale de las
  // decisiones, que están en la fila fría, y se guarda en la caliente para que el
  // selector del panel lo vea sin leer el historial de las otras simulaciones.
  // No está en la vista: se recalcula cada vez que se guarda.
  unresolved: number;
};

// Un campo nuevo de State que no está en ninguna fila no compila. Tampoco uno que
// esté en las dos partes.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _view: Same<
  keyof State,
  SharedPlainKey | SimPlainKey | "settings" | "sim" | "broker"
> = true;
const _disjoint: Same<Extract<SharedPlainKey, SimPlainKey>, never> = true;
const _shared: Same<keyof SharedState, SharedRowKey> = true;
const _sim: Same<Exclude<keyof SimState, "id">, SimRowKey> = true;
void [_view, _disjoint, _shared, _sim];

export const SHARED_KEYS = ["shared:cold", "shared:hot"] as const;
export const simKeys = (sim: SimId) =>
  [`sim:${sim}:cold`, `sim:${sim}:hot`] as const;
export const hotKey = (scope: "shared" | SimId) =>
  scope === "shared" ? "shared:hot" : `sim:${scope}:hot`;

const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;
const sharedPlain = [...sharedHotKeys, ...sharedColdKeys].filter(
  (k): k is SharedPlainKey => k !== "settings" && k !== "systemEvents",
);
const simPlain = [...simHotKeys, ...simColdKeys].filter(
  (k): k is SimPlainKey =>
    k !== "riskProfile" && k !== "commentedStories" && k !== "unresolved",
);
// Una orden que Alpaca no confirmó o que se estaba enviando: hay que resolverla
// antes de activar la simulación.
export const UNRESOLVED_STATUSES = ["unknown", "submitting"];
export const unresolvedCount = (decisions: State["decisions"]) =>
  decisions.filter((d) => UNRESOLVED_STATUSES.includes(d.status)).length;

// La vista de una simulación. El nivel de riesgo vuelve a los ajustes y cada
// noticia dice si esta simulación ya la comentó.
export function composeState(sh: SharedState, sim: SimState): State {
  const commented = new Set(sim.commentedStories);
  return {
    ...pick(sh, sharedPlain),
    ...pick(sim, simPlain),
    sim: sim.id,
    broker: SIMS[sim.id].broker,
    settings: { ...sh.settings, riskProfile: sim.riskProfile },
    stories: sh.stories.map((n) => ({ ...n, commented: commented.has(n.id) })),
  };
}
// Lo contrario de composeState. La vista no lleva los eventos compartidos, así
// que se pasan aparte. commentedStories solo guarda noticias que siguen
// existiendo.
export function decomposeState(
  v: State,
  systemEvents: Event[] = [],
): { shared: SharedState; sim: SimState } {
  const { riskProfile, ...settings } = v.settings;
  return {
    shared: {
      ...pick(v, sharedPlain),
      settings,
      stories: v.stories.map(({ commented: _c, ...n }) => n),
      systemEvents,
    },
    sim: {
      ...pick(v, simPlain),
      id: v.sim,
      riskProfile,
      commentedStories: v.stories.filter((n) => n.commented).map((n) => n.id),
      unresolved: unresolvedCount(v.decisions),
    },
  };
}

// Los valores iniciales salen de initialState, que sigue siendo el único sitio
// donde se escriben.
export const initialShared = () => decomposeState(initialState()).shared;
export const initialSim = (id: SimId): SimState => ({
  ...decomposeState(initialState()).sim,
  id,
});
// Arma lo compartido a partir de sus filas. Un campo que no existía al guardarse
// aparece con su valor inicial, también dentro de los ajustes, y lo que no es de
// estas filas se ignora.
export function restoreShared(parts: unknown[]): SharedState {
  const base = initialShared();
  const saved = Object.assign({}, ...parts) as Record<string, unknown>;
  const sh = { ...base };
  for (const k of [...sharedHotKeys, ...sharedColdKeys])
    if (k in saved) (sh as Record<string, unknown>)[k] = saved[k];
  const { riskProfile: _r, ...settings } = {
    ...base.settings,
    ...(sh.settings as Partial<Settings>),
  };
  sh.settings = settings;
  sh.stories = sh.stories.map(({ commented: _c, ...n }) => n);
  return sh;
}
export function restoreSim(id: SimId, parts: unknown[]): SimState {
  const base = initialSim(id);
  const saved = Object.assign({}, ...parts) as Record<string, unknown>;
  const sim = { ...base };
  for (const k of [...simHotKeys, ...simColdKeys])
    if (k in saved) (sim as Record<string, unknown>)[k] = saved[k];
  sim.id = id;
  sim.riskProfile ??= DEFAULT_RISK_PROFILE;
  return sim;
}
// El contenido de cada fila, por clave.
export const sharedRows = (sh: SharedState): Record<string, unknown> => ({
  "shared:cold": pick(sh, sharedColdKeys),
  "shared:hot": pick(sh, sharedHotKeys),
});
export const simRows = (sim: SimState): Record<string, unknown> => ({
  [simKeys(sim.id)[0]]: pick(sim, simColdKeys),
  [simKeys(sim.id)[1]]: pick(sim, simHotKeys),
});

// Lo compartido tal como lo ve una simulación, en texto, para saber después si
// una transición lo ha tocado. En texto porque la vista comparte objetos con lo
// compartido y un cambio en el sitio no se vería comparando objetos. Los eventos
// compartidos no están en la vista.
export function sharedFingerprint(sh: SharedState) {
  return new Map(
    [...sharedHotKeys, ...sharedColdKeys]
      .filter((k) => k !== "systemEvents")
      .map((k) => [k, JSON.stringify(sh[k])] as const),
  );
}
// Qué campos compartidos han cambiado desde la huella, por nombre.
export function sharedDifferences(
  before: Map<string, string>,
  sh: SharedState,
) {
  return [...before]
    .filter(([k, v]) => JSON.stringify(sh[k as keyof SharedState]) !== v)
    .map(([k]) => k);
}

// El formato de antes: meridian_state con la fila 1 caliente y la 2 con el
// historial. La migración lo lee y migrate:down lo vuelve a escribir.
export const legacyHotKeys = [
  "paused",
  "settings",
  "activeVersion",
  "watches",
  "queue",
  "quotes",
  "account",
  "positions",
  "orders",
  "heartbeat",
  "lastSync",
  "lastDecision",
  "calls",
  "baseline",
  "stream",
  "feeds",
  "market",
  "lastNotice",
  "preOpenNews",
  "modelJob",
] as const;
export const legacyColdKeys = [
  "versions",
  "lessons",
  "decisions",
  "events",
  "equity",
  "usage",
  "analysis",
  "intraday",
  "stories",
] as const;
// Lo que el formato de antes no tenía.
export const addedKeys = [
  "sim",
  "broker",
  "marketSync",
  "fills",
  "comparison",
  "startedAt",
] as const;
const _legacy: Same<
  keyof State,
  | (typeof legacyHotKeys)[number]
  | (typeof legacyColdKeys)[number]
  | (typeof addedKeys)[number]
> = true;
void _legacy;
export const legacyRows = (s: State) => ({
  1: pick(s, legacyHotKeys),
  2: pick(s, legacyColdKeys),
});

// Lo que impide migrar sin perder nada, o null. La migración aborta con este
// mensaje y no cambia nada.
export function legacyProblem(legacy: State): string | null {
  const abiertas = legacy.decisions.filter((d) =>
    ["pending", "submitting", "unknown"].includes(d.status),
  );
  if (abiertas.length)
    return `Hay ${abiertas.length === 1 ? "una decisión" : `${abiertas.length} decisiones`} con la orden pendiente, enviándose o incierta: reconcilia o espera antes de migrar.`;
  const corta = legacy.positions.find((x) => Number(x.qty) < 0);
  if (corta)
    return `Hay una posición corta en Alpaca (${corta.symbol}, ${corta.qty}): ciérrala a mano antes de migrar.`;
  const rota = legacy.positions.find((x) => !Number.isFinite(Number(x.qty)));
  if (rota)
    return `La posición de ${rota.symbol} no trae una cantidad válida: revisa la cuenta antes de migrar.`;
  return null;
}

// El nivel con el que nace cada simulación al separarlas. Alpaca se queda en
// Equilibrado y la interna prueba Agresivo.
export const LEGACY_RISK_PROFILE: Record<SimId, RiskProfile> = {
  alpaca: "balanced",
  internal: "aggressive",
};
// El punto de partida de la comparación, o null si la cuenta aún no tiene
// patrimonio (una instalación nueva que no ha sincronizado con Alpaca).
export const comparisonAt = (v: State, t: number) =>
  v.account && Number.isFinite(Number(v.account.equity))
    ? comparisonStart(v, t)
    : null;
// Reparte el estado de antes entre lo compartido y la simulación de Alpaca. La
// vista que devuelve es la que tienen que componer las filas guardadas: la
// migración lo comprueba antes de confirmar.
export function splitLegacyState(legacy: State, t = Date.now()) {
  const v: State = structuredClone(legacy);
  v.sim = "alpaca";
  v.broker = SIMS.alpaca.broker;
  // Una evaluación a medias no se puede retomar tras parar el worker. claimJob
  // la cuenta igual al arrancar; aquí se deja dicho con el mismo texto.
  if (v.modelJob) {
    log(
      v,
      "error",
      "Evaluación interrumpida recuperada. El intento ya cuenta para el límite diario.",
    );
    v.modelJob = null;
  }
  if (v.settings.riskProfile !== LEGACY_RISK_PROFILE.alpaca) {
    v.settings.riskProfile = LEGACY_RISK_PROFILE.alpaca;
    log(v, "config", "Nivel fijado en Equilibrado al separar las simulaciones");
  }
  v.marketSync = null;
  // En la vista cada noticia dice siempre si está comentada, también con false.
  v.stories = v.stories.map((n) => ({ ...n, commented: Boolean(n.commented) }));
  // Las órdenes ya terminadas con algo ejecutado, para la tasa de acierto.
  v.fills = [];
  recordAlpacaFills(v, v.orders, t);
  v.comparison = comparisonAt(v, t);
  v.startedAt = v.equity[0]?.at ?? new Date(t).toISOString();
  return { view: v, ...decomposeState(v, []) };
}

// Lo que la interna tiene al crearse si Alpaca aún no tiene cuenta, en una
// instalación nueva: lo mismo que da Alpaca Paper a una cuenta nueva.
export const INTERNAL_STARTING_CASH = 100000;
// El motivo con el que la interna deja sin revisar lo que heredó de Alpaca.
export const INHERITED_REVIEW_SKIPPED =
  "Revisada en la simulación de Alpaca: es una operación anterior a la separación";
const OPEN_ORDER_STATUSES = [
  "new",
  "accepted",
  "pending_new",
  "partially_filled",
];
// La simulación interna nace como copia completa de la de Alpaca, como si las dos
// hubieran empezado a la vez: la misma cuenta (efectivo, posiciones con su precio
// medio y el mismo baseline), las lecciones, las versiones con la activa, las
// vigilancias activas con ids nuevos, las decisiones con su contexto, los
// eventos, la curva de patrimonio, las noticias comentadas y la misma pausa. No
// copia lo que es de Alpaca o de su gasto: consumo, llamadas del día, órdenes,
// ejecuciones, cola, evaluación en curso ni último aviso. Lanza un error con el
// motivo si la cuenta no se puede copiar; la migración lo cuenta y no cambia
// nada. alpaca es la vista de Alpaca ya con su comparison del mismo instante.
export function internalFromAlpaca(alpaca: State, t = Date.now()): State {
  const v: State = structuredClone(alpaca);
  v.sim = "internal";
  v.broker = SIMS.internal.broker;
  const nivel = LEGACY_RISK_PROFILE.internal;
  v.settings.riskProfile = nivel;
  Object.assign(
    v,
    startingBookFrom(
      alpaca.account
        ? alpaca
        : {
            account: { cash: INTERNAL_STARTING_CASH },
            positions: [],
            baseline: null,
          },
    ),
  );
  v.watches = alpaca.watches
    .filter((w) => w.status === "active")
    .map((w) => ({ ...structuredClone(w), id: id() }));
  v.usage = [];
  v.calls = { day: "", count: 0 };
  v.queue = [];
  v.modelJob = null;
  v.lastNotice = null;
  // La interna empieza sin órdenes abiertas: la decisión de una orden que sigue
  // abierta en Alpaca no tiene aquí orden que la siga, y se quedaría abierta para
  // siempre.
  let sinOrden = 0;
  for (const d of v.decisions)
    if (OPEN_ORDER_STATUSES.includes(d.status)) {
      d.status = "canceled";
      sinOrden++;
    }
  // Las operaciones heredadas ya las revisa Alpaca. Si las revisaran las dos, se
  // pagaría dos veces la misma revisión y saldrían las mismas lecciones en cada
  // una. Solo las que tienen orden y aún pueden revisarse: las demás no llegan
  // a llamar al modelo en ninguna de las dos.
  for (const d of v.decisions)
    if (
      d.orderId &&
      !d.review &&
      !d.reviewSkipped &&
      (d.reviewAttempts ?? 0) < REVIEW_ATTEMPTS
    )
      d.reviewSkipped = INHERITED_REVIEW_SKIPPED;
  v.comparison = comparisonStart(v, t);
  log(
    v,
    "control",
    `Simulación Interna creada como copia de Alpaca Paper, con nivel ${riskProfileOf(v.settings).label}. Sus órdenes se ejecutan dentro de Meridian y no salen a Alpaca.`,
  );
  if (sinOrden)
    log(
      v,
      "order",
      `${sinOrden === 1 ? "Una decisión tenía su orden abierta" : `${sinOrden} decisiones tenían su orden abierta`} en Alpaca: en la Interna queda cancelada, porque empieza sin órdenes.`,
    );
  return v;
}

// El resumen de una simulación para el selector del panel, con su fila caliente.
export function simSummary(
  hot: Pick<
    SimState,
    "id" | "riskProfile" | "paused" | "modelJob" | "account" | "baseline"
  > & { unresolved?: number },
): SimSummary {
  const equity = Number(hot.account?.equity);
  return {
    id: hot.id,
    label: SIMS[hot.id].label,
    broker: SIMS[hot.id].broker,
    riskProfile: hot.riskProfile,
    paused: hot.paused,
    evaluating: hot.modelJob !== null,
    equity: hot.account && Number.isFinite(equity) ? equity : null,
    baseline: hot.baseline,
    unresolved: hot.unresolved ?? 0,
  };
}
