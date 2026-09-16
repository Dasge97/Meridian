import { test, after } from "node:test";
import assert from "node:assert/strict";
import { productionLikeState } from "./synthetic-state.ts";
const url = process.env.TEST_DATABASE_URL;
const skip = !url;
if (url) {
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error("Use an isolated database ending in _test");
  process.env.DATABASE_URL = url;
  process.env.MERIDIAN_TEST = "true";
  process.env.ADMIN_PASSWORD = "test-password-only-987654321";
  process.env.SESSION_SECRET = "test-session-secret-only-987654321-123456";
  process.env.APP_ORIGIN = "http://localhost:3000";
}
const db = url ? await import("../src/db.ts") : null!;
const domain = await import("../src/domain.ts");
const simState = await import("../src/sim-state.ts");
const agent = await import("../src/agent.ts");
const paper = await import("../src/paper.ts");
const compare = await import("../src/compare.ts");
after(async () => {
  if (url) await db.pool.end();
});

const q = (sql: string, params?: unknown[]) => db.pool.query(sql, params);
// Borra todo lo del laboratorio, incluidas las tablas apartadas por migrate:down.
async function reset() {
  const apartadas = (
    await q(
      "SELECT tablename FROM pg_tables WHERE tablename LIKE 'meridian_rows_%'",
    )
  ).rows;
  for (const t of apartadas) await q(`DROP TABLE ${t.tablename}`);
  await q("DROP TABLE IF EXISTS meridian_rows");
  await q("DROP TABLE IF EXISTS meridian_state");
}
async function legacyTwoRows(s: ReturnType<typeof productionLikeState>) {
  await q(
    "CREATE TABLE meridian_state (id integer PRIMARY KEY, data jsonb NOT NULL)",
  );
  const rows = simState.legacyRows(s);
  for (const id of [1, 2] as const)
    await q("INSERT INTO meridian_state(id,data) VALUES($1,$2)", [
      id,
      JSON.stringify(rows[id]),
    ]);
}
const rowsXmin = async (table = "meridian_rows", key = "key") =>
  Object.fromEntries(
    (
      await q(`SELECT ${key}::text AS k, xmin::text FROM ${table} ORDER BY 1`)
    ).rows.map((r) => [r.k, r.xmin]),
  );
const changeAlpaca = (fn: (s: import("../src/domain.ts").State) => void) =>
  db.changeSim("alpaca", fn);
const legacyRead = async () => {
  const rows = (await q("SELECT id, data FROM meridian_state ORDER BY id"))
    .rows;
  return { rows, state: domain.restoreState(rows.map((r) => r.data)) };
};

test(
  "Migration from the single row of the first release",
  { skip },
  async () => {
    await reset();
    await q(
      "CREATE TABLE meridian_state (id integer PRIMARY KEY CHECK (id=1), data jsonb NOT NULL)",
    );
    const antiguo = productionLikeState();
    await q("INSERT INTO meridian_state(id,data) VALUES(1,$1)", [
      JSON.stringify(antiguo),
    ]);
    assert.equal(await db.migrate(), true);
    const keys = (await q("SELECT key FROM meridian_rows ORDER BY key")).rows;
    assert.deepEqual(
      keys.map((r) => r.key),
      [
        "shared:cold",
        "shared:hot",
        "sim:alpaca:cold",
        "sim:alpaca:hot",
        "sim:internal:cold",
        "sim:internal:hot",
      ],
    );
    const s = await db.readSim("alpaca");
    assert.equal(s.decisions.length, 54);
    assert.deepEqual(
      s.decisions,
      JSON.parse(JSON.stringify(antiguo.decisions)),
    );
    const { rows, state } = await legacyRead();
    assert.equal(rows.length, 2, "queda también en el formato de dos filas");
    assert.equal(
      rows[0].data.paused,
      true,
      "las filas antiguas quedan en pausa",
    );
    assert.equal(rows[0].data.migratedTo, "meridian_rows");
    assert.equal(state.decisions.length, 54);
  },
);

test(
  "Migration of a production-like state keeps every count, runs once and can be undone",
  { skip },
  async () => {
    await reset();
    const antiguo = productionLikeState();
    await legacyTwoRows(antiguo);
    const tamaños = (
      await q(
        "SELECT id, pg_column_size(data) AS size, octet_length(data::text) AS text FROM meridian_state ORDER BY id",
      )
    ).rows;
    assert.ok(
      tamaños[1].text > 1_500_000,
      `el historial pesa como en producción (${tamaños[1].text} bytes)`,
    );
    const inicio = Date.now();
    assert.equal(await db.migrate(), true);
    const tardó = Date.now() - inicio;
    assert.ok(tardó < 20000, `la migración tarda ${tardó} ms`);
    const xmin = await rowsXmin();
    const xminAntiguo = await rowsXmin("meridian_state", "id");
    // Segunda ejecución: no cambia nada, ni siquiera reescribe.
    assert.equal(await db.migrate(), false);
    assert.deepEqual(await rowsXmin(), xmin);
    assert.deepEqual(await rowsXmin("meridian_state", "id"), xminAntiguo);

    const filas = new Map(
      (await q("SELECT key, data FROM meridian_rows")).rows.map((r) => [
        r.key,
        r.data,
      ]),
    );
    const hot = filas.get("sim:alpaca:hot"),
      cold = filas.get("sim:alpaca:cold"),
      sharedHot = filas.get("shared:hot"),
      sharedCold = filas.get("shared:cold");
    // Recuentos por clave frente al estado antiguo.
    assert.equal(cold.decisions.length, antiguo.decisions.length);
    assert.equal(
      cold.decisions.filter((d: any) => d.input !== null).length,
      antiguo.decisions.length,
      "las decisiones conservan su contexto",
    );
    assert.equal(cold.events.length, antiguo.events.length);
    assert.equal(cold.equity.length, antiguo.equity.length);
    assert.equal(cold.usage.length, antiguo.usage.length);
    assert.equal(cold.lessons.length, antiguo.lessons.length);
    assert.equal(cold.versions.length, antiguo.versions.length);
    assert.equal(
      cold.fills.length,
      antiguo.orders.filter((o) => Number(o.filled_qty) > 0).length,
    );
    assert.equal(cold.comparison.equity, 101987.65);
    assert.equal(
      hot.watches.filter((w: any) => w.status === "active").length,
      antiguo.watches.filter((w) => w.status === "active").length,
    );
    assert.equal(hot.watches.length, antiguo.watches.length);
    assert.equal(hot.positions.length, antiguo.positions.length);
    assert.equal(hot.orders.length, antiguo.orders.length);
    assert.equal(hot.queue.length, antiguo.queue.length);
    assert.equal(hot.riskProfile, "balanced");
    assert.equal(hot.paused, false, "Alpaca sigue como estaba");
    assert.equal(
      hot.commentedStories.length,
      antiguo.stories.filter((n) => n.commented).length,
    );
    assert.equal(sharedCold.stories.length, antiguo.stories.length);
    assert.equal(Object.keys(sharedCold.analysis).length, 20);
    assert.equal(Object.keys(sharedCold.intraday).length, 20);
    assert.deepEqual(sharedHot.settings.symbols, antiguo.settings.symbols);
    assert.equal("riskProfile" in sharedHot.settings, false);
    assert.equal(
      Object.keys(sharedHot.quotes).length,
      Object.keys(antiguo.quotes).length,
    );
    // Lo que se reescribe cada 2 segundos es pequeño.
    const tamañoFilas = Object.fromEntries(
      (
        await q(
          "SELECT key, octet_length(data::text) AS n FROM meridian_rows ORDER BY key",
        )
      ).rows.map((r) => [r.key, Number(r.n)]),
    );
    assert.ok(tamañoFilas["shared:hot"] < 10000, JSON.stringify(tamañoFilas));
    assert.ok(tamañoFilas["sim:alpaca:hot"] < 100000);

    // La vista compuesta es el estado de antes, campo a campo.
    const vista = await db.readSim("alpaca");
    const plano = JSON.parse(JSON.stringify(antiguo));
    for (const k of [
      ...simState.legacyHotKeys,
      ...simState.legacyColdKeys,
    ].filter((k) => k !== "stories"))
      assert.deepEqual(vista[k], plano[k], k);

    // Vuelta atrás.
    const apartada = await db.migrateDown(Date.parse("2026-09-16T18:00:00Z"));
    assert.equal(apartada, "meridian_rows_20260916_180000");
    const { state } = await legacyRead();
    assert.equal(state.paused, true, "vuelve en pausa");
    assert.equal(state.decisions.length, antiguo.decisions.length);
    assert.equal(state.events.length, antiguo.events.length + 1);
    assert.match(state.events[0].message, /Vuelta atrás/);
    assert.equal(state.settings.riskProfile, "balanced");
    assert.equal((state as any).migratedTo, undefined);
    assert.equal(
      state.stories.filter((n) => n.commented).length,
      antiguo.stories.filter((n) => n.commented).length,
    );
    assert.equal(
      (await q("SELECT to_regclass('meridian_rows') AS t")).rows[0].t,
      null,
    );
    // Y se puede volver a migrar desde ahí.
    assert.equal(await db.migrate(), true);
    assert.equal((await db.readSim("alpaca")).paused, true);
  },
);

test(
  "Migration aborts with a concrete reason and changes nothing",
  { skip },
  async () => {
    const intento = async (
      preparar: (s: ReturnType<typeof productionLikeState>) => void,
      motivo: RegExp,
      despues?: () => Promise<void>,
    ) => {
      await reset();
      const s = productionLikeState();
      preparar(s);
      await legacyTwoRows(s);
      await despues?.();
      const antes = (await q("SELECT id, data FROM meridian_state ORDER BY id"))
        .rows;
      await assert.rejects(db.migrate(), motivo);
      assert.equal(
        (await q("SELECT count(*)::int AS n FROM meridian_rows")).rows[0].n,
        0,
        "no se ha escrito ninguna fila nueva",
      );
      assert.deepEqual(
        (await q("SELECT id, data FROM meridian_state ORDER BY id")).rows,
        antes,
        "el estado antiguo sigue igual",
      );
    };
    await intento((s) => {
      s.decisions[10].status = "pending";
    }, /reconcilia o espera antes de migrar/);
    await intento((s) => {
      s.positions[1].qty = "-3";
    }, /posición corta en Alpaca \(MSFT/);
    // Un worker en marcha tiene el bloqueo.
    const worker = await db.pool.connect();
    try {
      await worker.query("SELECT pg_advisory_lock($1)", [db.WORKER_LOCK]);
      await intento(() => {}, /Hay un worker en marcha: detén api y worker/);
      await assert.rejects(db.migrateDown(), /Hay un worker en marcha/);
    } finally {
      await worker.query("SELECT pg_advisory_unlock($1)", [db.WORKER_LOCK]);
      worker.release();
    }
    // Filas antiguas ya migradas pero sin sus filas nuevas: no se migra otra vez.
    await intento(
      () => {},
      /ya se migró/,
      async () => {
        await q(
          `UPDATE meridian_state SET data = data || '{"migratedTo": "meridian_rows"}' WHERE id=1`,
        );
      },
    );
    // Una migración a medias.
    await reset();
    await legacyTwoRows(productionLikeState());
    await db.migrate();
    await q("DELETE FROM meridian_rows WHERE key='sim:alpaca:hot'");
    await assert.rejects(
      db.migrate(),
      /Migración incompleta: .*sim:alpaca:hot/,
    );
    await assert.rejects(db.readSim("alpaca"), /Estado incompleto/);
    // Con el estado bien, el bloqueo de un worker no impide un despliegue normal.
    await reset();
    await legacyTwoRows(productionLikeState());
    await db.migrate();
    const otro = await db.pool.connect();
    try {
      await otro.query("SELECT pg_advisory_lock($1)", [db.WORKER_LOCK]);
      assert.equal(await db.migrate(), false);
    } finally {
      await otro.query("SELECT pg_advisory_unlock($1)", [db.WORKER_LOCK]);
      otro.release();
    }
  },
);

test(
  "Migration creates the internal simulation as a copy of Alpaca, in one step or on top of Alpaca alone",
  { skip },
  async () => {
    // Desde el formato antiguo, en un solo paso: lo que pasará en producción.
    await reset();
    const antiguo = productionLikeState();
    await legacyTwoRows(antiguo);
    const T = Date.parse("2026-09-16T18:30:00Z");
    assert.equal(await db.migrate(T), true);
    const xmin = await rowsXmin();
    assert.deepEqual(Object.keys(xmin), [
      "shared:cold",
      "shared:hot",
      "sim:alpaca:cold",
      "sim:alpaca:hot",
      "sim:internal:cold",
      "sim:internal:hot",
    ]);
    assert.equal(await db.migrate(), false, "la segunda vez no hace nada");
    assert.deepEqual(await rowsXmin(), xmin, "ni reescribe ninguna fila");

    const alpaca = await db.readSim("alpaca");
    const interna = await db.readSim("internal");
    const filas = new Map(
      (await q("SELECT key, data FROM meridian_rows")).rows.map((r) => [
        r.key,
        r.data,
      ]),
    );
    const hot = filas.get("sim:internal:hot"),
      cold = filas.get("sim:internal:cold");
    // Lo que no se copia.
    assert.equal(cold.usage.length, 0, "sin consumo");
    assert.equal(hot.orders.length, 0, "sin órdenes");
    assert.equal(cold.fills.length, 0);
    assert.equal(hot.queue.length, 0);
    assert.equal(hot.modelJob, null);
    assert.equal(hot.calls.count, 0);
    assert.equal(hot.unresolved, 0);
    // Niveles y pausa.
    assert.equal(hot.riskProfile, "aggressive");
    assert.equal(filas.get("sim:alpaca:hot").riskProfile, "balanced");
    assert.equal(interna.paused, alpaca.paused);
    assert.equal(interna.paused, false, "no nace pausada si Alpaca no lo está");
    // La copia.
    assert.equal(interna.account.cash, Number(alpaca.account.cash));
    assert.equal(interna.baseline, alpaca.baseline);
    assert.deepEqual(
      interna.positions.map((x) => [x.symbol, x.qty, x.avg_entry_price]),
      alpaca.positions.map((x) => [
        x.symbol,
        Number(x.qty),
        Number(x.avg_entry_price),
      ]),
    );
    assert.equal(cold.decisions.length, antiguo.decisions.length);
    assert.equal(
      cold.decisions.filter((d: any) => d.input !== null).length,
      antiguo.decisions.length,
      "con sus contextos",
    );
    // Las operaciones heredadas sin revisar las revisa solo Alpaca.
    const heredada = antiguo.decisions[45];
    assert.ok(heredada.orderId && !heredada.review && !heredada.reviewSkipped);
    assert.equal(
      interna.decisions[45].reviewSkipped,
      simState.INHERITED_REVIEW_SKIPPED,
    );
    assert.equal(alpaca.decisions[45].reviewSkipped, undefined);
    assert.deepEqual(interna.lessons, alpaca.lessons);
    assert.deepEqual(interna.versions, alpaca.versions);
    assert.equal(interna.activeVersion, alpaca.activeVersion);
    assert.deepEqual(interna.equity, alpaca.equity);
    assert.equal(interna.events.length, alpaca.events.length + 1);
    assert.deepEqual(
      hot.commentedStories,
      alpaca.stories.filter((n) => n.commented).map((n) => n.id),
    );
    const activas = alpaca.watches.filter((w) => w.status === "active");
    assert.equal(interna.watches.length, activas.length);
    assert.ok(
      interna.watches.every((w) => !activas.some((a) => a.id === w.id)),
      "vigilancias con ids nuevos",
    );
    assert.equal(interna.comparison!.startedAt, new Date(T).toISOString());
    assert.equal(alpaca.comparison!.startedAt, interna.comparison!.startedAt);
    // Alpaca sigue siendo el estado de antes.
    const plano = JSON.parse(JSON.stringify(antiguo));
    for (const k of [
      ...simState.legacyHotKeys,
      ...simState.legacyColdKeys,
    ].filter((k) => k !== "stories"))
      assert.deepEqual(alpaca[k], plano[k], k);

    // Si Alpaca estaba en pausa, la interna nace en pausa.
    await reset();
    const pausado = productionLikeState();
    pausado.paused = true;
    await legacyTwoRows(pausado);
    await db.migrate(T);
    assert.equal((await db.readSim("internal")).paused, true);

    // Con meridian_rows ya poblada solo con Alpaca: añade la interna y pone la
    // comparación de las dos en el mismo instante.
    await q("DELETE FROM meridian_rows WHERE key LIKE 'sim:internal:%'");
    await changeAlpaca((s) => {
      s.paused = false;
      s.usage.push({ at: new Date().toISOString(), tokens: 10 });
    });
    const antesAlpaca = await rowsXmin();
    // Pide el bloqueo del worker para crear filas.
    const worker = await db.pool.connect();
    try {
      await worker.query("SELECT pg_advisory_lock($1)", [db.WORKER_LOCK]);
      await assert.rejects(db.migrate(), /Hay un worker en marcha/);
    } finally {
      await worker.query("SELECT pg_advisory_unlock($1)", [db.WORKER_LOCK]);
      worker.release();
    }
    assert.deepEqual(
      await rowsXmin(),
      antesAlpaca,
      "sin el bloqueo no cambia nada",
    );
    const T2 = Date.parse("2026-09-17T13:00:00Z");
    assert.equal(await db.migrate(T2), true);
    const alpaca2 = await db.readSim("alpaca");
    const interna2 = await db.readSim("internal");
    assert.equal(interna2.paused, false, "la misma pausa que Alpaca ahora");
    assert.equal(interna2.usage.length, 0);
    assert.equal(alpaca2.usage.length, antiguo.usage.length + 1);
    assert.equal(alpaca2.comparison!.startedAt, new Date(T2).toISOString());
    assert.equal(interna2.comparison!.startedAt, alpaca2.comparison!.startedAt);
    assert.equal(await db.migrate(), false);

    // Media interna es una migración a medias.
    await q("DELETE FROM meridian_rows WHERE key = 'sim:internal:cold'");
    await assert.rejects(
      db.migrate(),
      /Migración incompleta: .*sim:internal:cold/,
    );
    // Una orden pendiente en Alpaca se copiaría: no se crea nada.
    await q("DELETE FROM meridian_rows WHERE key LIKE 'sim:internal:%'");
    await changeAlpaca((s) => {
      s.decisions[5].status = "pending";
    });
    await assert.rejects(db.migrate(), /reconcilia o espera antes de migrar/);
    assert.equal(
      (
        await q(
          "SELECT count(*)::int AS n FROM meridian_rows WHERE key LIKE 'sim:internal:%'",
        )
      ).rows[0].n,
      0,
    );
    await changeAlpaca((s) => {
      s.decisions[5].status = "observed";
    });
    assert.equal(await db.migrate(), true);

    // La vuelta atrás conserva Alpaca y aparta todo lo demás, también la interna.
    const apartada = await db.migrateDown(Date.parse("2026-09-17T18:00:00Z"));
    const { state } = await legacyRead();
    assert.equal(state.paused, true);
    assert.equal(state.decisions.length, antiguo.decisions.length);
    assert.equal(state.settings.riskProfile, "balanced");
    assert.equal(
      (
        await q(
          `SELECT count(*)::int AS n FROM ${apartada} WHERE key LIKE 'sim:internal:%'`,
        )
      ).rows[0].n,
      2,
    );
  },
);

test(
  "Two simulations: concurrent transactions, independent pause and an internal order that never touches Alpaca",
  { skip },
  async () => {
    const { changeSim, changeShared, changeAll, readSim, readShared } = db;
    const { enqueue, proposalSchema } = domain;
    const { simWorker } = await import("../src/sim-worker.ts");
    await reset();
    await db.migrate();
    // Veinte transacciones de cada simulación a la vez, con lo compartido y los
    // límites de por medio: sin interbloqueos ni escrituras perdidas.
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) =>
        changeSim("internal", (s) => enqueue(s, `Interna ${i}`, "other")),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        changeSim("alpaca", (s) => enqueue(s, `Alpaca ${i}`, "other")),
      ),
      ...Array.from({ length: 5 }, () =>
        changeShared((sh) => {
          sh.heartbeat = new Date().toISOString();
        }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        changeAll((sh) => domain.logShared(sh, "config", `Todas ${i}`)),
      ),
    ]);
    assert.equal((await readSim("internal")).queue.length, 20);
    assert.equal((await readSim("alpaca")).queue.length, 20);
    assert.ok(
      (await readSim("internal")).queue.every((e) =>
        e.reason.startsWith("Interna"),
      ),
    );

    // Alpaca y red trampeadas: cualquier llamada a Alpaca falla y se cuenta.
    let llamadasAlpaca = 0,
      llamadasRed = 0;
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async () => {
      llamadasRed++;
      throw new Error("La prueba no permite salir a la red");
    }) as typeof fetch;
    process.env.ALPACA_KEY_ID = "clave-de-prueba";
    process.env.ALPACA_SECRET_KEY = "secreto-de-prueba";
    const { app } = await import("../src/server.ts");
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { origin: process.env.APP_ORIGIN },
        payload: { password: process.env.ADMIN_PASSWORD },
      });
      const cookie = login.cookies[0];
      const headers = {
        origin: process.env.APP_ORIGIN!,
        cookie: `${cookie.name}=${cookie.value}`,
      };
      await changeSim("alpaca", (s) => {
        s.paused = false;
        s.queue = [];
      });
      await changeSim("internal", (s) => {
        s.paused = false;
        s.queue = [];
      });
      // Pausar la interna no cambia Alpaca.
      const xminAlpaca = (await rowsXmin())["sim:alpaca:hot"];
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/sims/internal/pause",
            headers,
            payload: { paused: true },
          })
        ).statusCode,
        200,
      );
      assert.equal((await readSim("internal")).paused, true);
      assert.equal((await readSim("alpaca")).paused, false);
      assert.equal((await rowsXmin())["sim:alpaca:hot"], xminAlpaca);
      await changeSim("internal", (s) => {
        s.paused = false;
      });

      // El selector ve las dos en la misma respuesta.
      await changeSim("alpaca", (s) => {
        s.decisions.push({
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          versionId: s.activeVersion,
          event: "prueba",
          input: null,
          proposal: proposalSchema.parse({
            action: "buy",
            symbol: "SPY",
            qty: 1,
            limitPrice: 500,
            reason: "Motivo de prueba",
            hypothesis: "Hipótesis",
            reviewAfterHours: 24,
            notify: false,
            note: "Nota de prueba para el panel",
            watches: [],
            lessons: [],
          }),
          status: "unknown",
          reviewAt: new Date().toISOString(),
        });
      });
      const panel = (
        await app.inject({
          method: "GET",
          url: "/api/sims/internal/state",
          headers,
        })
      ).json();
      assert.equal(panel.sim, "internal");
      assert.equal(panel.broker, "internal");
      assert.deepEqual(
        panel.sims.map((x: any) => [
          x.id,
          x.label,
          x.broker,
          x.riskProfile,
          x.paused,
          x.evaluating,
          x.unresolved,
        ]),
        [
          ["alpaca", "Alpaca Paper", "alpaca", "balanced", false, false, 1],
          ["internal", "Interna", "internal", "aggressive", false, false, 0],
        ],
      );
      assert.equal(panel.sims[1].equity, 100000);
      assert.equal(panel.sims[1].baseline, 100000);
      assert.equal(panel.sims[0].equity, null, "Alpaca aún no ha sincronizado");
      await changeSim("alpaca", (s) => {
        s.decisions = s.decisions.filter((d) => d.status !== "unknown");
      });

      // Una orden completa en la interna con el worker de verdad contra
      // PostgreSQL, y Alpaca, el modelo y Telegram sustituidos.
      let reloj = Date.parse("2026-09-16T15:00:00Z"); // 11:00 en Nueva York
      const enviados: string[] = [];
      let respuesta: "buy" | "wait" = "buy";
      const falla = async () => {
        llamadasAlpaca++;
        throw new Error("La simulación interna no debe llamar a Alpaca");
      };
      const w = simWorker({
        alpaca: falla as any,
        accountSnapshot: falla as any,
        configured: () => true,
        modelConfigured: () => true,
        telegramConfigured: () => true,
        sendTelegram: async (text) => {
          enviados.push(text);
        },
        decide: async () => ({
          input: {},
          proposal: proposalSchema.parse({
            action: respuesta,
            symbol: respuesta === "buy" ? "AAPL" : null,
            qty: respuesta === "buy" ? 10 : null,
            limitPrice: respuesta === "buy" ? 199 : null,
            reason: "Soporte con volumen",
            hypothesis: "Rebote a 205",
            reviewAfterHours: 1,
            notify: false,
            note: "Compro 10 AAPL en el soporte",
            watches: [],
            lessons: [],
          }),
          tokens: 1000,
          spent: { tokens: 1000 },
        }),
        review: async () => ({
          parsed: { text: "Buena entrada en el soporte", lessons: [] },
          spent: { tokens: 400 },
        }),
        newsSims: ["alpaca", "internal"],
        now: () => reloj,
      });
      const iso = (t: number) => new Date(t).toISOString();
      await changeShared((sh) => {
        sh.settings = {
          ...sh.settings,
          symbols: ["AAPL", "SPY"],
          maxOrderUsd: 5000,
          maxPositionUsd: 15000,
          maxExposureUsd: 40000,
          maxDailyCalls: 20,
          cooldownSeconds: 60,
        };
        sh.market = {
          open: true,
          nextOpen: null,
          nextClose: iso(reloj + 5 * 3600000),
        };
        sh.feeds = { trades: true, clock: true };
        sh.quotes = { AAPL: { price: 200, at: iso(reloj - 1000) } };
      });
      // Valora la cuenta y encola la revisión periódica.
      await w.brokerStep("internal");
      let interna = await readSim("internal");
      assert.equal(interna.lastSync, iso(reloj));
      assert.equal(interna.queue[0]?.trigger, "periodic");
      // El modelo decide comprar por debajo del precio.
      assert.equal(await w.modelStep("internal"), true);
      interna = await readSim("internal");
      const d = interna.decisions.at(-1)!;
      assert.equal(d.status, "pending", d.error);
      // claimIntent y acceptInternalOrder en la misma transacción.
      reloj += 2000;
      await w.brokerStep("internal");
      interna = await readSim("internal");
      assert.equal(interna.decisions.at(-1)!.status, "new");
      assert.equal(interna.orders[0].client_order_id, d.id);
      assert.equal(interna.orders[0].status, "new");
      // Llega un precio que cruza: el bucle de vigilancias ejecuta la orden.
      reloj += 60000;
      await changeShared((sh) => {
        sh.quotes.AAPL = { price: 198.7, at: iso(reloj - 500) };
      });
      await w.watchesStep("internal");
      interna = await readSim("internal");
      assert.equal(interna.decisions.at(-1)!.status, "filled");
      assert.deepEqual(
        [interna.fills[0].price, interna.fills[0].rule, interna.fills[0].qty],
        [199, "resting", 10],
      );
      assert.equal(interna.account.cash, 100000 - 1990);
      assert.match(interna.queue[0].reason, /^Orden ejecutada: /);
      const aviso = enviados.find((t) => t.includes("Orden ejecutada"));
      assert.ok(aviso, "llega el aviso de la orden ejecutada");
      assert.ok(aviso!.startsWith("<b>[Interna · Agresivo]</b>\n"), aviso);
      // La orden ejecutada despierta al agente, que ahora espera.
      respuesta = "wait";
      reloj += 61000;
      assert.equal(await w.modelStep("internal"), true);
      interna = await readSim("internal");
      assert.match(interna.decisions.at(-1)!.event, /Orden ejecutada/);
      // Pasado su plazo, la compra se revisa.
      reloj += 3600000;
      assert.equal(await w.modelStep("internal"), true);
      interna = await readSim("internal");
      assert.equal(
        interna.decisions.find((x) => x.id === d.id)!.review?.text,
        "Buena entrada en el soporte",
      );
      assert.equal(interna.usage.length, 3);
      // Mientras tanto Alpaca no se ha tocado.
      assert.equal(llamadasAlpaca, 0, "la interna nunca llama a Alpaca");
      assert.equal(llamadasRed, 0);
      assert.equal((await readSim("alpaca")).orders.length, 0);
      assert.equal((await readSim("alpaca")).fills.length, 0);

      // Con MODEL_CONCURRENCY=1 va primero lo más urgente.
      await changeSim("alpaca", (s) => {
        s.queue = [];
        enqueue(s, "Revisión periódica del mercado", "periodic");
      });
      await changeSim("internal", (s) => {
        s.queue = [];
        enqueue(s, "Vigilancia cumplida", "watch");
      });
      reloj += 120000;
      assert.equal(await w.scheduledModelStep(), "internal");

      // Una orden abierta en la interna se cancela sin llamar a Alpaca.
      reloj += 120000;
      await changeShared((sh) => {
        sh.quotes.AAPL = { price: 198.7, at: iso(reloj - 500) };
      });
      await changeSim("internal", (s) => {
        s.queue = [];
        s.lastSync = iso(reloj);
        const abierta = s.decisions.at(-1)!;
        abierta.proposal = proposalSchema.parse({
          ...abierta.proposal,
          action: "buy",
          symbol: "AAPL",
          qty: 5,
          limitPrice: 195,
        });
        abierta.status = "submitting";
        paper.acceptInternalOrder(s, abierta, reloj);
      });
      assert.equal((await readSim("internal")).orders[0].status, "new");
      const alpacaAntes = (await rowsXmin())["sim:alpaca:hot"];
      const cancelar = await app.inject({
        method: "POST",
        url: "/api/sims/internal/orders/cancel-open",
        headers,
      });
      assert.equal(cancelar.statusCode, 200, cancelar.body);
      assert.equal(cancelar.json().canceled, 1);
      interna = await readSim("internal");
      assert.equal(interna.paused, true);
      assert.equal(interna.orders[0].status, "canceled");
      assert.equal(interna.decisions.at(-1)!.status, "canceled");
      assert.equal((await readSim("alpaca")).paused, false);
      assert.equal((await rowsXmin())["sim:alpaca:hot"], alpacaAntes);
      // Reconciliar no aplica a la interna.
      const reconciliar = await app.inject({
        method: "POST",
        url: `/api/sims/internal/orders/${interna.decisions.at(-1)!.id}/reconcile`,
        headers,
      });
      assert.equal(reconciliar.statusCode, 400);
      assert.match(reconciliar.json().error, /No aplica a Interna/);
      assert.equal(
        llamadasRed,
        0,
        "cancelar y reconciliar la interna no salen a la red",
      );
      assert.equal((await readShared()).settings.symbols.length, 2);
    } finally {
      globalThis.fetch = fetchOriginal;
      delete process.env.ALPACA_KEY_ID;
      delete process.env.ALPACA_SECRET_KEY;
      // La cierra la prueba de la API, que va después.
    }
  },
);

test(
  "PostgreSQL + API: auth, CSRF, persistence, versions and concurrent updates",
  { skip },
  async () => {
    const { changeSim, changeShared, changeAll, readSim, readShared, readHot } =
      db;
    const { initialState, enqueue, logShared } = domain;
    await reset();
    // Una instalación nueva: la migración crea el estado inicial.
    await db.migrate();
    assert.deepEqual(
      (await q("SELECT id FROM meridian_state ORDER BY id")).rows.map(
        (r) => r.id,
      ),
      [1, 2],
    );
    void initialState;
    const { app } = await import("../src/server.ts");
    try {
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/sims/alpaca/state" }))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/login",
            payload: { password: process.env.ADMIN_PASSWORD },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/login",
            headers: { origin: process.env.APP_ORIGIN },
            payload: { password: "bad" },
          })
        ).statusCode,
        401,
      );
      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { origin: process.env.APP_ORIGIN },
        payload: { password: process.env.ADMIN_PASSWORD },
      });
      assert.equal(login.statusCode, 200);
      const cookie = login.cookies[0];
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.sameSite, "Strict");
      const headers = {
        origin: process.env.APP_ORIGIN!,
        cookie: `${cookie.name}=${cookie.value}`,
      };
      const sim = (path: string) => "/api/sims/alpaca" + path;
      const estado = await app.inject({
        method: "GET",
        url: sim("/state"),
        headers,
      });
      assert.equal(estado.statusCode, 200);
      assert.equal(estado.json().sim, "alpaca");
      assert.equal(estado.json().broker, "alpaca");
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: "/api/sims/otra/state",
            headers,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/state", headers }))
          .statusCode,
        410,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: sim("/wake"),
            headers: { ...headers, origin: "https://attacker.example" },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: "/api/settings",
            headers,
            payload: { maxOrderUsd: -1 },
          })
        ).statusCode,
        400,
      );
      // Los límites son compartidos y el nivel de riesgo es de la simulación: si
      // llega con los límites se ignora.
      const { riskProfile: _nivel, ...limites } = (await readSim("alpaca"))
        .settings;
      void _nivel;
      const guardar = async (payload: Record<string, unknown>) =>
        (
          await app.inject({
            method: "PUT",
            url: "/api/settings",
            headers,
            payload,
          })
        ).statusCode;
      assert.equal(
        await guardar({ ...limites, riskProfile: "temerario" }),
        200,
      );
      assert.equal(
        await guardar({ ...limites, riskProfile: "aggressive" }),
        200,
      );
      assert.equal((await readSim("alpaca")).settings.riskProfile, "balanced");
      const nivel = async (riskProfile: string) =>
        (
          await app.inject({
            method: "PUT",
            url: sim("/risk"),
            headers,
            payload: { riskProfile },
          })
        ).statusCode;
      assert.equal(await nivel("temerario"), 400);
      assert.equal(await nivel("aggressive"), 200);
      assert.equal(
        (await readSim("alpaca")).settings.riskProfile,
        "aggressive",
      );
      assert.match(
        (await readSim("alpaca")).events[0].message,
        /Nivel de riesgo/,
      );
      assert.equal(await guardar({ ...limites, maxDailyCalls: 60 }), 200);
      assert.equal(
        (await readSim("alpaca")).settings.riskProfile,
        "aggressive",
      );
      assert.equal((await readShared()).settings.maxDailyCalls, 60);
      await app.inject({
        method: "POST",
        url: sim("/lessons"),
        headers,
        payload: {
          title: "Una hipótesis de prueba",
          body: "Una ganancia aislada no valida una estrategia.",
          source: "Caso de prueba documentado",
        },
      });
      let state = await readSim("alpaca");
      const lesson = state.lessons[0];
      const previous = state.activeVersion;
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: sim(`/lessons/${lesson.id}/status`),
            headers,
            payload: { status: "accepted" },
          })
        ).statusCode,
        200,
      );
      state = await readSim("alpaca");
      assert.notEqual(state.activeVersion, previous);
      assert.ok(state.versions.at(-1)!.lessonIds.includes(lesson.id));
      await app.inject({
        method: "POST",
        url: sim(`/versions/${previous}/activate`),
        headers,
      });
      assert.equal((await readSim("alpaca")).activeVersion, previous);
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: sim("/watches"),
            headers,
            payload: {
              symbol: "AAPL",
              operator: "lte",
              price: 190,
              expiresAt,
              reason: "Prueba persistente",
            },
          })
        ).statusCode,
        200,
      );
      assert.equal((await readSim("alpaca")).watches.length, 1);
      // Transiciones concurrentes de los tres tipos, sin interbloqueos ni
      // escrituras perdidas.
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) =>
          changeSim("alpaca", (s) => enqueue(s, `Concurrent ${i}`, "other")),
        ),
        ...Array.from({ length: 10 }, () =>
          changeShared((sh) => {
            sh.heartbeat = new Date().toISOString();
          }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          changeAll((sh) => logShared(sh, "config", `Todos ${i}`)),
        ),
      ]);
      assert.equal((await readSim("alpaca")).queue.length, 10);
      assert.equal(
        (await readShared()).systemEvents.filter((e) =>
          e.message.startsWith("Todos"),
        ).length,
        5,
      );
      const outOfLimits = await app.inject({
        method: "POST",
        url: sim("/watches"),
        headers,
        payload: {
          symbol: "TSLA",
          operator: "lte",
          price: 100,
          expiresAt,
          reason: "Activo no permitido",
        },
      });
      assert.equal(outOfLimits.statusCode, 400);
      assert.match(outOfLimits.json().error, /no está en la lista permitida/);
      const missing = await app.inject({
        method: "POST",
        url: sim(`/watches/${crypto.randomUUID()}/cancel`),
        headers,
      });
      assert.equal(missing.statusCode, 400);
      assert.match(missing.json().error, /no existe/);
      const activate = await app.inject({
        method: "POST",
        url: sim("/pause"),
        headers,
        payload: { paused: false },
      });
      assert.equal(activate.statusCode, 400);
      assert.match(activate.json().error, /claves/);
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: sim(`/decisions/${crypto.randomUUID()}`),
            headers,
          })
        ).statusCode,
        404,
      );
      const panel = (
        await app.inject({ method: "GET", url: sim("/state"), headers })
      ).json();
      assert.equal(typeof panel.totals.decisions, "number");
      assert.ok(panel.decisions.every((d: any) => d.input === null));
      assert.ok(
        panel.events.some((e: any) => e.scope === "shared"),
        "el estado lleva también los eventos compartidos",
      );
      assert.equal(panel.systemEvents, undefined);
      const decisions = (
        await app.inject({
          method: "GET",
          url: sim("/decisions?page=5&size=10&kind=buy"),
          headers,
        })
      ).json();
      assert.deepEqual(Object.keys(decisions).sort(), [
        "counts",
        "items",
        "page",
        "size",
        "total",
      ]);
      assert.equal(
        decisions.page,
        1,
        "sin decisiones, la última página es la 1",
      );
      assert.equal(decisions.size, 10);
      assert.equal(decisions.counts.all, decisions.total);
      const events = (
        await app.inject({
          method: "GET",
          url: sim("/events?size=100"),
          headers,
        })
      ).json();
      assert.deepEqual(Object.keys(events).sort(), [
        "items",
        "page",
        "size",
        "total",
        "types",
      ]);
      assert.ok(events.total > 2, "cada cambio anterior dejó un evento");
      assert.ok(
        Date.parse(events.items[0].at) >= Date.parse(events.items[1].at),
        "lo más reciente primero",
      );
      assert.ok(
        events.items.some(
          (e: any) =>
            e.scope === "shared" &&
            e.message.startsWith("Límites actualizados"),
        ),
        "los eventos compartidos se mezclan con los de la simulación",
      );
      assert.ok(
        events.items.some(
          (e: any) =>
            e.scope === "sim" && e.message.startsWith("Nivel de riesgo"),
        ),
      );
      assert.equal(
        events.types.reduce((a: number, t: any) => a + t.count, 0),
        events.total,
      );
      await changeSim("alpaca", (s) => {
        s.queue = [];
      });
      await app.inject({ method: "POST", url: sim("/wake"), headers });
      assert.equal(
        (await readSim("alpaca")).queue[0].trigger,
        "manual",
        "reevaluar desde el panel se registra como manual",
      );
      await changeSim("alpaca", (s) => {
        s.usage.push(
          { at: "2026-09-10T10:00:00Z", tokens: 500 },
          {
            at: "2026-09-12T10:00:00Z",
            tokens: 1100,
            kind: "decision",
            trigger: "manual",
            promptTokens: 1000,
            completionTokens: 100,
            sections: { instructions: 1, portfolio: 1 },
            ok: true,
          },
        );
      });
      const usage = (
        await app.inject({ method: "GET", url: sim("/usage?size=1"), headers })
      ).json();
      assert.deepEqual(Object.keys(usage).sort(), [
        "items",
        "page",
        "size",
        "summary",
        "total",
      ]);
      assert.equal(usage.items.length, 1);
      assert.deepEqual(usage.items[0].estimated, {
        instructions: 500,
        portfolio: 500,
      });
      assert.equal(usage.summary.calls, 2);
      assert.equal(usage.summary.byDay.length, 3, "sin huecos entre días");
      const slim = (
        await app.inject({ method: "GET", url: sim("/state"), headers })
      ).json().usage;
      assert.equal(
        slim.at(-1).sections,
        undefined,
        "el estado no lleva el detalle de cada llamada",
      );
      const market = (
        await app.inject({ method: "GET", url: "/api/market", headers })
      ).json();
      assert.deepEqual(Object.keys(market).sort(), ["daily", "intraday"]);

      // La comparación: pide sesión, valida from antes de leer y devuelve las dos
      // simulaciones en orden.
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/compare" })).statusCode,
        401,
      );
      const malFrom = await app.inject({
        method: "GET",
        url: "/api/compare?from=ayer",
        headers,
      });
      assert.equal(malFrom.statusCode, 400);
      assert.match(malFrom.json().error, /La fecha de inicio tiene que ser/);
      await changeSim("alpaca", (s) => {
        s.decisions.push({
          id: crypto.randomUUID(),
          at: "2026-09-12T15:00:00Z",
          versionId: s.activeVersion,
          event: "Revisión periódica del mercado",
          input: { analysis: "contexto pesado que la comparación no lee" },
          proposal: {
            action: "buy",
            symbol: "SPY",
            qty: 1,
            limitPrice: 600,
            reason: "Prueba",
            hypothesis: "Prueba",
            reviewAfterHours: 24,
            notify: false,
            note: "Prueba",
            newsComments: [],
            watches: [],
            lessons: [],
          },
          status: "filled",
          orderId: "orden-1",
          sentAt: "2026-09-12T15:00:02Z",
          reviewAt: "2026-09-13T15:00:00Z",
        });
        s.fills.push({
          orderId: "orden-1",
          symbol: "SPY",
          side: "buy",
          qty: 1,
          price: 600,
          at: "2026-09-12T15:00:05Z",
        } as any);
        s.equity.push(
          { at: "2026-09-12T15:00:00Z", value: 100000 },
          { at: "2026-09-12T16:00:00Z", value: 100010 },
        );
      });
      const cmp = await app.inject({
        method: "GET",
        url: "/api/compare?from=2026-09-01T00:00:00Z",
        headers,
      });
      assert.equal(cmp.statusCode, 200);
      const c = cmp.json();
      assert.deepEqual(Object.keys(c), ["from", "sims", "series", "bySim"]);
      assert.equal(c.from, "2026-09-01T00:00:00.000Z");
      assert.deepEqual(c.sims, ["alpaca", "internal"]);
      assert.deepEqual(Object.keys(c.bySim), ["alpaca", "internal"]);
      assert.deepEqual(Object.keys(c.series.values), ["alpaca", "internal"]);
      assert.equal(c.series.at.length, c.series.values.alpaca.length);
      assert.deepEqual(Object.keys(c.bySim.internal).sort(), [
        "decisions",
        "label",
        "result",
        "riskProfile",
        "startedAt",
        "tokens",
        "trades",
      ]);
      assert.equal(c.bySim.alpaca.label, "Alpaca Paper");
      assert.equal(c.bySim.internal.label, "Interna");
      assert.equal(c.bySim.internal.riskProfile, "aggressive");
      assert.equal(c.bySim.alpaca.tokens.calls, 2);
      assert.equal(c.bySim.alpaca.decisions.sent, 1);
      assert.equal(c.bySim.alpaca.trades.buys, 1);
      assert.equal(c.bySim.internal.tokens.calls, 0);
      // Sin from empieza en el inicio de comparación más reciente.
      const sinFrom = (
        await app.inject({ method: "GET", url: "/api/compare", headers })
      ).json();
      assert.equal(
        sinFrom.from,
        (await readSim("internal")).comparison!.startedAt,
      );
      // Leer solo lo necesario da lo mismo que leer las simulaciones enteras.
      const ligero = await db.readCompare();
      assert.equal(
        (ligero.alpaca.decisions.at(-1) as any).input,
        undefined,
        "sin el contexto guardado",
      );
      const entrada = (x: any, riskProfile: string) => ({
        label: x.label ?? "",
        riskProfile,
        equity: x.equity,
        fills: x.fills,
        comparison: x.comparison,
        usage: x.usage,
        decisions: x.decisions,
        account: x.account,
      });
      const enteras = {
        alpaca: await readSim("alpaca"),
        internal: await readSim("internal"),
      };
      const T = Date.parse("2026-09-16T12:00:00Z");
      assert.deepEqual(
        compare.compareSims(
          {
            alpaca: entrada(ligero.alpaca, ligero.alpaca.riskProfile),
            internal: entrada(ligero.internal, ligero.internal.riskProfile),
          },
          "2026-09-01T00:00:00Z",
          T,
        ),
        JSON.parse(
          JSON.stringify(
            compare.compareSims(
              {
                alpaca: entrada(
                  enteras.alpaca,
                  enteras.alpaca.settings.riskProfile,
                ),
                internal: entrada(
                  enteras.internal,
                  enteras.internal.settings.riskProfile,
                ),
              },
              "2026-09-01T00:00:00Z",
              T,
            ),
          ),
        ),
      );

      // Quitar un activo de los límites cancela sus vigilancias.
      assert.equal(
        await guardar({
          ...limites,
          maxDailyCalls: 60,
          symbols: ["SPY", "MSFT"],
        }),
        200,
      );
      assert.equal((await readSim("alpaca")).watches[0].status, "cancelled");

      // Un latido solo reescribe shared:hot, y el análisis no toca el historial
      // de la simulación.
      const antes = await rowsXmin();
      await changeShared((sh) => agent.applyQuotes(sh, {}, true, Date.now()));
      let despues = await rowsXmin();
      assert.notEqual(despues["shared:hot"], antes["shared:hot"]);
      for (const k of ["shared:cold", "sim:alpaca:hot", "sim:alpaca:cold"])
        assert.equal(despues[k], antes[k], `${k} no se reescribe`);
      await changeShared((sh) =>
        agent.applyAnalysis(sh, {
          SPY: { barsDiscarded: 0, bars: [] } as any,
        }),
      );
      const trasAnalisis = await rowsXmin();
      assert.notEqual(trasAnalisis["shared:cold"], despues["shared:cold"]);
      assert.equal(trasAnalisis["sim:alpaca:cold"], antes["sim:alpaca:cold"]);
      assert.equal(trasAnalisis["sim:alpaca:hot"], antes["sim:alpaca:hot"]);
      // Mirar las vigilancias sin cambios no escribe nada.
      await changeSim("alpaca", (s) => agent.applyWatches(s));
      assert.deepEqual(await rowsXmin(), trasAnalisis);
      // Pausar solo reescribe la fila caliente de la simulación.
      await changeSim("alpaca", (s) => {
        s.paused = !s.paused;
      });
      despues = await rowsXmin();
      assert.notEqual(
        despues["sim:alpaca:hot"],
        trasAnalisis["sim:alpaca:hot"],
      );
      assert.equal(despues["sim:alpaca:cold"], trasAnalisis["sim:alpaca:cold"]);
      assert.equal(despues["shared:hot"], trasAnalisis["shared:hot"]);

      // Una transición de simulación que toca lo compartido falla y no guarda
      // nada.
      await assert.rejects(
        changeSim("alpaca", (s) => {
          s.paused = !s.paused;
          s.quotes.SPY = { price: 1, at: new Date().toISOString() };
        }),
        /intentó cambiar el estado compartido: quotes/,
      );
      await assert.rejects(
        changeAll((_sh, views) => {
          views.alpaca.settings.maxOrderUsd = 1;
        }),
        /estado compartido: settings/,
      );
      assert.deepEqual(await rowsXmin(), despues);
      // El nivel y los comentarios de noticias sí son de la simulación.
      await changeShared((sh) =>
        agent.mergeNews(sh, [
          {
            id: 99,
            created_at: new Date().toISOString(),
            headline: "Titular",
            symbols: ["SPY"],
          },
        ]),
      );
      await changeSim("alpaca", (s) => {
        s.stories[0].commented = true;
      });
      assert.deepEqual((await readHot()).sims.alpaca.commentedStories, ["99"]);
      assert.equal(
        (await readShared()).stories[0].commented,
        undefined,
        "la noticia compartida no sabe quién la comentó",
      );

      // Un estado guardado antes de que existiera un campo debe seguir leyéndose.
      await q(
        "UPDATE meridian_rows SET data = data - 'stories' - 'analysis' WHERE key='shared:cold'",
      );
      await q(
        "UPDATE meridian_rows SET data = data - 'feeds' WHERE key='shared:hot'",
      );
      await q(
        "UPDATE meridian_rows SET data = data - 'lastNotice' - 'riskProfile' WHERE key='sim:alpaca:hot'",
      );
      await q(
        "UPDATE meridian_rows SET data = data - 'fills' - 'comparison' WHERE key='sim:alpaca:cold'",
      );
      const recuperado = await readSim("alpaca");
      assert.deepEqual(recuperado.stories, [], "un campo ausente vuelve vacío");
      assert.deepEqual(recuperado.analysis, {});
      assert.deepEqual(recuperado.feeds, { trades: true, clock: true });
      assert.equal(recuperado.lastNotice, null);
      assert.equal(recuperado.settings.riskProfile, "balanced");
      assert.deepEqual(recuperado.fills, []);
      assert.equal(recuperado.comparison, null);
      assert.ok(recuperado.decisions.length >= 0);
      assert.equal(
        recuperado.lessons.length,
        1,
        "lo que sí estaba guardado no se pierde",
      );
      const page = await app.inject({ method: "GET", url: "/" });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /Meridian/);
      assert.ok(page.headers["content-security-policy"]);
    } finally {
      await app.close();
    }
  },
);
