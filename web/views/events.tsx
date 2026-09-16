// Registro completo de actividad: filtros, días y páginas pedidas al servidor.
import React, { useEffect, useRef, useState } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { Sheet } from "../ui";
import { Empty } from "../shared";
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
import { EventItem, eventKind, type LabEvent } from "./summary-activity";
import "./events.css";

type EventPage = {
  items: LabEvent[];
  total: number;
  page: number;
  size: number;
  types: { type: string; count: number }[];
};

function dayLabel(at: string) {
  const d = new Date(at),
    today = new Date(),
    yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Hoy";
  if (d.toDateString() === yesterday.toDateString()) return "Ayer";
  return d.toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

function byDay(items: LabEvent[]) {
  const days: { key: string; label: string; items: LabEvent[] }[] = [];
  for (const e of items) {
    const key = new Date(e.at).toDateString();
    if (days.at(-1)?.key !== key)
      days.push({ key, label: dayLabel(e.at), items: [] });
    days.at(-1)!.items.push(e);
  }
  return days;
}

export function EventLog(p: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  latestId: string | undefined;
  api: (path: string) => string;
}) {
  const [range, setRange] = useState<Range>(ANY_RANGE),
    [text, setText] = useState(""),
    [q, setQ] = useState(""),
    [type, setType] = useState(""),
    [page, setPage] = useState(1),
    [size, setSize] = useState(25),
    [data, setData] = useState<EventPage | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0),
    top = useRef<HTMLDivElement>(null);

  // La búsqueda espera a que se deje de escribir.
  useEffect(() => {
    if (text.trim() === q) return;
    const t = setTimeout(() => {
      setQ(text.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [text, q]);

  // Solo la primera página sigue a los eventos nuevos.
  const follow = page === 1 ? p.latestId : undefined;

  useEffect(() => {
    if (!p.open) return;
    const ctrl = new AbortController(),
      params = rangeQuery(range);
    params.set("page", String(page));
    params.set("size", String(size));
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    setLoading(true);
    fetch("/api" + p.api("/events?" + params), { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json() as Promise<EventPage>;
      })
      .then((d) => {
        setData(d);
        setError(false);
        setLoading(false);
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        setError(true);
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [p.open, range, q, type, page, size, follow, retry]);

  const active = rangeActive(range) || Boolean(text) || Boolean(type),
    all = data?.types.reduce((a, x) => a + x.count, 0) ?? 0,
    types = [...(data?.types ?? [])].sort((a, b) => b.count - a.count);
  if (type && !types.some((x) => x.type === type))
    types.push({ type, count: 0 });

  const filter =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };
  const clear = () => {
    setRange(ANY_RANGE);
    setText("");
    setQ("");
    setType("");
    setPage(1);
  };

  return (
    <Sheet
      open={p.open}
      onOpenChange={p.onOpenChange}
      title="Registro de actividad"
      subtitle="Todo lo que ha hecho el laboratorio, lo más reciente primero."
    >
      <div className="ev" ref={top}>
        <FilterBar
          active={active}
          onClear={clear}
          summary={
            active && data ? (
              <span className="num">
                {data.total === 1
                  ? "1 evento coincide"
                  : `${data.total} eventos coinciden`}
              </span>
            ) : undefined
          }
        >
          <SearchInput
            id="ev-search"
            label="Buscar en el registro"
            placeholder="Busca por tipo o mensaje"
            value={text}
            onChange={setText}
          />
          <DateRange id="ev-range" value={range} onChange={filter(setRange)} />
          {types.length > 0 && (
            <div className="filters ev-types" role="group" aria-label="Tipo">
              <button
                type="button"
                aria-pressed={!type}
                onClick={() => filter(setType)("")}
              >
                Todos <small className="num">{all}</small>
              </button>
              {types.map((x) => (
                <button
                  type="button"
                  key={x.type}
                  aria-pressed={type === x.type}
                  onClick={() => filter(setType)(type === x.type ? "" : x.type)}
                >
                  {eventKind(x.type).label}{" "}
                  <small className="num">{x.count}</small>
                </button>
              ))}
            </div>
          )}
        </FilterBar>

        {error && (
          <div className="banner down" role="alert">
            <TriangleAlert size={18} aria-hidden />
            <p>No se pudo cargar el registro.</p>
            <button type="button" onClick={() => setRetry((n) => n + 1)}>
              Reintentar
            </button>
          </div>
        )}

        {!data ? (
          !error && (
            <p className="ev-loading muted" role="status">
              <LoaderCircle className="spin" size={16} aria-hidden />
              Cargando el registro…
            </p>
          )
        ) : data.total === 0 ? (
          <Empty>
            {active
              ? "Ningún evento coincide con estos filtros."
              : "Todavía no hay eventos en el registro."}
          </Empty>
        ) : (
          <div
            className={"ev-list" + (loading ? " is-loading" : "")}
            aria-busy={loading}
          >
            {byDay(data.items).map((d) => (
              <section className="ev-day" key={d.key}>
                <h3 className="ev-day-title">
                  <span>{d.label}</span>
                </h3>
                <ol className="sm-timeline">
                  {d.items.map((e) => (
                    <EventItem key={e.id} e={e} time="clock" />
                  ))}
                </ol>
              </section>
            ))}
            <Pagination
              label="Páginas del registro"
              page={data.page}
              size={data.size}
              total={data.total}
              onPage={(n) => {
                setPage(n);
                top.current?.closest(".sheet-body")?.scrollTo({ top: 0 });
              }}
              onSize={filter(setSize)}
            />
          </div>
        )}
      </div>
    </Sheet>
  );
}
