import pg from "pg";
import { initialState, type State } from "./domain.ts";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 6,
  connectionTimeoutMillis: 10000,
});
export async function migrate() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS meridian_state (id integer PRIMARY KEY CHECK (id=1), data jsonb NOT NULL)",
  );
  await pool.query(
    "INSERT INTO meridian_state(id,data) VALUES(1,$1) ON CONFLICT DO NOTHING",
    [JSON.stringify(initialState())],
  );
}
export async function read(): Promise<State> {
  return (await pool.query("SELECT data FROM meridian_state WHERE id=1"))
    .rows[0].data;
}
export async function change<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const s = (
      await c.query("SELECT data FROM meridian_state WHERE id=1 FOR UPDATE")
    ).rows[0].data as State;
    const result = await fn(s);
    await c.query("UPDATE meridian_state SET data=$1 WHERE id=1", [
      JSON.stringify(s),
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
