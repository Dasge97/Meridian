import { migrate, pool } from "./db.ts";
await migrate();
await pool.end();
console.log("Schema ready");
