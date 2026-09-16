import pg from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  initialState,
  log,
  pruneShared,
  pruneSim,
  restoreState,
  type State,
} from "./domain.ts";
import { SIM_IDS, type SimId } from "./sims.ts";
import type { DecisionLike } from "./compare.ts";
import {
  SHARED_KEYS,
  simKeys,
  hotKey,
  sharedHotKeys,
  simHotKeys,
  composeState,
  decomposeState,
  restoreShared,
  restoreSim,
  sharedRows,
  simRows,
  sharedDifferences,
  sharedFingerprint,
  legacyRows,
  legacyProblem,
  addedKeys,
  splitLegacyState,
  comparisonAt,
  internalFromAlpaca,
  type SharedState,
  type SimState,
} from "./sim-state.ts";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 10000,
});
// El worker lo toma al arrancar y lo conserva mientras vive. La migración y su
// vuelta atrás lo piden sin esperar: si está tomado, hay un worker en marcha.
export const WORKER_LOCK = 746391;

// Una transición de simulación solo puede cambiar lo suyo. Si toca lo compartido
// es un fallo de programación: se deshace todo y se dice qué campo tocó.
export class SharedStateTouched extends Error {
  constructor(public fields: string[]) {
    super(
      `Una transición de simulación intentó cambiar el estado compartido: ${fields.join(", ")}`,
    );
  }
}

type Client = pg.PoolClient;
type Rows = Map<string, unknown>;
const simAllKeys = (sims: readonly SimId[]) => sims.flatMap((x) => simKeys(x));
async function select(
  c: Client | pg.Pool,
  keys: readonly string[],
  lock: "" | "FOR SHARE" | "FOR UPDATE" = "",
): Promise<Rows> {
  const r = await c.query(
    `SELECT key, data FROM meridian_rows WHERE key = ANY($1::text[]) ORDER BY key ${lock}`,
    [keys],
  );
  return new Map(r.rows.map((x) => [x.key as string, x.data]));
}
function need(rows: Rows, keys: readonly string[]) {
  const faltan = keys.filter((k) => !rows.has(k));
  if (faltan.length)
    throw new Error(
      `Estado incompleto (falta ${faltan.join(", ")}): ejecuta la migración`,
    );
  return keys.map((k) => rows.get(k));
}
const serialize = (rows: Record<string, unknown>) =>
  new Map(Object.entries(rows).map(([k, v]) => [k, JSON.stringify(v)]));
// Solo se reescribe la fila cuyo contenido ha cambiado.
async function writeChanged(
  c: Client,
  before: Map<string, string>,
  after: Map<string, string>,
) {
  for (const [key, data] of after)
    if (before.get(key) !== data)
      await c.query("UPDATE meridian_rows SET data=$1 WHERE key=$2", [
        data,
        key,
      ]);
}
async function transaction<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

export async function readShared(): Promise<SharedState> {
  return restoreShared(need(await select(pool, SHARED_KEYS), SHARED_KEYS));
}
// Lo compartido y lo de una simulación, leídos en la misma consulta.
export async function readSimParts(
  sim: SimId,
): Promise<{ shared: SharedState; sim: SimState }> {
  const rows = await select(pool, [...SHARED_KEYS, ...simKeys(sim)]);
  return {
    shared: restoreShared(need(rows, SHARED_KEYS)),
    sim: restoreSim(sim, need(rows, simKeys(sim))),
  };
}
export async function readSim(sim: SimId): Promise<State> {
  const parts = await readSimParts(sim);
  return composeState(parts.shared, parts.sim);
}
export type SharedHot = Pick<SharedState, (typeof sharedHotKeys)[number]>;
export type SimHot = Pick<SimState, "id" | (typeof simHotKeys)[number]>;
// Solo las filas calientes: pausa, cola, cuenta, vigilancias, calendario. No lee
// el historial, así que sirve para mirar deprisa antes de decidir si hace falta
// una transacción.
// Lo que pide el panel cada 5 segundos, en una sola consulta: lo compartido, la
// simulación que se ve y las filas calientes de todas, para el selector.
export async function readPanel(sim: SimId) {
  const keys = [
    ...new Set([...SHARED_KEYS, ...simKeys(sim), ...SIM_IDS.map(hotKey)]),
  ];
  const rows = await select(pool, keys);
  return {
    shared: restoreShared(need(rows, SHARED_KEYS)),
    sim: restoreSim(sim, need(rows, simKeys(sim))),
    hot: Object.fromEntries(
      SIM_IDS.map((x) => [x, restoreSim(x, need(rows, [hotKey(x)]))]),
    ) as unknown as Record<SimId, SimHot>,
  };
}
export async function readHot(
  sims: readonly SimId[] = SIM_IDS,
): Promise<{ shared: SharedHot; sims: Record<SimId, SimHot> }> {
  const rows = await select(pool, ["shared:hot", ...sims.map(hotKey)]);
  const [sharedHot] = need(rows, ["shared:hot"]);
  return {
    shared: restoreShared([sharedHot]),
    sims: Object.fromEntries(
      sims.map((x) => [x, restoreSim(x, need(rows, [hotKey(x)]))]),
    ) as unknown as Record<SimId, SimHot>,
  };
}

// Lo que la comparación necesita de cada simulación, en una sola consulta. Las
// filas frías pesan sobre todo por el contexto guardado de las decisiones y el
// detalle del consumo, y la comparación no usa ninguno de los dos: PostgreSQL
// saca solo los campos que hacen falta y el resto no viaja ni se interpreta en
// Node. La curva de patrimonio y las ejecuciones van enteras, porque se usan
// enteras. Un campo que no existía al guardarse llega con su valor inicial.
export type CompareRows = Pick<
  SimState,
  "id" | "riskProfile" | "account" | "equity" | "fills" | "comparison"
> & {
  usage: Pick<State["usage"][number], "at" | "tokens" | "ok">[];
  decisions: DecisionLike[];
};
export async function readCompare(
  sims: readonly SimId[] = SIM_IDS,
): Promise<Record<SimId, CompareRows>> {
  const keys = sims.flatMap((x) => simKeys(x));
  const r = await pool.query(
    `SELECT key, jsonb_strip_nulls(CASE WHEN key LIKE '%:hot'
       THEN jsonb_build_object(
         'riskProfile', data->'riskProfile',
         'account', data->'account')
       ELSE jsonb_build_object(
         'equity', data->'equity',
         'fills', data->'fills',
         'comparison', data->'comparison',
         'usage', (SELECT coalesce(jsonb_agg(jsonb_build_object(
             'at', u->'at', 'tokens', u->'tokens', 'ok', u->'ok') ORDER BY n), '[]'::jsonb)
           FROM jsonb_array_elements(CASE jsonb_typeof(data->'usage')
             WHEN 'array' THEN data->'usage' ELSE '[]'::jsonb END)
             WITH ORDINALITY AS x(u, n)),
         'decisions', (SELECT coalesce(jsonb_agg(jsonb_build_object(
             'at', d->'at', 'status', d->'status', 'orderId', d->'orderId',
             'sentAt', d->'sentAt',
             'proposal', jsonb_build_object('action', d->'proposal'->'action'))
             ORDER BY n), '[]'::jsonb)
           FROM jsonb_array_elements(CASE jsonb_typeof(data->'decisions')
             WHEN 'array' THEN data->'decisions' ELSE '[]'::jsonb END)
             WITH ORDINALITY AS y(d, n)))
       END) AS data
     FROM meridian_rows WHERE key = ANY($1::text[])`,
    [keys],
  );
  const rows: Rows = new Map(r.rows.map((x) => [x.key as string, x.data]));
  return Object.fromEntries(
    sims.map((x) => {
      const sim = restoreSim(x, need(rows, simKeys(x)));
      return [
        x,
        {
          id: x,
          riskProfile: sim.riskProfile,
          account: sim.account,
          equity: sim.equity,
          fills: sim.fills,
          comparison: sim.comparison,
          usage: sim.usage,
          decisions: sim.decisions,
        },
      ];
    }),
  ) as unknown as Record<SimId, CompareRows>;
}

// Cambia lo compartido: precios, calendario, análisis, noticias.
export async function changeShared<T>(
  fn: (sh: SharedState) => T | Promise<T>,
): Promise<T> {
  return transaction(async (c) => {
    const sh = restoreShared(
      need(await select(c, SHARED_KEYS, "FOR UPDATE"), SHARED_KEYS),
    );
    const before = serialize(sharedRows(sh));
    const result = await fn(sh);
    pruneShared(sh);
    await writeChanged(c, before, serialize(sharedRows(sh)));
    return result;
  });
}
// Cambia una simulación a través de su vista. Lo compartido se bloquea en modo
// compartido y siempre antes que la simulación, así que ninguna transacción
// espera a otra en orden contrario. Un cambio de límites espera a que termine,
// y una evaluación que empezó antes lo ve como configuración modificada.
export async function changeSim<T>(
  sim: SimId,
  fn: (s: State) => T | Promise<T>,
): Promise<T> {
  return transaction(async (c) => {
    const sh = restoreShared(
      need(await select(c, SHARED_KEYS, "FOR SHARE"), SHARED_KEYS),
    );
    const own = restoreSim(
      sim,
      need(await select(c, simKeys(sim), "FOR UPDATE"), simKeys(sim)),
    );
    const view = composeState(sh, own);
    const before = decomposeState(view, sh.systemEvents);
    const huella = sharedFingerprint(before.shared);
    const beforeRows = serialize(simRows(before.sim));
    const result = await fn(view);
    pruneSim(view);
    const after = checkedSim(sim, view, huella);
    await writeChanged(c, beforeRows, serialize(simRows(after)));
    return result;
  });
}
function checkedSim(sim: SimId, view: State, huella: Map<string, string>) {
  const after = decomposeState(view);
  const tocados = sharedDifferences(huella, after.shared);
  if (view.sim !== sim) tocados.push("sim");
  if (tocados.length) throw new SharedStateTouched(tocados);
  return after.sim;
}
// Cambia lo compartido y todas las simulaciones a la vez. Lo compartido se cambia
// en sh; en cada vista solo lo de su simulación. Lo usan los límites, porque
// quitar un activo cancela vigilancias en todas.
export async function changeAll<T>(
  fn: (sh: SharedState, views: Record<SimId, State>) => T | Promise<T>,
): Promise<T> {
  return transaction(async (c) => {
    const keys = [...SHARED_KEYS, ...simAllKeys(SIM_IDS)].sort();
    const rows = await select(c, keys, "FOR UPDATE");
    const sh = restoreShared(need(rows, SHARED_KEYS));
    const views = {} as Record<SimId, State>;
    const huellas = new Map<SimId, Map<string, string>>();
    let beforeRows = serialize(sharedRows(sh));
    for (const x of SIM_IDS) {
      // Cada vista con su propia copia: cambiar sh no debe verse como que la
      // vista ha tocado lo compartido.
      views[x] = composeState(
        structuredClone(sh),
        restoreSim(x, need(rows, simKeys(x))),
      );
      const d = decomposeState(views[x]);
      huellas.set(x, sharedFingerprint(d.shared));
      beforeRows = new Map([...beforeRows, ...serialize(simRows(d.sim))]);
    }
    const result = await fn(sh, views);
    pruneShared(sh);
    let afterRows = serialize(sharedRows(sh));
    for (const x of SIM_IDS) {
      pruneSim(views[x]);
      const after = checkedSim(x, views[x], huellas.get(x)!);
      afterRows = new Map([...afterRows, ...serialize(simRows(after))]);
    }
    await writeChanged(c, beforeRows, afterRows);
    return result;
  });
}

// Esquema y migraciones. Idempotente: con todo ya migrado no cambia nada ni pide
// el bloqueo del worker, así que un despliegue normal no necesita pararlo. Crea
// las filas que falten en un solo paso: desde el formato antiguo, lo compartido,
// Alpaca y la interna; con meridian_rows ya separada y solo Alpaca, la interna.
export async function migrate(t = Date.now()) {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS meridian_state (id integer PRIMARY KEY, data jsonb NOT NULL)",
  );
  // The first release only allowed id=1; the history row needs that check gone.
  await pool.query(
    "ALTER TABLE meridian_state DROP CONSTRAINT IF EXISTS meridian_state_id_check",
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS meridian_rows (key text PRIMARY KEY, data jsonb NOT NULL)",
  );
  const every = [...SHARED_KEYS, ...simAllKeys(SIM_IDS)];
  const present = (
    await pool.query(
      "SELECT count(*)::int AS n FROM meridian_rows WHERE key = ANY($1::text[])",
      [every],
    )
  ).rows[0].n;
  if (present === every.length) return false;
  return withWorkerLock(() =>
    transaction(async (c) => {
      const rows = await select(c, every, "FOR UPDATE");
      if (rows.size === every.length) return false;
      if (!rows.size) await migrateLegacy(c, t);
      else {
        // Con meridian_rows ya separada solo puede faltar la interna entera. Que
        // falte otra fila, o media interna, es un fallo.
        const faltan = every.filter((k) => !rows.has(k));
        const interna: readonly string[] = simKeys("internal");
        if (
          faltan.length !== interna.length ||
          !faltan.every((k) => interna.includes(k))
        )
          throw new Error(
            `Migración incompleta: meridian_rows no tiene ${faltan.join(", ")}. Restaura la copia de seguridad o ejecuta migrate:down antes de volver a migrar.`,
          );
      }
      await addInternal(c, t);
      return true;
    }),
  );
}
async function withWorkerLock<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    const ok = (
      await c.query("SELECT pg_try_advisory_lock($1) AS ok", [WORKER_LOCK])
    ).rows[0].ok;
    // No se espera al bloqueo: al desplegar, Compose no para el worker viejo hasta
    // que la migración termina, y esperar lo dejaría colgado para siempre.
    if (!ok)
      throw new Error(
        "Hay un worker en marcha: detén api y worker antes de migrar",
      );
    try {
      return await fn();
    } finally {
      await c.query("SELECT pg_advisory_unlock($1)", [WORKER_LOCK]);
    }
  } finally {
    c.release();
  }
}
// Reparte meridian_state en las filas nuevas. Deja las filas antiguas en pausa y
// marcadas, como red de seguridad para volver atrás.
async function migrateLegacy(c: Client, t: number) {
  const stored = new Map<number, Record<string, unknown>>(
    (
      await c.query(
        "SELECT id, data FROM meridian_state ORDER BY id FOR UPDATE",
      )
    ).rows.map((r) => [r.id, r.data]),
  );
  if (stored.get(1)?.migratedTo)
    throw new Error(
      "meridian_state ya se migró, pero faltan sus filas en meridian_rows. Restaura la copia de seguridad: migrar otra vez desde ese estado perdería lo ocurrido después.",
    );
  // Instalación nueva: el estado inicial en dos filas. Primera versión: una sola
  // fila con todo. En los dos casos se deja en el formato de dos filas, que es el
  // que conoce la imagen anterior si hay que volver atrás.
  if (!stored.has(1) || !stored.has(2)) {
    const whole = restoreState([stored.get(1) ?? initialState()]);
    const parts = legacyRows(whole);
    for (const id of [1, 2] as const)
      await c.query(
        "INSERT INTO meridian_state(id,data) VALUES($1,$2) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data",
        [id, JSON.stringify(parts[id])],
      );
    stored.set(1, parts[1]);
    stored.set(2, parts[2]);
  }
  const legacy = restoreState([stored.get(1)!, stored.get(2)!]);
  const problema = legacyProblem(legacy);
  if (problema) throw new Error(`No se ha migrado nada. ${problema}`);
  let split: ReturnType<typeof splitLegacyState>;
  try {
    split = splitLegacyState(legacy, t);
  } catch (e) {
    throw new Error(
      `No se ha migrado nada: no se pudo separar el estado (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const rows = {
    ...sharedRows(split.shared),
    ...simRows(split.sim),
  };
  for (const [key, data] of Object.entries(rows))
    await c.query("INSERT INTO meridian_rows(key,data) VALUES($1,$2)", [
      key,
      JSON.stringify(data),
    ]);
  // Comprobación posterior, en la misma transacción: lo que se ha guardado, leído
  // como lo leerán la API y el worker, tiene que dar exactamente la vista
  // esperada. Y la vista, lo mismo que el estado de antes salvo lo que la
  // migración cambia a propósito.
  const leidas = await select(c, Object.keys(rows));
  const guardada = composeState(
    restoreShared(need(leidas, SHARED_KEYS)),
    restoreSim("alpaca", need(leidas, simKeys("alpaca"))),
  );
  const distintos = differentKeys(split.view, guardada);
  if (distintos.length)
    throw new Error(
      `No se ha migrado nada: lo guardado no coincide con el estado de antes en ${distintos.join(", ")}`,
    );
  // Lo nuevo no existía antes; la evaluación a medias, el nivel y sus eventos los
  // cambia la migración a propósito.
  const aProposito = new Set<string>([
    ...addedKeys,
    "modelJob",
    "events",
    "settings",
  ]);
  const cambiados = differentKeys(legacyComparable(legacy), split.view).filter(
    (k) => !aProposito.has(k),
  );
  const { riskProfile: _antes, ...limitesAntes } = legacy.settings;
  const { riskProfile: _despues, ...limitesDespues } = split.view.settings;
  if (!isDeepStrictEqual(plain(limitesAntes), plain(limitesDespues)))
    cambiados.push("settings");
  if (cambiados.length)
    throw new Error(
      `No se ha migrado nada: la separación cambió ${cambiados.join(", ")}`,
    );
  await c.query(
    "UPDATE meridian_state SET data = data || $1::jsonb WHERE id=1",
    [JSON.stringify({ paused: true, migratedTo: "meridian_rows" })],
  );
}
// Crea la simulación interna como copia de la de Alpaca (ver internalFromAlpaca)
// y pone en las dos el punto de partida de la comparación en el mismo instante.
// Va en la misma transacción que el resto de la migración.
async function addInternal(c: Client, t: number) {
  const keys = [...SHARED_KEYS, ...simKeys("alpaca")];
  const rows = await select(c, keys, "FOR UPDATE");
  const sh = restoreShared(need(rows, SHARED_KEYS));
  const alpaca = composeState(
    sh,
    restoreSim("alpaca", need(rows, simKeys("alpaca"))),
  );
  // Lo mismo que impide separar el formato antiguo impide copiar la cuenta: una
  // orden pendiente o incierta se ejecutaría también en la copia.
  const problema = legacyProblem(alpaca);
  if (problema) throw new Error(`No se ha migrado nada. ${problema}`);
  const antes = serialize(simRows(decomposeState(alpaca).sim));
  alpaca.comparison = comparisonAt(alpaca, t);
  let internal: State;
  try {
    internal = internalFromAlpaca(alpaca, t);
  } catch (e) {
    throw new Error(
      `No se ha migrado nada: no se pudo crear la simulación interna (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  await writeChanged(c, antes, serialize(simRows(decomposeState(alpaca).sim)));
  for (const [key, data] of Object.entries(
    simRows(decomposeState(internal).sim),
  ))
    await c.query("INSERT INTO meridian_rows(key,data) VALUES($1,$2)", [
      key,
      JSON.stringify(data),
    ]);
  // Comprobación posterior: las dos se leen tal como se han preparado.
  const leidas = await select(c, [
    ...SHARED_KEYS,
    ...simKeys("alpaca"),
    ...simKeys("internal"),
  ]);
  const shLeido = restoreShared(need(leidas, SHARED_KEYS));
  for (const [id, esperada] of [
    ["alpaca", alpaca],
    ["internal", internal],
  ] as const) {
    const guardada = composeState(
      shLeido,
      restoreSim(id, need(leidas, simKeys(id))),
    );
    const distintos = differentKeys(esperada, guardada);
    if (distintos.length)
      throw new Error(
        `No se ha migrado nada: lo guardado de ${id} no coincide con lo preparado en ${distintos.join(", ")}`,
      );
  }
}
// Igual que tras pasar por JSON, que es como lo guarda PostgreSQL.
const plain = (x: unknown) =>
  x === undefined ? undefined : JSON.parse(JSON.stringify(x));
function differentKeys(a: State, b: State) {
  return (Object.keys(initialState()) as (keyof State)[]).filter(
    (k) => !isDeepStrictEqual(plain(a[k]), plain(b[k])),
  );
}
function legacyComparable(legacy: State): State {
  return {
    ...legacy,
    stories: legacy.stories.map((n) => ({
      ...n,
      commented: Boolean(n.commented),
    })),
  };
}

// Vuelta atrás: devuelve a meridian_state la simulación de Alpaca con lo
// compartido, en pausa, y aparta meridian_rows con la fecha en el nombre. La
// imagen anterior lee ese estado y conserva lo ocurrido desde la migración. La
// interna no existía antes: no vuelve, pero queda entera en la tabla apartada.
// Pide el bloqueo del worker igual que migrar.
export async function migrateDown(t = Date.now()) {
  return withWorkerLock(() =>
    transaction(async (c) => {
      const exists = (await c.query("SELECT to_regclass('meridian_rows') AS t"))
        .rows[0].t;
      if (!exists) throw new Error("No hay meridian_rows: nada que deshacer");
      const keys = [...SHARED_KEYS, ...simKeys("alpaca")];
      const rows = await select(c, keys, "FOR UPDATE");
      const sh = restoreShared(need(rows, SHARED_KEYS));
      const s = composeState(
        sh,
        restoreSim("alpaca", need(rows, simKeys("alpaca"))),
      );
      // Los eventos compartidos vuelven a la lista única de antes.
      s.events = [...s.events, ...sh.systemEvents]
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, 1000);
      s.paused = true;
      log(
        s,
        "control",
        "Vuelta atrás desde las simulaciones separadas. Agente pausado.",
      );
      const parts = legacyRows(s);
      for (const id of [1, 2] as const)
        await c.query(
          "INSERT INTO meridian_state(id,data) VALUES($1,$2) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data",
          [id, JSON.stringify(parts[id])],
        );
      const stamp = new Date(t)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace("T", "_")
        .slice(0, 15);
      const name = `meridian_rows_${stamp}`;
      await c.query(`ALTER TABLE meridian_rows RENAME TO ${name}`);
      return name;
    }),
  );
}
