// Las simulaciones del laboratorio. Sin dependencias, para que el panel lo
// importe sin arrastrar código del servidor.
//
// Cada simulación tiene su nivel de riesgo, su cuenta, su memoria y su historial.
// Los límites, los precios, el calendario, el análisis y las noticias son
// compartidos. Añadir una simulación es añadir su id aquí y crear sus filas en la
// migración.
export const SIM_IDS = ["alpaca", "internal"] as const;
export type SimId = (typeof SIM_IDS)[number];
// alpaca envía órdenes a Alpaca Paper; internal las ejecuta en src/paper.ts y no
// envía nada a Alpaca.
export type Broker = "alpaca" | "internal";
export const SIMS: Record<SimId, { label: string; broker: Broker }> = {
  alpaca: { label: "Alpaca Paper", broker: "alpaca" },
  internal: { label: "Interna", broker: "internal" },
};
export const isSimId = (x: unknown): x is SimId =>
  (SIM_IDS as readonly unknown[]).includes(x);
// Lo que el selector del panel necesita de cada simulación, sin leer su
// historial. Lo da GET /api/sims/:sim/state en sims.
export type SimSummary = {
  id: SimId;
  label: string;
  broker: Broker;
  riskProfile: string;
  paused: boolean;
  evaluating: boolean;
  equity: number | null;
  baseline: number | null;
  unresolved: number;
};
