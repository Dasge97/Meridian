import React, { useEffect, useRef, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Plus, ArrowUpRight } from "lucide-react";
import type { Lesson } from "../../src/domain";
import type { ViewProps } from "./types";
import { date, Empty } from "../shared";
import { Badge, Meter, Confirm, Sheet, Stat } from "../ui";
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
import { Counter, versionNumbers } from "./settings-counter";
import { decisionType } from "./decisions-intent";
import "./learning.css";

// Mismo tope que MAX_ACTIVE_LESSONS en src/domain.ts.
const MAX_ACTIVE = 15;
const TABS: [Lesson["status"] | "all", string][] = [
  ["accepted", "Activas"],
  ["proposed", "Propuestas"],
  ["retired", "Retiradas"],
  ["rejected", "Descartadas"],
  ["all", "Todas"],
];

// Las revisiones guardan como fuente el identificador de la decisión: no dice
// nada a quien lo lee.
const isId = (text: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(text.trim());
// Mismo nombre que en Decisiones.
function decisionLabel(d: ViewProps["s"]["decisions"][number]) {
  return `${decisionType(d).text} · ${d.proposal.symbol ?? "mercado"} · ${date(d.at)}`;
}
function LessonCard({ l, p }: { l: Lesson; p: ViewProps }) {
  const { s, busy, act } = p;
  const origin = l.decisionId
    ? s.decisions.find((d) => d.id === l.decisionId)
    : undefined;
  const source = isId(l.source)
    ? "Revisión de una operación del agente"
    : l.source;
  const numbers = versionNumbers(s.versions);
  const inVersions = s.versions.filter((v) => v.lessonIds.includes(l.id));
  const active = s.lessons.filter((x) => x.status === "accepted").length;
  return (
    <article className="ln-card" aria-labelledby={"ln-" + l.id}>
      <div className="ln-top">
        <Badge value={l.status} />
        <time dateTime={l.createdAt}>{date(l.createdAt)}</time>
      </div>
      <h3 id={"ln-" + l.id}>{l.title}</h3>
      <p className="preserve ln-body">{l.body}</p>
      <dl className="ln-meta">
        <div>
          <dt>Fuente</dt>
          <dd className="source">{source}</dd>
        </div>
        {l.decisionId && (
          <div>
            <dt>Decisión de origen</dt>
            <dd>
              {origin ? (
                <button
                  type="button"
                  className="link ln-origin"
                  onClick={() => p.openDecision(origin)}
                >
                  {decisionLabel(origin)}
                  <ArrowUpRight size={14} aria-hidden />
                </button>
              ) : (
                <span className="muted">
                  Ya no está entre las decisiones recientes.
                </span>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>Versiones que la incluyen</dt>
          <dd>
            {inVersions.length ? (
              <span className="ln-versions">
                {inVersions.map((v) => (
                  <span
                    key={v.id}
                    className={
                      "ln-version num" + (v.id === s.activeVersion ? " on" : "")
                    }
                    title={v.note}
                  >
                    v{numbers.get(v.id)}
                    {v.id === s.activeVersion ? " · activa" : ""}
                  </span>
                ))}
              </span>
            ) : (
              <span className="muted">Ninguna</span>
            )}
          </dd>
        </div>
      </dl>
      <div className="ln-actions">
        {l.status !== "accepted" && active >= MAX_ACTIVE && (
          <small>Ya hay {MAX_ACTIVE} activas. Esta sumaría una más.</small>
        )}
        {l.status !== "rejected" && (
          <Confirm
            title="¿Descartar esta lección?"
            description={
              <>
                <p>«{l.title}» sale de la memoria del agente.</p>
                <p>
                  Se crea una versión nueva sin ella. Puedes volver a activarla
                  después.
                </p>
              </>
            }
            action="Descartar lección"
            danger
            onConfirm={() =>
              act(p.api(`/lessons/${l.id}/status`), { status: "rejected" })
            }
          >
            <button type="button" className="danger" disabled={busy}>
              Descartar
            </button>
          </Confirm>
        )}
        {l.status !== "accepted" && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              act(p.api(`/lessons/${l.id}/status`), { status: "accepted" })
            }
          >
            Activar en nueva versión
          </button>
        )}
      </div>
    </article>
  );
}

function AddLesson(
  p: ViewProps & { open: boolean; setOpen: (o: boolean) => void },
) {
  const [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [source, setSource] = useState("");
  const valid =
    title.length >= 3 &&
    title.length <= 150 &&
    body.length >= 10 &&
    body.length <= 4000 &&
    source.length >= 3 &&
    source.length <= 1000;
  return (
    <Sheet
      open={p.open}
      onOpenChange={p.setOpen}
      title="Aportar conocimiento"
      subtitle="Entra directamente en la memoria activa y crea una versión nueva."
    >
      <form
        className="ln-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await p.act(p.api("/lessons"), { title, body, source })) {
            setTitle("");
            setBody("");
            setSource("");
            p.setOpen(false);
          }
        }}
      >
        <div className="ln-field">
          <div className="ln-label">
            <label htmlFor="ln-title">Título</label>
            <Counter
              id="ln-title-count"
              length={title.length}
              min={3}
              max={150}
            />
          </div>
          <input
            id="ln-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            minLength={3}
            maxLength={150}
            required
            aria-describedby="ln-title-count"
            placeholder="Una regla breve y concreta"
          />
        </div>
        <div className="ln-field">
          <div className="ln-label">
            <label htmlFor="ln-body">Lección, contexto y excepciones</label>
            <Counter
              id="ln-body-count"
              length={body.length}
              min={10}
              max={4000}
            />
          </div>
          <textarea
            id="ln-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            minLength={10}
            maxLength={4000}
            rows={9}
            required
            aria-describedby="ln-body-count ln-body-help"
          />
          <small id="ln-body-help" className="ln-help">
            Explica cuándo se aplica y cuándo no. El agente la lee tal cual.
          </small>
        </div>
        <div className="ln-field">
          <div className="ln-label">
            <label htmlFor="ln-source">Fuente o referencia</label>
            <Counter
              id="ln-source-count"
              length={source.length}
              min={3}
              max={1000}
            />
          </div>
          <input
            id="ln-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            minLength={3}
            maxLength={1000}
            required
            aria-describedby="ln-source-count"
            placeholder="URL, libro, experiencia documentada…"
          />
        </div>
        <div className="ln-form-actions">
          <button type="button" onClick={() => p.setOpen(false)}>
            Cancelar
          </button>
          <button className="primary" disabled={p.busy || !valid}>
            Añadir a su memoria
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function Learning(p: ViewProps) {
  const { s } = p;
  const lessons = [...s.lessons].reverse();
  const count = (st: string) =>
    st === "all"
      ? lessons.length
      : lessons.filter((l) => l.status === st).length;
  const active = count("accepted"),
    proposed = count("proposed");
  const [tab, setTab] = useState<string>(active ? "accepted" : "all");
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState(""),
    [range, setRange] = useState<Range>(ANY_RANGE),
    [pages, setPages] = useState<Record<string, number>>({}),
    [size, setSize] = useState(25);
  const top = useRef<HTMLElement>(null);
  const v = s.versions.find((x) => x.id === s.activeVersion);
  const numbers = versionNumbers(s.versions);
  const free = MAX_ACTIVE - active;
  const tabs = TABS.filter(([k]) => k !== "proposed" || proposed > 0);
  const current = tabs.some(([k]) => k === tab) ? tab : "all";
  // Los recuentos de las pestañas siguen a los filtros; la capacidad, no.
  const needle = fold(q.trim()),
    filtering = q !== "" || rangeActive(range),
    filtered = lessons.filter(
      (l) =>
        inRange(l.createdAt, range) &&
        (!needle || fold(`${l.title} ${l.body} ${l.source}`).includes(needle)),
    ),
    inTab = (k: string) =>
      k === "all" ? filtered : filtered.filter((l) => l.status === k),
    pg = paginate(inTab(current), pages[current] ?? 1, size);
  // Tras descartar o activar, la última página que exista.
  useEffect(() => {
    if (pg.page !== (pages[current] ?? 1))
      setPages((x) => ({ ...x, [current]: pg.page }));
  }, [pg.page, current, pages]);
  const filter =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPages({});
    };
  const clear = () => {
    setQ("");
    setRange(ANY_RANGE);
    setPages({});
  };
  return (
    <div className="ln-layout">
      <div className="ln-side" role="region" aria-label="Estado de la memoria">
        <section className="panel ln-capacity">
          <div className="group-title">
            <h2>Capacidad de la memoria</h2>
            {v && <span>versión {numbers.get(v.id)} activa</span>}
          </div>
          <div className="ln-count">
            <strong className="num">{active}</strong>
            <span className="num">/ {MAX_ACTIVE}</span>
            <span>lecciones activas</span>
          </div>
          <Meter
            value={active}
            max={MAX_ACTIVE}
            label={`${active} lecciones activas de ${MAX_ACTIVE}`}
          />
          <p className="ln-capacity-text">
            {free > 0
              ? `Caben ${free} más. Al pasar de ${MAX_ACTIVE}, se retira la más antigua.`
              : "Memoria llena. La próxima lección retira la más antigua."}
          </p>
          <div className={"stats " + (proposed ? "ln-three" : "two")}>
            <Stat label="Retiradas" value={String(count("retired"))} />
            <Stat label="Descartadas" value={String(count("rejected"))} />
            {proposed > 0 && (
              <Stat label="Propuestas" value={String(proposed)} />
            )}
          </div>
          {v && (
            <p className="ln-version-note">
              <span className="muted">Último cambio · {date(v.createdAt)}</span>
              {v.note}
            </p>
          )}
          <button
            type="button"
            className="primary ln-add"
            onClick={() => setAdding(true)}
          >
            <Plus size={16} aria-hidden /> Aportar conocimiento
          </button>
        </section>
        <section className="panel ln-how">
          <h2>Cómo aprende</h2>
          <ol>
            <li>Revisa las operaciones que llegaron a enviar una orden.</li>
            <li>De cada revisión puede salir una lección.</li>
            <li>La lección entra sola en la memoria activa.</li>
            <li>Lo que aportas tú también entra directamente.</li>
            <li>
              Cada cambio crea una versión. Puedes recuperar una anterior en{" "}
              <button
                type="button"
                className="link"
                onClick={() => p.goTo("Configuración")}
              >
                Configuración
              </button>
              .
            </li>
          </ol>
        </section>
      </div>
      <section className="panel ln-main">
        <div className="section-title">
          <h2>Lecciones</h2>
          <span className="muted">
            {lessons.length} en total · más recientes primero
          </span>
        </div>
        {!lessons.length ? (
          <Empty>
            Aquí se reunirán las lecciones de sus revisiones y el conocimiento
            que tú aportes.
          </Empty>
        ) : (
          <>
            <FilterBar
              active={filtering}
              onClear={clear}
              summary={
                filtering ? (
                  <>
                    <span className="num">{filtered.length}</span> de{" "}
                    <span className="num">{lessons.length}</span>
                  </>
                ) : undefined
              }
            >
              <SearchInput
                id="ln-q"
                label="Buscar lecciones"
                placeholder="Título, texto o fuente"
                value={q}
                onChange={filter(setQ)}
              />
              <DateRange
                id="ln-fechas"
                value={range}
                onChange={filter(setRange)}
              />
            </FilterBar>
            <Tabs.Root value={current} onValueChange={setTab}>
              <Tabs.List className="tabs" aria-label="Lecciones por estado">
                {tabs.map(([k, label]) => (
                  <Tabs.Trigger key={k} value={k}>
                    {label} <small className="num">{inTab(k).length}</small>
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
              {tabs.map(([k, label]) => (
                <Tabs.Content key={k} value={k} className="ln-list">
                  {k !== current ? null : pg.items.length ? (
                    <>
                      {pg.items.map((l) => (
                        <LessonCard key={l.id} l={l} p={p} />
                      ))}
                      <Pagination
                        label={`Páginas de lecciones ${label.toLowerCase()}`}
                        page={pg.page}
                        size={size}
                        total={pg.total}
                        onPage={(n) => {
                          setPages((x) => ({ ...x, [k]: n }));
                          const el = top.current;
                          if (el && el.getBoundingClientRect().top < 0)
                            el.scrollIntoView({ block: "start" });
                        }}
                        onSize={filter(setSize)}
                      />
                    </>
                  ) : filtering ? (
                    <div className="ln-none">
                      <Empty>Ninguna lección con estos filtros.</Empty>
                      <button type="button" onClick={clear}>
                        Quitar filtros
                      </button>
                    </div>
                  ) : (
                    <Empty>No hay lecciones {label.toLowerCase()}.</Empty>
                  )}
                </Tabs.Content>
              ))}
            </Tabs.Root>
          </>
        )}
      </section>
      <AddLesson {...p} open={adding} setOpen={setAdding} />
    </div>
  );
}
