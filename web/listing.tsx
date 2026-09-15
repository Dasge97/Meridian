// Piezas para buscar, acotar por fechas y paginar listas largas. Las listas que
// llegan enteras en el estado se filtran en el navegador con paginate() e
// inRange(); las que no (decisiones y eventos) piden cada página al servidor
// con rangeQuery().
import React, { useId } from "react";
import { Search, ChevronLeft, ChevronRight, X } from "lucide-react";
import "./listing.css";
// Días en la hora del navegador, como los da <input type="date">. Vacío es sin límite.
export type Range = { from: string; to: string };
export const ANY_RANGE: Range = { from: "", to: "" };
export const PAGE_SIZES = [25, 50, 100];
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Del inicio del primer día al final del último, en la hora del navegador.
export function rangeBounds(r: Range) {
  return {
    from: r.from ? new Date(r.from + "T00:00:00").getTime() : -Infinity,
    to: r.to ? new Date(r.to + "T23:59:59.999").getTime() : Infinity,
  };
}
export function inRange(at: string, r: Range) {
  const t = Date.parse(at),
    b = rangeBounds(r);
  return t >= b.from && t <= b.to;
}
// Parámetros from y to en ISO para los endpoints paginados del servidor.
export function rangeQuery(r: Range) {
  const b = rangeBounds(r),
    q = new URLSearchParams();
  if (r.from) q.set("from", new Date(b.from).toISOString());
  if (r.to) q.set("to", new Date(b.to).toISOString());
  return q;
}
export const rangeActive = (r: Range) => Boolean(r.from || r.to);
// Texto comparable sin mayúsculas ni acentos.
export const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
export function paginate<T>(items: T[], page: number, size: number) {
  const pages = Math.max(1, Math.ceil(items.length / size)),
    current = Math.min(Math.max(1, page), pages);
  return {
    items: items.slice((current - 1) * size, current * size),
    page: current,
    total: items.length,
  };
}
const PRESETS: [string, number | null][] = [
  ["Hoy", 0],
  ["7 días", 6],
  ["30 días", 29],
  ["Todo", null],
];
function preset(days: number | null): Range {
  if (days === null) return ANY_RANGE;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return { from: ymd(d), to: ymd(new Date()) };
}
export function DateRange(p: {
  id: string;
  value: Range;
  onChange: (r: Range) => void;
}) {
  const { value } = p;
  const wrong = Boolean(value.from && value.to && value.from > value.to);
  return (
    <div className="daterange" role="group" aria-label="Fechas">
      <div className="daterange-presets">
        {PRESETS.map(([label, days]) => {
          const r = preset(days);
          return (
            <button
              type="button"
              key={label}
              aria-pressed={r.from === value.from && r.to === value.to}
              onClick={() => p.onChange(r)}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="daterange-inputs">
        <label htmlFor={p.id + "-from"}>Desde</label>
        <input
          id={p.id + "-from"}
          type="date"
          value={value.from}
          max={value.to || undefined}
          onChange={(e) => p.onChange({ ...value, from: e.target.value })}
        />
        <label htmlFor={p.id + "-to"}>hasta</label>
        <input
          id={p.id + "-to"}
          type="date"
          value={value.to}
          min={value.from || undefined}
          onChange={(e) => p.onChange({ ...value, to: e.target.value })}
        />
      </div>
      {wrong && (
        <small className="daterange-error" role="alert">
          La fecha de inicio es posterior a la de fin.
        </small>
      )}
    </div>
  );
}
export function SearchInput(p: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="searchbox">
      <Search size={15} aria-hidden />
      <label htmlFor={p.id} className="sr-only">
        {p.label}
      </label>
      <input
        id={p.id}
        type="search"
        value={p.value}
        placeholder={p.placeholder}
        onChange={(e) => p.onChange(e.target.value)}
      />
      {p.value && (
        <button
          type="button"
          className="icon"
          aria-label="Borrar búsqueda"
          onClick={() => p.onChange("")}
        >
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
// Fila de filtros. Con alguno puesto aparece "Quitar filtros" y el recuento.
export function FilterBar(p: {
  children: React.ReactNode;
  active: boolean;
  onClear: () => void;
  summary?: React.ReactNode;
}) {
  return (
    <div className="filterbar">
      <div className="filterbar-controls">{p.children}</div>
      {(p.active || p.summary) && (
        <div className="filterbar-foot">
          {p.summary && <span className="muted">{p.summary}</span>}
          {p.active && (
            <button type="button" className="link" onClick={p.onClear}>
              Quitar filtros
            </button>
          )}
        </div>
      )}
    </div>
  );
}
function pageList(page: number, pages: number) {
  const shown = [...new Set([1, pages, page - 1, page, page + 1])]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  shown.forEach((n, i) => {
    if (i && n - shown[i - 1] > 1) out.push("…");
    out.push(n);
  });
  return out;
}
export function Pagination(p: {
  label: string;
  page: number;
  size: number;
  total: number;
  onPage: (page: number) => void;
  onSize?: (size: number) => void;
}) {
  const sizeId = useId();
  if (p.total === 0) return null;
  const pages = Math.max(1, Math.ceil(p.total / p.size)),
    first = (p.page - 1) * p.size + 1,
    last = Math.min(p.total, p.page * p.size);
  return (
    <div className="pagination" role="navigation" aria-label={p.label}>
      <span className="pagination-range num">
        {first}–{last} de {p.total}
      </span>
      {pages > 1 && (
        <div className="pagination-pages">
          <button
            type="button"
            className="icon"
            disabled={p.page <= 1}
            onClick={() => p.onPage(p.page - 1)}
            aria-label="Página anterior"
          >
            <ChevronLeft size={16} aria-hidden />
          </button>
          {pageList(p.page, pages).map((n, i) =>
            n === "…" ? (
              <span key={"hueco" + i} aria-hidden>
                …
              </span>
            ) : (
              <button
                type="button"
                key={n}
                className="num"
                aria-current={n === p.page ? "page" : undefined}
                aria-label={`Página ${n}`}
                onClick={() => p.onPage(n)}
              >
                {n}
              </button>
            ),
          )}
          <button
            type="button"
            className="icon"
            disabled={p.page >= pages}
            onClick={() => p.onPage(p.page + 1)}
            aria-label="Página siguiente"
          >
            <ChevronRight size={16} aria-hidden />
          </button>
        </div>
      )}
      {p.onSize && (
        <label className="pagination-size" htmlFor={sizeId}>
          Por página
          <select
            id={sizeId}
            value={p.size}
            onChange={(e) => p.onSize!(Number(e.target.value))}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
