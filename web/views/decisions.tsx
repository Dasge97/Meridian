import React, { useEffect, useMemo, useRef, useState } from "react";
import { TriangleAlert, LoaderCircle, RotateCw } from "lucide-react";
import type { Decision } from "../../src/domain";
import type { DecisionKind, DecisionPage } from "../../src/listing";
import type { ViewProps } from "./types";
import { money, clockTime, Empty } from "../shared";
import { Badge, Stat } from "../ui";
import {
  ANY_RANGE,
  DateRange,
  FilterBar,
  Pagination,
  SearchInput,
  rangeActive,
  rangeQuery,
  type Range,
} from "../listing";
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

const kinds: [DecisionKind, string][] = [
  ["all", "Todas"],
  ["buy", "Compras"],
  ["sell", "Ventas"],
  ["wait", "Esperas"],
  ["blocked", "Bloqueadas"],
  ["unresolved", "Por reconciliar"],
];

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
  const [range, setRange] = useState<Range>(ANY_RANGE);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<DecisionKind>("all");
  const [symbol, setSymbol] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [data, setData] = useState<DecisionPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // La búsqueda espera a que se deje de escribir para no pedir en cada tecla.
  useEffect(() => {
    const value = text.trim();
    if (value === q) return;
    const t = setTimeout(() => {
      setQ(value);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [text, q]);

  // Cambia al llegar una decisión nueva o al cambiar el estado de una reciente.
  // El estado se refresca cada 5 s, pero si nada cambió la firma es la misma y
  // no se vuelve a pedir la página.
  const signature = useMemo(
    () =>
      (s.decisions.at(-1)?.id ?? "") +
      "|" +
      s.decisions.map((d) => d.status).join(","),
    [s.decisions],
  );
  const wrongRange = Boolean(range.from && range.to && range.from > range.to);

  useEffect(() => {
    if (wrongRange) return;
    const params = rangeQuery(range);
    params.set("page", String(page));
    params.set("size", String(size));
    if (q) params.set("q", q);
    if (kind !== "all") params.set("kind", kind);
    if (symbol) params.set("symbol", symbol);
    const ctrl = new AbortController();
    setLoading(true);
    fetch("/api/decisions?" + params, { signal: ctrl.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok)
          throw new Error(
            body?.error ?? "No se pudo cargar la lista de decisiones.",
          );
        setData(body as DecisionPage);
        setError("");
      })
      .catch((e: Error) => {
        if (ctrl.signal.aborted) return;
        setError(
          e instanceof TypeError
            ? "Sin conexión con el servidor. No se pudo cargar la lista."
            : e.message,
        );
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [range, q, kind, symbol, page, size, signature, retry, wrongRange]);

  const active = Boolean(
    rangeActive(range) || text || kind !== "all" || symbol,
  );
  function clear() {
    setRange(ANY_RANGE);
    setText("");
    setQ("");
    setKind("all");
    setSymbol("");
    setPage(1);
  }
  function goToPage(n: number) {
    setPage(n);
    const top = listRef.current?.getBoundingClientRect().top;
    if (top !== undefined && top < 0)
      listRef.current?.scrollIntoView({ block: "start" });
  }

  // Las cifras de arriba no dependen de los filtros.
  const recent = s.decisions,
    partial = s.totals.decisions > recent.length,
    sent = recent.filter(wasSent).length,
    blocked = recent.filter((d) => d.status === "blocked").length,
    pendingFix = recent.filter(needsReconcile).length;

  const symbols =
    symbol && !s.settings.symbols.includes(symbol)
      ? [...s.settings.symbols, symbol]
      : s.settings.symbols;

  const days: [string, Decision[]][] = [];
  for (const d of data?.items ?? []) {
    const last = days.at(-1);
    if (last && dayKey(last[1][0].at) === dayKey(d.at)) last[1].push(d);
    else days.push([d.at, [d]]);
  }

  return (
    <>
      <div className="dc-figures">
        <Stat label="Decisiones" value={String(s.totals.decisions)}>
          <small>en todo el historial</small>
        </Stat>
        <Stat label="Órdenes enviadas" value={String(sent)}>
          <small>
            {partial
              ? `de las ${recent.length} más recientes`
              : "salieron hacia Alpaca"}
          </small>
        </Stat>
        <Stat label="Bloqueadas" value={String(blocked)}>
          <small>
            {partial
              ? `de las ${recent.length} más recientes`
              : "las frenaron los límites"}
          </small>
        </Stat>
        <div className={"dc-attn-wrap" + (pendingFix ? " on" : "")}>
          <Stat label="Por reconciliar" value={String(pendingFix)}>
            {pendingFix ? (
              <button
                type="button"
                className="dc-attn-link"
                onClick={() => {
                  clear();
                  setKind("unresolved");
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

      <section className="panel dc-panel" ref={listRef}>
        <FilterBar
          active={active}
          onClear={clear}
          summary={
            active && data
              ? `${data.total} ${data.total === 1 ? "decisión" : "decisiones"} con estos filtros`
              : undefined
          }
        >
          <DateRange
            id="dc-range"
            value={range}
            onChange={(r) => {
              setRange(r);
              setPage(1);
            }}
          />
          <SearchInput
            id="dc-q"
            label="Buscar en las decisiones"
            placeholder="Activo, nota, razonamiento o evento"
            value={text}
            onChange={setText}
          />
          <label className="dc-symbol">
            <span className="sr-only">Activo</span>
            <select
              value={symbol}
              onChange={(e) => {
                setSymbol(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Todos los activos</option>
              {symbols.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
        </FilterBar>

        <div
          className="filters dc-kinds"
          role="group"
          aria-label="Tipo de decisión"
        >
          {kinds.map(([k, label]) => {
            const n = data?.counts[k];
            return (
              <button
                type="button"
                key={k}
                aria-pressed={kind === k}
                className={k === "unresolved" && n ? "dc-hot" : undefined}
                onClick={() => {
                  setKind(k);
                  setPage(1);
                }}
              >
                {label} {n !== undefined && <small>{n}</small>}
              </button>
            );
          })}
        </div>

        <p className="sr-only" role="status">
          {loading
            ? "Cargando decisiones"
            : data
              ? `${data.total} ${data.total === 1 ? "decisión" : "decisiones"}`
              : ""}
        </p>

        {error && (
          <div className="banner down" role="alert">
            <TriangleAlert size={18} aria-hidden />
            <p>{error}</p>
            <button
              type="button"
              className="with-icon"
              onClick={() => setRetry((n) => n + 1)}
            >
              <RotateCw size={15} aria-hidden /> Reintentar
            </button>
          </div>
        )}

        {!data ? (
          !error && (
            <p className="dc-loading-first muted">
              <LoaderCircle className="spin" size={16} aria-hidden />
              Cargando decisiones…
            </p>
          )
        ) : !s.totals.decisions && !data.total && !active ? (
          <Empty>
            Cuando el agente evalúe un evento, guardará aquí su información,
            hipótesis y decisión.
          </Empty>
        ) : !data.total ? (
          <div className="dc-none">
            <Empty>Ninguna decisión con estos filtros.</Empty>
            <button type="button" onClick={clear}>
              Quitar filtros
            </button>
          </div>
        ) : (
          <>
            <div
              className={"dc-timeline" + (loading ? " dc-stale" : "")}
              aria-busy={loading}
              onKeyDown={moveFocus}
            >
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
            <Pagination
              label="Páginas de decisiones"
              page={data.page}
              size={data.size}
              total={data.total}
              onPage={goToPage}
              onSize={(n) => {
                setSize(n);
                setPage(1);
              }}
            />
          </>
        )}
      </section>
    </>
  );
}
