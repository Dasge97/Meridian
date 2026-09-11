import pg from "pg";
import {
  initialState,
  prune,
  hotKeys,
  coldKeys,
  type State,
} from "./domain.ts";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 10000,
});
// Row 1 is rewritten every worker iteration; row 2 holds the history.
const HOT = 1,
  COLD = 2,
  ROWS = [HOT, COLD] as const;
const pick = <K extends readonly (keyof State)[]>(s: State, keys: K) =>
  Object.fromEntries(keys.map((k) => [k, s[k]]));
const split = (s: State) => ({
  [HOT]: JSON.stringify(pick(s, hotKeys)),
  [COLD]: JSON.stringify(pick(s, coldKeys)),
});
export async function migrate() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS meridian_state (id integer PRIMARY KEY, data jsonb NOT NULL)",
  );
  // The first release only allowed id=1; the history row needs that check gone.
  await pool.query(
    "ALTER TABLE meridian_state DROP CONSTRAINT IF EXISTS meridian_state_id_check",
  );
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const rows = (
      await c.query(
        "SELECT id, data FROM meridian_state ORDER BY id FOR UPDATE",
      )
    ).rows;
    const stored = new Map<number, any>(rows.map((r) => [r.id, r.data]));
    // A single row from the first release still holds the whole document.
    const parts = split({ ...initialState(), ...(stored.get(HOT) ?? {}) });
    for (const id of ROWS)
      if (!stored.has(id))
        await c.query("INSERT INTO meridian_state(id,data) VALUES($1,$2)", [
          id,
          parts[id],
        ]);
    if (stored.has(HOT) && !stored.has(COLD))
      await c.query("UPDATE meridian_state SET data=$1 WHERE id=$2", [
        parts[HOT],
        HOT,
      ]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
function assemble(rows: { id: number; data: any }[]): State {
  if (!rows.some((r) => r.id === HOT) || !rows.some((r) => r.id === COLD))
    throw new Error("Estado incompleto: ejecuta la migración");
  // Un estado guardado antes de que existiera un campo no lo trae. Partir de los
  // valores iniciales hace que cualquier campo nuevo aparezca ya con su valor
  // por defecto, sin migrar nada a mano.
  return Object.assign({}, initialState(), ...rows.map((r) => r.data));
}
export async function read(): Promise<State> {
  return assemble(
    (await pool.query("SELECT id, data FROM meridian_state ORDER BY id")).rows,
  );
}
export async function change<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const s = assemble(
      (
        await c.query(
          "SELECT id, data FROM meridian_state ORDER BY id FOR UPDATE",
        )
      ).rows,
    );
    const before = split(s);
    const result = await fn(s);
    prune(s);
    const after = split(s);
    // Only the part that actually changed is rewritten.
    for (const id of ROWS)
      if (before[id] !== after[id])
        await c.query("UPDATE meridian_state SET data=$1 WHERE id=$2", [
          after[id],
          id,
        ]);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
