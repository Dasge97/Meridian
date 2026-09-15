// Línea de tiempo de versiones: la activa fijada arriba y el resto con
// búsqueda en la nota, fechas y paginación en el navegador.
import React, { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { Version } from "../../src/domain";
import type { ViewProps } from "./types";
import { date, Empty } from "../shared";
import { Confirm } from "../ui";
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
import { versionNumbers } from "./settings-counter";

const PAGE = 10;

function VersionItem(p: { x: Version; view: ViewProps; n: number }) {
  const { x, n } = p,
    { s, busy, act } = p.view,
    active = x.id === s.activeVersion,
    prev = s.versions[n - 2];
  return (
    <li className={active ? "on" : undefined}>
      <span className="st-dot" aria-hidden="true" />
      <div className="st-ver-head">
        <strong>Versión {n}</strong>
        {active && <span className="st-active">Activa</span>}
        <time dateTime={x.createdAt} className="num">
          {date(x.createdAt)}
        </time>
      </div>
      <p>{x.note}</p>
      <div className="st-ver-foot">
        <small>
          <span className="num">{x.lessonIds.length}</span>{" "}
          {x.lessonIds.length === 1 ? "lección" : "lecciones"}
          {prev && prev.instructions !== x.instructions
            ? " · instrucciones nuevas"
            : ""}
        </small>
        {!active && (
          <Confirm
            title={`¿Recuperar la versión ${n}?`}
            description={
              <>
                <p>
                  Vuelven sus instrucciones y sus {x.lessonIds.length} lecciones
                  activas.
                </p>
                <p>
                  Las lecciones activas que no estaban en ella pasan a
                  propuestas. No se borra ninguna versión.
                </p>
              </>
            }
            action="Recuperar versión"
            onConfirm={() => act(`/versions/${x.id}/activate`)}
          >
            <button type="button" className="st-restore" disabled={busy}>
              <RotateCcw size={14} aria-hidden /> Recuperar
            </button>
          </Confirm>
        )}
      </div>
    </li>
  );
}

export function Versions(p: ViewProps) {
  const { s } = p;
  const [q, setQ] = useState(""),
    [range, setRange] = useState<Range>(ANY_RANGE),
    [page, setPage] = useState(1);
  const top = useRef<HTMLElement>(null);
  const numbers = versionNumbers(s.versions);
  const current = s.versions.find((x) => x.id === s.activeVersion);
  const others = [...s.versions]
    .reverse()
    .filter((x) => x.id !== s.activeVersion);
  const needle = fold(q.trim()),
    filtering = q !== "" || rangeActive(range),
    shown = others.filter(
      (x) =>
        inRange(x.createdAt, range) &&
        (!needle || fold(x.note).includes(needle)),
    ),
    pg = paginate(shown, page, PAGE);
  useEffect(() => {
    if (pg.page !== page) setPage(pg.page);
  }, [pg.page, page]);
  const filter =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };
  const clear = () => {
    setQ("");
    setRange(ANY_RANGE);
    setPage(1);
  };
  return (
    <section className="panel st-versions" ref={top}>
      <div className="group-title">
        <h2>Versiones</h2>
        <span>
          <span className="num">{s.versions.length}</span> guardadas
        </span>
      </div>
      {current && (
        <ol className="st-timeline st-pinned" aria-label="Versión activa">
          <VersionItem x={current} view={p} n={numbers.get(current.id)!} />
        </ol>
      )}
      {others.length > 0 && (
        <>
          <h3 className="st-others">Otras versiones</h3>
          {(others.length > PAGE || filtering) && (
            <FilterBar
              active={filtering}
              onClear={clear}
              summary={
                filtering ? (
                  <>
                    <span className="num">{shown.length}</span> de{" "}
                    <span className="num">{others.length}</span>
                  </>
                ) : undefined
              }
            >
              <SearchInput
                id="st-ver-q"
                label="Buscar en las notas de las versiones"
                placeholder="Buscar en la nota"
                value={q}
                onChange={filter(setQ)}
              />
              <DateRange
                id="st-ver-fechas"
                value={range}
                onChange={filter(setRange)}
              />
            </FilterBar>
          )}
          {pg.items.length ? (
            <ol className="st-timeline">
              {pg.items.map((x) => (
                <VersionItem key={x.id} x={x} view={p} n={numbers.get(x.id)!} />
              ))}
            </ol>
          ) : (
            <div className="st-none">
              <Empty>Ninguna versión con estos filtros.</Empty>
              <button type="button" onClick={clear}>
                Quitar filtros
              </button>
            </div>
          )}
          {shown.length > PAGE && (
            <Pagination
              label="Páginas de versiones"
              page={pg.page}
              size={PAGE}
              total={shown.length}
              onPage={(n) => {
                setPage(n);
                const el = top.current;
                if (el && el.getBoundingClientRect().top < 0)
                  el.scrollIntoView({ block: "start" });
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
