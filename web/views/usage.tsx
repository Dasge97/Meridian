// Vista Uso: cuántos tokens gasta el modelo, en qué parte del mensaje y por qué.
import React, { useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCw, TriangleAlert } from "lucide-react";
import type { ViewProps } from "./types";
import { date, Empty } from "../shared";
import { Meter } from "../ui";
import {
  DateRange,
  FilterBar,
  Pagination,
  rangeQuery,
  type Range,
} from "../listing";
import {
  TRIGGERS,
  SECTIONS,
  sectionText,
  triggerText,
  kindText,
  tokens,
  share,
  plural,
  triggerOf,
  Status,
  Swatch,
  type TriggerKey,
  type UsageItem,
  type UsageKind,
  type UsagePage,
  type UsageSummary,
} from "./usage-parts";
import { DailyChart } from "./usage-chart";
import { CallDetail } from "./usage-detail";
import "./usage.css";

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Igual que el atajo "7 días" de DateRange, para que aparezca marcado.
function lastWeek(): Range {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return { from: ymd(d), to: ymd(new Date()) };
}

function Figures({ sum, s }: { sum: UsageSummary; s: ViewProps["s"] }) {
  const today = new Date().toISOString().slice(0, 10),
    calls = s.calls.day === today ? s.calls.count : 0,
    max = s.settings.maxDailyCalls,
    split = sum.promptTokens + sum.completionTokens;
  return (
    <section className="us-figures" aria-label="Cifras del periodo">
      <div className="stat us-lead-stat">
        <span>Tokens del periodo</span>
        <strong className="num">{tokens(sum.tokens)}</strong>
        <small>{plural(sum.calls, "llamada", "llamadas")}</small>
      </div>
      <div className="stat">
        <span>Media por llamada</span>
        <strong className="num">{tokens(sum.avgTokens)}</strong>
        <small>tokens</small>
      </div>
      <div className="stat">
        <span>Llamadas</span>
        <strong className="num">{tokens(sum.calls)}</strong>
        {sum.failed > 0 ? (
          <small className="us-bad">
            <TriangleAlert size={12} aria-hidden />
            {plural(sum.failed, "fallida", "fallidas")}
          </small>
        ) : (
          <small>ninguna fallida</small>
        )}
      </div>
      <div className="stat">
        <span>Entrada y respuesta</span>
        {split > 0 ? (
          <>
            <strong className="num">
              {share(sum.promptTokens, split)}
              <em> entrada</em>
            </strong>
            <span className="us-io" aria-hidden="true">
              <i className="us-part-a" style={{ flexGrow: sum.promptTokens }} />
              <i
                className="us-part-out"
                style={{ flexGrow: sum.completionTokens }}
              />
            </span>
            <small className="num">
              {tokens(sum.promptTokens)} entrada ·{" "}
              {tokens(sum.completionTokens)} respuesta
            </small>
          </>
        ) : (
          <>
            <strong className="num">—</strong>
            <small>Sin detalle en este periodo</small>
          </>
        )}
      </div>
      <div className="stat">
        <span>Llamadas hoy · UTC</span>
        <strong className="num">
          {calls}
          <em> / {max}</em>
        </strong>
        <Meter
          value={calls}
          max={max}
          label="Llamadas de hoy frente al máximo diario"
        />
        <small>
          {Math.max(0, max - calls)} disponibles. No depende de los filtros.
        </small>
      </div>
    </section>
  );
}

function Sections({ sum }: { sum: UsageSummary }) {
  const rows = SECTIONS.map(
      (k) =>
        sum.bySection.find((x) => x.section === k) ?? {
          section: k,
          tokens: 0,
          avgTokens: 0,
        },
    )
      .filter((x) => x.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens),
    total = rows.reduce((a, x) => a + x.tokens, 0),
    max = Math.max(1, ...rows.map((x) => x.avgTokens));
  return (
    <section className="panel us-where" aria-labelledby="us-where-title">
      <div className="section-title">
        <h2 id="us-where-title">Dónde se va la entrada</h2>
        <span className="muted">tokens medios por llamada</span>
      </div>
      {!sum.withBreakdown || !rows.length ? (
        <Empty>Las llamadas de este periodo son anteriores al desglose.</Empty>
      ) : (
        <>
          <p className="us-intro">
            Con este reparto ves qué recortar. Por ejemplo, menos noticias o
            menos decisiones recientes.
          </p>
          <ol className="us-bars">
            {rows.map((x) => (
              <li key={x.section}>
                <span className="us-bar-name">
                  {sectionText[x.section].label}
                  <small>{sectionText[x.section].hint}</small>
                </span>
                <span className="us-bar-track" aria-hidden="true">
                  <i style={{ width: `${(x.avgTokens / max) * 100}%` }} />
                </span>
                <span className="num us-bar-value">{tokens(x.avgTokens)}</span>
                <span className="num us-bar-share">
                  {share(x.tokens, total)}
                </span>
              </li>
            ))}
          </ol>
          <p className="us-footnote">
            Es una estimación. El proveedor solo da el total de entrada, así que
            se reparte según los caracteres de cada parte.
            {sum.withBreakdown < sum.calls &&
              ` Cuenta ${sum.withBreakdown} de ${sum.calls} llamadas: las demás no tienen desglose.`}
          </p>
        </>
      )}
    </section>
  );
}

function Triggers(p: {
  sum: UsageSummary;
  current: string;
  onPick: (t: TriggerKey | "") => void;
}) {
  const rows = [...p.sum.byTrigger]
      .filter((x) => x.calls > 0 || x.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens),
    max = Math.max(1, ...rows.map((x) => x.tokens));
  return (
    <section className="panel us-why" aria-labelledby="us-why-title">
      <div className="section-title">
        <h2 id="us-why-title">Por qué se provoca</h2>
        <span className="muted">tokens y llamadas</span>
      </div>
      <p className="us-intro">Pulsa un motivo para ver solo esas llamadas.</p>
      <ul className="us-why-list">
        {rows.map((x) => (
          <li key={x.trigger}>
            <button
              type="button"
              aria-pressed={p.current === x.trigger}
              onClick={() => p.onPick(p.current === x.trigger ? "" : x.trigger)}
            >
              <span className="us-why-name">
                <Swatch trigger={x.trigger} />
                <span>
                  {triggerText[x.trigger].label}
                  <small>{triggerText[x.trigger].hint}</small>
                </span>
              </span>
              <span className="us-why-nums">
                <span className="num">{tokens(x.tokens)}</span>
                <small className="num">
                  {plural(x.calls, "llamada", "llamadas")} ·{" "}
                  {share(x.tokens, p.sum.tokens)}
                </small>
              </span>
              <span className="us-bar-track" aria-hidden="true">
                <i
                  className={"us-c-" + x.trigger}
                  style={{ width: `${(x.tokens / max) * 100}%` }}
                />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Calls(p: { items: UsageItem[]; onOpen: (u: UsageItem) => void }) {
  return (
    <div className="table-wrap">
      <table className="us-table">
        <thead>
          <tr>
            <th scope="col">Hora</th>
            <th scope="col">Tipo</th>
            <th scope="col">Qué la provocó</th>
            <th scope="col">Entrada</th>
            <th scope="col">Respuesta</th>
            <th scope="col">Total</th>
            <th scope="col">Estado</th>
          </tr>
        </thead>
        <tbody>
          {p.items.map((u, i) => {
            const t = triggerOf(u);
            return (
              <tr
                key={u.at + i}
                className={u.ok === false ? "bad" : undefined}
                onClick={() => p.onOpen(u)}
              >
                <th scope="row">
                  <button
                    type="button"
                    className="us-open num"
                    aria-label={`Ver detalle de la llamada del ${date(u.at)}`}
                  >
                    {date(u.at)}
                  </button>
                </th>
                <td data-label="Tipo">{u.kind ? kindText[u.kind] : "—"}</td>
                <td data-label="Qué la provocó">
                  <span className="us-trigger">
                    <Swatch trigger={t} />
                    {triggerText[t].label}
                  </span>
                </td>
                <td data-label="Entrada" className="num">
                  {tokens(u.promptTokens)}
                </td>
                <td data-label="Respuesta" className="num">
                  {tokens(u.completionTokens)}
                </td>
                <td data-label="Total" className="num us-total">
                  {tokens(u.tokens)}
                </td>
                <td data-label="Estado" className="us-status">
                  <Status u={u} />
                  {u.ok === false && u.error && (
                    <small title={u.error}>{u.error}</small>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Usage(p: ViewProps) {
  const { s } = p;
  const [range, setRange] = useState<Range>(lastWeek),
    [kind, setKind] = useState<UsageKind | "">(""),
    [trigger, setTrigger] = useState<TriggerKey | "">(""),
    [page, setPage] = useState(1),
    [size, setSize] = useState(25),
    [data, setData] = useState<UsagePage | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [open, setOpen] = useState<UsageItem | null>(null),
    listRef = useRef<HTMLElement>(null),
    loaded = useRef(false);

  // Llega una llamada nueva: se vuelve a pedir.
  const latest = s.usage.at(-1)?.at ?? "";
  const wrongRange = Boolean(range.from && range.to && range.from > range.to);

  useEffect(() => {
    if (wrongRange) return;
    const params = rangeQuery(range);
    params.set("page", String(page));
    params.set("size", String(size));
    if (kind) params.set("kind", kind);
    if (trigger) params.set("trigger", trigger);
    const ctrl = new AbortController();
    // Espera breve para no pedir a cada cambio de fecha mientras se escribe.
    const t = setTimeout(
      () => {
        setLoading(true);
        fetch("/api" + p.api("/usage?" + params), { signal: ctrl.signal })
          .then(async (r) => {
            const body = await r.json().catch(() => null);
            if (!r.ok)
              throw new Error(body?.error ?? "No se pudo cargar el uso.");
            setData(body as UsagePage);
            setError("");
            loaded.current = true;
          })
          .catch((e: Error) => {
            if (ctrl.signal.aborted) return;
            setError(
              e instanceof TypeError
                ? "Sin conexión con el servidor. No se pudo cargar el uso."
                : e.message,
            );
          })
          .finally(() => {
            if (!ctrl.signal.aborted) setLoading(false);
          });
      },
      loaded.current ? 250 : 0,
    );
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [range, kind, trigger, page, size, latest, retry, wrongRange]);

  const week = lastWeek(),
    active = Boolean(
      range.from !== week.from || range.to !== week.to || kind || trigger,
    );
  function clear() {
    setRange(lastWeek());
    setKind("");
    setTrigger("");
    setPage(1);
  }
  const filter =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };
  function goToPage(n: number) {
    setPage(n);
    const top = listRef.current?.getBoundingClientRect().top;
    if (top !== undefined && top < 0)
      listRef.current?.scrollIntoView({ block: "start" });
  }

  const sum = data?.summary,
    present = TRIGGERS.filter((t) =>
      sum?.byTrigger.some((x) => x.trigger === t && x.tokens > 0),
    );

  return (
    <div className="us">
      <section className="panel us-filters" aria-label="Filtros">
        <FilterBar
          active={active}
          onClear={clear}
          summary={
            active && data
              ? `${plural(data.total, "llamada", "llamadas")} con estos filtros`
              : "Por defecto, los últimos 7 días."
          }
        >
          <DateRange id="us-range" value={range} onChange={filter(setRange)} />
          <div className="us-select">
            <label htmlFor="us-kind">Tipo</label>
            <select
              id="us-kind"
              value={kind}
              onChange={(e) => filter(setKind)(e.target.value as UsageKind)}
            >
              <option value="">Todos</option>
              <option value="decision">Evaluaciones</option>
              <option value="review">Revisiones</option>
            </select>
          </div>
          <div className="us-select">
            <label htmlFor="us-trigger">Qué la provocó</label>
            <select
              id="us-trigger"
              value={trigger}
              onChange={(e) => filter(setTrigger)(e.target.value as TriggerKey)}
            >
              <option value="">Cualquier motivo</option>
              {TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {triggerText[t].label}
                </option>
              ))}
            </select>
          </div>
        </FilterBar>
      </section>

      <p className="sr-only" role="status">
        {loading
          ? "Cargando el uso"
          : data
            ? `${plural(data.total, "llamada", "llamadas")}`
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

      {!data || !sum ? (
        !error && (
          <p className="us-loading muted">
            <LoaderCircle className="spin" size={16} aria-hidden />
            Cargando el uso…
          </p>
        )
      ) : (
        <div
          className={"us-body" + (loading ? " us-stale" : "")}
          aria-busy={loading}
        >
          <Figures sum={sum} s={s} />
          {!sum.calls ? (
            <section className="panel us-none-panel">
              {active ? (
                <>
                  <Empty>Ninguna llamada con estos filtros.</Empty>
                  <button type="button" onClick={clear}>
                    Quitar filtros
                  </button>
                </>
              ) : (
                <Empty>
                  {s.usage.length
                    ? "No hubo llamadas al modelo en los últimos 7 días. Prueba con 30 días o Todo."
                    : "Aparecerá tras la primera llamada al modelo."}
                </Empty>
              )}
            </section>
          ) : (
            <>
              <section className="panel" aria-labelledby="us-day-title">
                <div className="section-title">
                  <h2 id="us-day-title">Tokens por día</h2>
                  <span className="muted">día UTC · por qué se llamó</span>
                </div>
                <DailyChart days={sum.byDay} present={present} />
              </section>
              <div className="us-split">
                <Sections sum={sum} />
                <Triggers
                  sum={sum}
                  current={trigger}
                  onPick={filter(setTrigger)}
                />
              </div>
              <section
                className="panel us-list"
                aria-labelledby="us-list-title"
                ref={listRef}
              >
                <div className="section-title">
                  <h2 id="us-list-title">Llamadas</h2>
                  <span className="muted">
                    lo más reciente primero · pulsa una para ver el detalle
                  </span>
                </div>
                <Calls items={data.items} onOpen={setOpen} />
                <Pagination
                  label="Páginas de llamadas"
                  page={data.page}
                  size={data.size}
                  total={data.total}
                  onPage={goToPage}
                  onSize={filter(setSize)}
                />
              </section>
            </>
          )}
        </div>
      )}

      <CallDetail
        item={open}
        onClose={() => setOpen(null)}
        s={s}
        openDecision={p.openDecision}
        api={p.api}
      />
    </div>
  );
}
