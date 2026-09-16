import type { State, Decision } from "../../src/domain";
import type { Event as ListedEvent } from "../../src/listing";
import type { SimId, SimSummary } from "../../src/sims";
export type Data = Omit<State, "events"> & {
  // Los de la simulación y los compartidos, cada uno con su scope.
  events: ListedEvent[];
  // Todas las simulaciones en pocas cifras, para el selector de la cabecera.
  sims: SimSummary[];
  totals: { decisions: number; events: number; equity: number };
  connection: {
    alpaca: boolean;
    model: boolean;
    modelName: string | null;
    telegram: boolean;
  };
};
export type Act = (
  url: string,
  body?: unknown,
  method?: string,
) => Promise<boolean>;
// Lo que recibe cada vista del panel desde main.tsx.
export type ViewProps = {
  s: Data;
  busy: boolean;
  act: Act;
  openDecision: (d: Decision) => void;
  goTo: (tab: string) => void;
  setError: (message: string) => void;
  // La simulación que se está viendo, y la ruta de la API para ella: api("/pause")
  // da "/sims/alpaca/pause". act la usa tal cual y fetch le antepone "/api".
  // /api/market y PUT /api/settings son compartidos y no la llevan.
  sim: SimId;
  api: (path: string) => string;
};
