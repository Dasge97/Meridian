// Historial de vigilancias: filtros y paginación en el navegador.
import React, { useEffect, useRef, useState } from "react";
import type { Watch } from "../../src/domain";
import type { ViewProps } from "./types";
import { money, date, Empty } from "../shared";
import { Badge, labels } from "../ui";
import {
  ANY_RANGE,
  DateRange,
  FilterBar,
  Pagination,
  SearchInput,
  fold,
  inRange,
  paginate,
  rangeActive,
  type Range,
} from "../listing";
import { Origin } from "./watches-card";
import { sign } from "./watches-parts";

const STATUSES = ["triggered", "expired", "invalidated", "cancelled"];

export const symbolsOf = (list: Watch[]) =>
  [...new Set(list.map((w) => w.symbol))].sort();

export function NoMatches(p: { what: string; onClear: () => void }) {
  return (
    <div className="wt-none">
      <Empty>{p.what} con estos filtros.</Empty>
      <button type="button" onClick={p.onClear}>
        Quitar filtros
      </button>
    </div>
  );
}

export function WatchHistory({
  history,
  view,
}: {
  history: Watch[];
  view: ViewProps;
}) {
  const [q, setQ] = useState(""),
    [range, setRange] = useState<Range>(ANY_RANGE),
    [status, setStatus] = useState("all"),
    [symbol, setSymbol] = useState(""),
    [origin, setOrigin] = useState("all"),
    [page, setPage] = useState(1),
    [size, setSize] = useState(25);
  const top = useRef<HTMLElement>(null);
  const filter =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };
  const needle = fold(q.trim());
  const base = history.filter(
    (w) =>
      inRange(w.createdAt, range) &&
      (!symbol || w.symbol === symbol) &&
      (origin === "all" || (origin === "agent") === Boolean(w.decisionId)) &&
      (!needle || fold(`${w.symbol} ${w.reason}`).includes(needle)),
  );
  const shown =
    status === "all" ? base : base.filter((w) => w.status === status);
  const pg = paginate(shown, page, size);
  // Si la lista encoge, se queda en la última página que existe.
  useEffect(() => {
    if (pg.page !== page) setPage(pg.page);
  }, [pg.page, page]);
  const active =
    q !== "" ||
    rangeActive(range) ||
    status !== "all" ||
    symbol !== "" ||
    origin !== "all";
  const clear = () => {
    setQ("");
    setRange(ANY_RANGE);
    setStatus("all");
    setSymbol("");
    setOrigin("all");
    setPage(1);
  };
  const symbols = symbolsOf(history);
  if (symbol && !symbols.includes(symbol)) symbols.push(symbol);
  return (
    <section className="panel wt-history" ref={top}>
      {history.length ? (
        <>
          <FilterBar
            active={active}
            onClear={clear}
            summary={
              active ? (
                <>
                  <span className="num">{shown.length}</span> de{" "}
                  <span className="num">{history.length}</span>
                </>
              ) : undefined
            }
          >
            <SearchInput
              id="wt-h-q"
              label="Buscar en el historial"
              placeholder="Activo o motivo"
              value={q}
              onChange={filter(setQ)}
            />
            <DateRange
              id="wt-h-fechas"
              value={range}
              onChange={filter(setRange)}
            />
            <div className="wt-status" role="group" aria-label="Estado">
              {["all", ...STATUSES].map((k) => (
                <button
                  type="button"
                  key={k}
                  id={"wt-h-estado-" + k}
                  aria-pressed={status === k}
                  onClick={() => filter(setStatus)(k)}
                >
                  {k === "all" ? "Todas" : labels[k]}{" "}
                  <small className="num">
                    {k === "all"
                      ? base.length
                      : base.filter((w) => w.status === k).length}
                  </small>
                </button>
              ))}
            </div>
            <div className="wt-select">
              <label htmlFor="wt-h-activo">Activo</label>
              <select
                id="wt-h-activo"
                value={symbol}
                onChange={(e) => filter(setSymbol)(e.target.value)}
              >
                <option value="">Todos</option>
                {symbols.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </div>
            <div className="wt-select">
              <label htmlFor="wt-h-origen">Origen</label>
              <select
                id="wt-h-origen"
                value={origin}
                onChange={(e) => filter(setOrigin)(e.target.value)}
              >
                <option value="all">Todos</option>
                <option value="agent">Agente</option>
                <option value="owner">Tú</option>
              </select>
            </div>
          </FilterBar>
          {pg.items.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Estado</th>
                    <th scope="col">Condición</th>
                    <th scope="col">Invalidación</th>
                    <th scope="col">Creada</th>
                    <th scope="col">Caducidad</th>
                    <th scope="col">Origen</th>
                    <th scope="col">Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {pg.items.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <Badge value={w.status} />
                      </td>
                      <td className="num wt-cond">
                        <b>{w.symbol}</b> {sign(w.operator)} {money(w.price)}
                      </td>
                      <td className="num">
                        {[
                          w.invalidateBelow !== null &&
                            "≤ " + money(w.invalidateBelow),
                          w.invalidateAbove !== null &&
                            "≥ " + money(w.invalidateAbove),
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                      <td className="num">{date(w.createdAt)}</td>
                      <td className="num">{date(w.expiresAt)}</td>
                      <td>
                        <Origin w={w} view={view} />
                      </td>
                      <td className="wt-why" title={w.reason}>
                        {w.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <NoMatches what="Ninguna vigilancia" onClear={clear} />
          )}
          <Pagination
            label="Páginas del historial"
            page={pg.page}
            size={size}
            total={shown.length}
            onPage={(n) => {
              setPage(n);
              const el = top.current;
              if (el && el.getBoundingClientRect().top < 0)
                el.scrollIntoView({ block: "start" });
            }}
            onSize={filter(setSize)}
          />
        </>
      ) : (
        <Empty>
          Aquí quedarán las vigilancias activadas, caducadas, invalidadas o
          canceladas.
        </Empty>
      )}
    </section>
  );
}
