import type { State, Decision } from "../../src/domain";
export type Data = State & {
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
};
