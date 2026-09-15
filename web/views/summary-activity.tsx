// Un evento del registro en la línea de tiempo. Lo comparten la actividad
// reciente de Resumen y el registro completo.
import React from "react";
import {
  ArrowLeftRight,
  Brain,
  ChartCandlestick,
  CircleDot,
  ClipboardCheck,
  Eye,
  GitBranch,
  Newspaper,
  Power,
  RefreshCw,
  SlidersHorizontal,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { Data } from "./types";
import { date, clockTime } from "../shared";
import "./summary.css";

export type LabEvent = Data["events"][number];

const kinds: Record<string, { label: string; Icon: LucideIcon }> = {
  order: { label: "Orden", Icon: ArrowLeftRight },
  orden: { label: "Orden", Icon: ArrowLeftRight },
  market: { label: "Mercado", Icon: ChartCandlestick },
  mercado: { label: "Mercado", Icon: ChartCandlestick },
  decision: { label: "Decisión", Icon: Brain },
  review: { label: "Revisión", Icon: ClipboardCheck },
  watch: { label: "Vigilancia", Icon: Eye },
  vigilancia: { label: "Vigilancia", Icon: Eye },
  control: { label: "Control", Icon: Power },
  config: { label: "Configuración", Icon: SlidersHorizontal },
  version: { label: "Versión", Icon: GitBranch },
  sync: { label: "Sincronización", Icon: RefreshCw },
  news: { label: "Noticias", Icon: Newspaper },
  noticias: { label: "Noticias", Icon: Newspaper },
  error: { label: "Error", Icon: TriangleAlert },
};

export const eventKind = (type: string) =>
  kinds[type] ?? { label: type, Icon: CircleDot };

// Con "clock" solo la hora, para listas ya agrupadas por día.
export function EventItem(p: { e: LabEvent; time?: "auto" | "clock" }) {
  const { e } = p,
    k = eventKind(e.type),
    sameDay = new Date(e.at).toDateString() === new Date().toDateString();
  return (
    <li className={e.type === "error" ? "is-error" : undefined}>
      <span className="sm-dot" aria-hidden="true">
        <k.Icon size={14} />
      </span>
      <div>
        <span className="sm-type">{k.label}</span>
        <p>{e.message}</p>
      </div>
      <time className="num" dateTime={e.at} title={date(e.at)}>
        {p.time === "clock" || sameDay ? clockTime(e.at) : date(e.at)}
      </time>
    </li>
  );
}
