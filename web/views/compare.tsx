// Vista Comparar: las dos simulaciones en el mismo periodo, con los mismos
// precios, noticias y límites. Solo cambia el nivel de riesgo.
import React, { useEffect, useState } from "react";
import {
  Info,
  LoaderCircle,
  RotateCw,
  Trophy,
  TriangleAlert,
  Equal,
} from "lucide-react";
import type { ViewProps } from "./types";
import { money, date, Empty } from "../shared";
import { Chip } from "../ui";
import { CompareChart } from "./compare-chart";
import { CompareTable } from "./compare-table";
import {
  riskLabel,
  signedMoney,
  leaderOf,
  identity,
  whole,
  SimKey,
  type CompareResponse,
} from "./compare-parts";
import type { SimId } from "../../src/sims";
import "./compare.css";

export type { CompareResponse } from "./compare-parts";
export { CompareChart } from "./compare-chart";
export { CompareTable } from "./compare-table";

export const COMPARE_PERIODS = [
  { key: "all", label: "Desde que empezaron", days: null },
  { key: "30d", label: "30 días", days: 30 },
  { key: "7d", label: "7 días", days: 7 },
] as const;
export type ComparePeriod = (typeof COMPARE_PERIODS)[number]["key"];
export const COMPARE_REFRESH_MS = 60000;

// Parámetros de GET /api/compare. Sin from, el servidor empieza en el inicio de
// la comparación.
export function compareQuery(period: ComparePeriod, now = Date.now()) {
  const days = COMPARE_PERIODS.find((x) => x.key === period)?.days ?? null;
  return days === null
    ? ""
    : "?" +
        new URLSearchParams({
          from: new Date(now - days * 86400000).toISOString(),
        });
}

// Lo justo para no pintar algo que no es una comparación.
function isCompare(x: unknown): x is CompareResponse {
  const d = x as CompareResponse | null;
  return Boolean(
    d &&
    Array.isArray(d.sims) &&
    d.bySim &&
    d.series &&
    Array.isArray(d.series.at) &&
    d.sims.every((id) => d.bySim[id] && d.series.indexed?.[id]),
  );
}

function SimCard(p: {
  data: CompareResponse;
  id: SimId;
  index: number;
  current: boolean;
}) {
  const x = p.data.bySim[p.id],
    r = x.result,
    lead = leaderOf(p.data),
    ahead = lead?.id === p.id,
    tie = lead !== null && lead.id === null;
  const titleId = `cmp-card-${p.id}`;
  return (
    <article
      className={"cmp-card" + (ahead ? " lead" : "")}
      aria-labelledby={titleId}
      style={
        {
          "--cmp-color": `var(${identity(p.id, p.index).color})`,
        } as React.CSSProperties
      }
    >
      <div className="cmp-card-head">
        <div className="cmp-card-name">
          <SimKey id={p.id} index={p.index} />
          <div>
            <h2 id={titleId}>{x.label}</h2>
            <small>
              Nivel {riskLabel(x.riskProfile)}
              {p.current && " · la que estás viendo"}
            </small>
          </div>
        </div>
        {ahead ? (
          <span className="cmp-flag lead">
            <Trophy size={14} aria-hidden />
            Va por delante
          </span>
        ) : tie ? (
          <span className="cmp-flag">
            <Equal size={14} aria-hidden />
            Empatadas
          </span>
        ) : lead ? (
          <span className="cmp-flag">
            Por detrás en <span className="num">{money(lead.gap)}</span>
          </span>
        ) : null}
      </div>
      <div className="cmp-result">
        <span className="cmp-label">Resultado del periodo</span>
        <span className="cmp-result-row">
          <strong
            className={
              "num cmp-usd " +
              (r.usd === null || r.usd === 0 ? "" : r.usd > 0 ? "up" : "down")
            }
          >
            {signedMoney(r.usd)}
          </strong>
          <Chip value={r.pct} />
        </span>
      </div>
      <dl className="cmp-facts">
        <div>
          <dt>Patrimonio actual</dt>
          <dd className="num">{money(r.equityNow)}</dd>
        </div>
        <div>
          <dt>Al empezar el periodo</dt>
          <dd className="num">{money(r.equityStart)}</dd>
        </div>
        <div>
          <dt>Realizado</dt>
          <dd className="num">{signedMoney(r.realizedPl)}</dd>
        </div>
        <div>
          <dt>No realizado</dt>
          <dd className="num">{signedMoney(r.unrealizedPl)}</dd>
        </div>
      </dl>
    </article>
  );
}

// Avisos sobre lo que no entra en la tasa de acierto.
function Notes({ data }: { data: CompareResponse }) {
  const notes = data.sims.flatMap((id) => {
    const t = data.bySim[id].trades,
      label = data.bySim[id].label,
      out: string[] = [];
    if (t.manual.orders > 0)
      out.push(
        `${label} incluye ${whole(t.manual.orders)} ${t.manual.orders === 1 ? "operación manual" : "operaciones manuales"}, fuera de la tasa de acierto.`,
      );
    if (t.unpricedSells > 0)
      out.push(
        `${label} tiene ${whole(t.unpricedSells)} ${t.unpricedSells === 1 ? "venta" : "ventas"} sin precio medio conocido, que no cuentan para el acierto.`,
      );
    return out;
  });
  if (!notes.length) return null;
  return (
    <ul className="cmp-notes">
      {notes.map((n) => (
        <li key={n}>
          <Info size={15} aria-hidden />
          {n}
        </li>
      ))}
    </ul>
  );
}

function Footnote({ data }: { data: CompareResponse }) {
  const started = data.sims
    .map((id) => data.bySim[id].startedAt)
    .filter((x): x is string => Boolean(x))
    .sort()
    .at(-1);
  return (
    <p className="cmp-footnote">
      {started ? (
        <>
          Las dos parten del mismo estado, copiado el{" "}
          <time className="num" dateTime={started}>
            {date(started)}
          </time>
          ,
        </>
      ) : (
        "Las dos parten del mismo estado"
      )}{" "}
      y comparten precios, noticias y límites. Solo cambia el nivel de riesgo.
    </p>
  );
}

function hasActivity(d: CompareResponse) {
  return (
    d.series.at.length > 0 ||
    d.sims.some((id) => {
      const x = d.bySim[id];
      return x.trades.orders || x.decisions.decisions || x.tokens.calls;
    })
  );
}

export function Compare(p: ViewProps) {
  const [period, setPeriod] = useState<ComparePeriod>("all"),
    [data, setData] = useState<CompareResponse | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);

  useEffect(() => {
    let ctrl: AbortController | null = null;
    const load = () => {
      ctrl?.abort();
      const c = (ctrl = new AbortController());
      setLoading(true);
      fetch("/api/compare" + compareQuery(period), { signal: c.signal })
        .then(async (r) => {
          const body = await r.json().catch(() => null);
          if (!r.ok)
            throw new Error(body?.error ?? "No se pudo cargar la comparación.");
          if (!isCompare(body))
            throw new Error(
              "La respuesta del servidor no tiene la forma esperada.",
            );
          setData(body);
          setError("");
        })
        .catch((e: Error) => {
          if (c.signal.aborted) return;
          setError(
            e instanceof TypeError
              ? "Sin conexión con el servidor. No se pudo cargar la comparación."
              : e.message,
          );
        })
        .finally(() => {
          if (!c.signal.aborted) setLoading(false);
        });
    };
    load();
    // Con la pestaña oculta no se pide: al volver llega en el siguiente turno.
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, COMPARE_REFRESH_MS);
    return () => {
      clearInterval(t);
      ctrl?.abort();
    };
  }, [period, retry]);

  return (
    <div className="cmp">
      <div className="cmp-toolbar">
        <div
          className="filters"
          role="group"
          aria-label="Periodo de la comparación"
        >
          {COMPARE_PERIODS.map((x) => (
            <button
              type="button"
              key={x.key}
              aria-pressed={period === x.key}
              onClick={() => setPeriod(x.key)}
            >
              {x.label}
            </button>
          ))}
        </div>
        <span className="muted cmp-since">
          {loading && <LoaderCircle className="spin" size={14} aria-hidden />}
          {data?.from ? (
            <>
              Desde el{" "}
              <time className="num" dateTime={data.from}>
                {date(data.from)}
              </time>
            </>
          ) : data ? (
            "Todo el historial"
          ) : null}
          {" · se actualiza cada minuto"}
        </span>
      </div>

      <p className="sr-only" role="status">
        {loading
          ? "Cargando la comparación"
          : data
            ? "Comparación cargada"
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
          <p className="cmp-loading muted">
            <LoaderCircle className="spin" size={16} aria-hidden />
            Cargando la comparación…
          </p>
        )
      ) : !data.sims.length || !hasActivity(data) ? (
        <section className="panel">
          <Empty>
            {data.sims.length
              ? "Aún no hay patrimonio, órdenes ni llamadas en este periodo. Prueba con un periodo más largo o vuelve cuando las simulaciones hayan trabajado."
              : "No hay simulaciones que comparar."}
          </Empty>
        </section>
      ) : (
        <div
          className={"cmp-body" + (loading ? " cmp-stale" : "")}
          aria-busy={loading}
        >
          {data.sims.length < 2 && (
            <div className="banner">
              <Info size={18} aria-hidden />
              <p>
                Solo hay una simulación. La comparación estará completa cuando
                exista la segunda.
              </p>
            </div>
          )}
          <section className="cmp-cards" aria-label="Resultado de cada una">
            {data.sims.map((id, i) => (
              <SimCard
                key={id}
                data={data}
                id={id}
                index={i}
                current={p.sim === id}
              />
            ))}
          </section>

          <section className="panel" aria-labelledby="cmp-chart-title">
            <div className="section-title">
              <h2 id="cmp-chart-title">Patrimonio comparado</h2>
              <span className="muted">índice 100 al empezar el periodo</span>
            </div>
            <CompareChart data={data} />
          </section>

          <section className="panel" aria-labelledby="cmp-table-title">
            <div className="section-title">
              <h2 id="cmp-table-title">Métricas del periodo</h2>
              <span className="muted">
                órdenes del agente, sin las manuales
              </span>
            </div>
            <Notes data={data} />
            <CompareTable data={data} />
          </section>

          <Footnote data={data} />
        </div>
      )}
    </div>
  );
}
