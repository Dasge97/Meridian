// Vuelta atrás de la separación en simulaciones: devuelve el estado de Alpaca a
// meridian_state, en pausa, y aparta meridian_rows con todo lo demás, también la
// simulación interna. Con api y worker parados.
import { migrateDown, pool } from "./db.ts";
try {
  const apartada = await migrateDown();
  console.log(
    `Estado de Alpaca Paper devuelto a meridian_state y en pausa. meridian_rows se ha renombrado a ${apartada}; la simulación interna queda allí.`,
  );
} finally {
  await pool.end();
}
