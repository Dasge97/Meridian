import React, { useMemo, useState } from "react";
import { Search, X, TriangleAlert } from "lucide-react";
import type { Decision } from "../../src/domain";
import type { ViewProps } from "./types";
import { money, clockTime, Empty } from "../shared";
import { Badge, Stat } from "../ui";
import {
  ActionIcon,
  ReviewLine,
  actionText,
  amount,
  needsReconcile,
  orderText,
  wasSent,
} from "./decisions-parts";
import "./decisions.css";

const filters: [string, string, (d: Decision) => boolean][] = [
  ["all", "Todas", () => true],
  ["buy", "Compras", (d) => d.proposal.action === "buy"],
  ["sell", "Ventas", (d) => d.proposal.action === "sell"],
  ["wait", "Esperas", (d) => d.proposal.action === "wait"],
  ["blocked", "Bloqueadas", (d) => d.status === "blocked"],
  ["unknown", "Por reconciliar", needsReconcile],
];

// Sin mayúsculas ni acentos, para que «revision» encuentre «revisión».
const plain = (t: string) =>
  t
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const dayKey = (at: string) => {
  const x = new Date(at);
  return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
};

function dayLabel(at: string) {
  const today = new Date(),
    yesterday = new Date(Date.now() - 86400000);
  if (dayKey(at) === dayKey(today.toISOString())) return "Hoy";
  if (dayKey(at) === dayKey(yesterday.toISOString())) return "Ayer";
  const text = new Date(at).toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year:
      new Date(at).getFullYear() === today.getFullYear()
        ? undefined
        : "numeric",
  });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function daySummary(list: Decision[]) {
  const n = (a: string) => list.filter((d) => d.proposal.action === a).length;
  return [
    [n("buy"), "compra", "compras"],
    [n("sell"), "venta", "ventas"],
    [n("wait"), "espera", "esperas"],
  ]
    .filter(([c]) => c)
    .map(([c, one, many]) => `${c} ${c === 1 ? one : many}`)
    .join(" · ");
}

function Row({ d, onOpen }: { d: Decision; onOpen: () => void }) {
  const p = d.proposal,
    order = orderText(d),
    total = amount(d);
  return (
    <li>
      <button
        type="button"
        className={"dc-row" + (needsReconcile(d) ? " attn" : "")}
        onClick={onOpen}
      >
        <ActionIcon action={p.action} />
        <span className="dc-head">
          <strong className="dc-sym">{p.symbol || "Mercado"}</strong>
          <span className="dc-action">{actionText[p.action]}</span>
        </span>
        <span className="dc-text">{p.note || p.reason}</span>
        <span className="dc-meta">
          <ReviewLine d={d} />
        </span>
        <span className="dc-amount num">
          {order ? (
            <>
              <span>{order}</span>
              <b>{money(total)}</b>
            </>
          ) : (
            <span className="muted">Sin orden</span>
          )}
        </span>
        <span className="dc-status">
          <Badge value={d.status} />
        </span>
        <time className="dc-time num" dateTime={d.at}>
          {clockTime(d.at)}
        </time>
      </button>
    </li>
  );
}

// Flechas, Inicio y Fin mueven el foco entre filas.
function moveFocus(e: React.KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const rows = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>(".dc-row"),
  );
  const i = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  e.preventDefault();
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? rows.length - 1
        : Math.max(
            0,
            Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)),
          );
  rows[next]?.focus();
}

export function Decisions(p: ViewProps) {
  const { s } = p;
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");

  const recent = useMemo(() => [...s.decisions].reverse(), [s.decisions]);
  const searched = useMemo(() => {
    const q = plain(query.trim());
    if (!q) return recent;
    return recent.filter((d) =>
      plain(
        [
          d.proposal.symbol ?? "mercado",
          d.proposal.note,
          d.proposal.reason,
          d.proposal.hypothesis,
          d.event,
          d.error ?? "",
        ].join(" "),
      ).includes(q),
    );
  }, [recent, query]);
  const test = filters.find(([k]) => k === filter)?.[2] ?? (() => true);
  const shown = searched.filter(test);
  const days: [string, Decision[]][] = [];
  for (const d of shown) {
    const last = days.at(-1);
    if (last && dayKey(last[1][0].at) === dayKey(d.at)) last[1].push(d);
    else days.push([d.at, [d]]);
  }

  const sent = recent.filter(wasSent).length,
    blocked = recent.filter((d) => d.status === "blocked").length,
    pendingFix = recent.filter(needsReconcile).length;

  return (
    <>
      <div className="dc-figures">
        <Stat label="Decisiones" value={String(s.totals.decisions)}>
          <small>
            {s.totals.decisions > recent.length
              ? `se muestran las ${recent.length} más recientes`
              : "todo el historial"}
          </small>
        </Stat>
        <Stat label="Órdenes enviadas" value={String(sent)}>
          <small>salieron hacia Alpaca</small>
        </Stat>
        <Stat label="Bloqueadas" value={String(blocked)}>
          <small>las frenaron los límites</small>
        </Stat>
        <div className={"dc-attn-wrap" + (pendingFix ? " on" : "")}>
          <Stat label="Por reconciliar" value={String(pendingFix)}>
            {pendingFix ? (
              <button
                type="button"
                className="dc-attn-link"
                onClick={() => {
                  setFilter("unknown");
                  setQuery("");
                }}
              >
                <TriangleAlert size={14} aria-hidden="true" />
                Requiere atención
              </button>
            ) : (
              <small>nada pendiente</small>
            )}
          </Stat>
        </div>
      </div>

      <section className="panel dc-panel">
        <div className="section-title dc-toolbar">
          <div className="filters" role="group" aria-label="Filtrar decisiones">
            {filters.map(([k, label, fn]) => {
              const n = searched.filter(fn).length;
              return (
                <button
                  type="button"
                  key={k}
                  aria-pressed={filter === k}
                  className={k === "unknown" && n ? "dc-hot" : undefined}
                  onClick={() => setFilter(k)}
                >
                  {label} <small>{n}</small>
                </button>
              );
            })}
          </div>
          <label className="dc-search">
            <span className="sr-only">Buscar por activo o texto</span>
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="Buscar activo o texto"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="icon"
                aria-label="Borrar búsqueda"
                onClick={() => setQuery("")}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </label>
        </div>

        <p className="sr-only" role="status">
          {shown.length} decisiones
        </p>

        {!recent.length ? (
          <Empty>
            Cuando el agente evalúe un evento, guardará aquí su información,
            hipótesis y decisión.
          </Empty>
        ) : !shown.length ? (
          <div className="dc-none">
            <Empty>
              Ninguna decisión coincide con el filtro y la búsqueda.
            </Empty>
            <button
              type="button"
              onClick={() => {
                setFilter("all");
                setQuery("");
              }}
            >
              Ver todas
            </button>
          </div>
        ) : (
          <div className="dc-timeline" onKeyDown={moveFocus}>
            {days.map(([at, list]) => (
              <section className="dc-day" key={dayKey(at)}>
                <div className="dc-day-title">
                  <h3>{dayLabel(at)}</h3>
                  <span>
                    {list.length}{" "}
                    {list.length === 1 ? "decisión" : "decisiones"} ·{" "}
                    {daySummary(list)}
                  </span>
                </div>
                <ol>
                  {list.map((d) => (
                    <Row key={d.id} d={d} onOpen={() => p.openDecision(d)} />
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
