import React, { useState } from "react";
import {
  ArrowRight,
  Eye,
  Info,
  Loader,
  Pause,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type { ViewProps, Data } from "./types";
import {
  money,
  date,
  clockTime,
  num,
  tone,
  marketOpen,
  marketText,
  Empty,
} from "../shared";
import { Chip, Sparkline, Meter, Hint } from "../ui";
import { EquityChart } from "./summary-chart";
import { EventItem } from "./summary-activity";
import { EventLog } from "./events";
import { riskProfileOf } from "../../src/risk";
import "./summary.css";

const today = () => new Date().toISOString().slice(0, 10);
const share = (part: number, total: number) =>
  total > 0 ? num((part / total) * 100, 1) + " %" : "—";

function Kpis({ s, goTo }: { s: Data; goTo: (tab: string) => void }) {
  const equity = s.account ? Number(s.account.equity) : null,
    delta = equity !== null && s.baseline ? equity - s.baseline : null,
    exposure = s.positions.reduce(
      (a, x) => a + Math.abs(Number(x.market_value) || 0),
      0,
    ),
    calls = s.calls.day === today() ? s.calls.count : 0,
    watches = s.watches.filter((w) => w.status === "active").length,
    lessons = s.lessons.filter((l) => l.status === "accepted").length;
  return (
    <section className="sm-kpis" aria-label="Indicadores clave">
      <div className="sm-kpi sm-kpi-equity">
        <span className="sm-kpi-label">Patrimonio simulado</span>
        <strong className="sm-kpi-value num">{money(s.account?.equity)}</strong>
        <Sparkline values={s.equity.slice(-120).map((x) => x.value)} />
        <small>Cuenta sincronizada {date(s.lastSync)}</small>
      </div>
      <div className="sm-kpi">
        <span className="sm-kpi-label">Variación desde el inicio</span>
        <strong className={"sm-kpi-value num sm-tone " + tone(delta)}>
          {delta !== null &&
            delta !== 0 &&
            (delta > 0 ? (
              <TrendingUp size={18} aria-hidden />
            ) : (
              <TrendingDown size={18} aria-hidden />
            ))}
          {delta !== null && delta > 0 ? "+" : ""}
          {money(delta)}
        </strong>
        <span className="sm-kpi-row">
          <Chip
            value={
              delta !== null && s.baseline ? (delta / s.baseline) * 100 : null
            }
          />
          <small>desde {money(s.baseline)}</small>
        </span>
        <small>Incluye cambios de mercado y de saldo</small>
      </div>
      <div className="sm-kpi">
        <span className="sm-kpi-label">
          Exposición
          <Hint label="Suma del valor de las posiciones abiertas frente al límite de exposición. Las cortas cuentan en positivo. Las compras pendientes también cuentan para el límite y no están aquí.">
            <button
              type="button"
              className="sm-info"
              aria-label="Qué es la exposición"
            >
              <Info size={13} aria-hidden />
            </button>
          </Hint>
        </span>
        <strong className="sm-kpi-value num">
          {money(exposure)}
          <em> / {money(s.settings.maxExposureUsd)}</em>
        </strong>
        <Meter
          value={exposure}
          max={s.settings.maxExposureUsd}
          label="Exposición frente al límite"
        />
        {exposure > s.settings.maxExposureUsd ? (
          <small className="sm-over">
            <TriangleAlert size={12} aria-hidden />
            {share(exposure, s.settings.maxExposureUsd)} del límite. Lo supera.
          </small>
        ) : (
          <small>{share(exposure, s.settings.maxExposureUsd)} del límite</small>
        )}
      </div>
      <div className="sm-kpi">
        <span className="sm-kpi-label">
          Evaluaciones hoy · UTC
          <Hint label="Llamadas al modelo en el día UTC. El contador vuelve a cero a medianoche UTC.">
            <button
              type="button"
              className="sm-info"
              aria-label="Cómo se cuentan las evaluaciones"
            >
              <Info size={13} aria-hidden />
            </button>
          </Hint>
        </span>
        <strong className="sm-kpi-value num">
          {calls}
          <em> / {s.settings.maxDailyCalls}</em>
        </strong>
        <Meter
          value={calls}
          max={s.settings.maxDailyCalls}
          label="Evaluaciones de hoy frente al máximo diario"
        />
        <small>
          {Math.max(0, s.settings.maxDailyCalls - calls)} disponibles
        </small>
      </div>
      <div className="sm-kpi sm-kpi-pair">
        <button type="button" onClick={() => goTo("Vigilancias")}>
          <span className="sm-kpi-label">Vigilancias activas</span>
          <strong className="sm-kpi-value num">
            {watches.toString().padStart(2, "0")}
          </strong>
        </button>
        <button type="button" onClick={() => goTo("Aprendizaje")}>
          <span className="sm-kpi-label">Lecciones activas</span>
          <strong className="sm-kpi-value num">
            {lessons.toString().padStart(2, "0")}
          </strong>
        </button>
      </div>
    </section>
  );
}

function AgentState({ s }: { s: Data }) {
  const alive = Boolean(
      s.heartbeat && Date.now() - Date.parse(s.heartbeat) < 120000,
    ),
    job = s.modelJob,
    open = marketOpen(s),
    risk = riskProfileOf(s.settings);
  const state: {
    key: string;
    title: string;
    text: string;
    Icon: LucideIcon;
  } = s.paused
    ? {
        key: "paused",
        title: "En pausa",
        text: "Actívalo cuando hayas revisado los límites y las conexiones.",
        Icon: Pause,
      }
    : !alive
      ? {
          key: "offline",
          title: "Sin señal del worker",
          text: "No ha dado señal en los últimos dos minutos. Mientras tanto no vigila precios ni evalúa.",
          Icon: WifiOff,
        }
      : job
        ? {
            key: "working",
            title: "Trabajando",
            text:
              (job.kind === "review"
                ? "Revisa una decisión pasada"
                : "Evalúa una decisión") +
              " desde las " +
              clockTime(job.startedAt) +
              ".",
            Icon: Loader,
          }
        : {
            key: "watching",
            title: "Observando",
            text: s.queue.length
              ? "Tiene algo que revisar. Lo evaluará en cuanto pueda."
              : "Espera una condición. La vigilancia funciona sin consultar al modelo en cada cambio de precio.",
            Icon: Eye,
          };
  return (
    <section className="panel sm-agent" aria-labelledby="sm-agent-title">
      <div className="section-title">
        <h2 id="sm-agent-title">Estado del agente</h2>
        <span className="muted">
          {s.connection.modelName ?? "Modelo sin configurar"}
        </span>
      </div>
      <div className={"sm-state " + state.key}>
        <span className="sm-state-icon" aria-hidden="true">
          <state.Icon
            size={20}
            className={state.key === "working" ? "sm-spin" : ""}
          />
        </span>
        <div>
          <strong>{state.title}</strong>
          <p>{state.text}</p>
        </div>
      </div>
      <dl className="sm-facts">
        <div>
          <dt>Conexión de mercado</dt>
          {/* Con la bolsa cerrada no llegan precios: no es un fallo. */}
          <dd
            className={
              s.stream === "connected" ? "ok" : open ? "bad" : undefined
            }
          >
            {s.stream === "connected" ? (
              <Wifi size={14} aria-hidden />
            ) : (
              <WifiOff size={14} aria-hidden />
            )}
            {s.stream === "connected"
              ? "Conectada"
              : open
                ? "Sin señal reciente"
                : "En pausa hasta la apertura"}
          </dd>
        </div>
        <div>
          <dt>Bolsa de Nueva York</dt>
          <dd>
            <span className={"live" + (open ? " on" : "")}>
              <i aria-hidden="true" />
            </span>
            <span>{marketText(s)}</span>
          </dd>
        </div>
        <div>
          <dt>Nivel</dt>
          <dd>
            {risk.label} · revisa cada{" "}
            <span className="num">{risk.scanEveryMinutes}</span> min
          </dd>
        </div>
        <div>
          <dt>Última evaluación</dt>
          <dd className="num">{date(s.lastDecision)}</dd>
        </div>
        <div>
          <dt>Worker</dt>
          <dd className={alive ? "ok" : "bad"}>
            {alive ? "Conectado" : "Sin señal"}
            {s.heartbeat && (
              <small className="num">· {clockTime(s.heartbeat)}</small>
            )}
          </dd>
        </div>
      </dl>
      <div className="sm-queue">
        <div className="group-title">
          <h3>Cola de eventos</h3>
          <span className="num">
            {s.queue.length === 1
              ? "1 pendiente"
              : `${s.queue.length} pendientes`}
          </span>
        </div>
        {!s.queue.length ? (
          <p className="muted sm-none">No hay eventos pendientes.</p>
        ) : (
          <ol>
            {s.queue.slice(0, 5).map((q) => (
              <li key={q.id}>
                <time className="num" dateTime={q.at}>
                  {clockTime(q.at)}
                </time>
                <span>{q.reason}</span>
                {q.attempts ? (
                  <small className="sm-attempts">
                    <TriangleAlert size={12} aria-hidden />
                    {q.attempts === 1 ? "1 intento" : `${q.attempts} intentos`}
                  </small>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {s.queue.length > 5 && (
          <p className="muted sm-none">Y {s.queue.length - 5} más.</p>
        )}
      </div>
    </section>
  );
}

function Positions({ s }: { s: Data }) {
  const equity = Number(s.account?.equity) || 0,
    cash = Math.max(0, Number(s.account?.cash) || 0),
    rows = [...s.positions].sort(
      (a, b) =>
        Math.abs(Number(b.market_value)) - Math.abs(Number(a.market_value)),
    ),
    // Alpaca da los cortos con unidades y valor negativos.
    isShort = (x: (typeof rows)[number]) =>
      x.side === "short" || Number(x.qty) < 0,
    parts = [
      ...rows.map((x, i) => ({
        key: x.symbol as string,
        label: (x.symbol as string) + (isShort(x) ? " corto" : ""),
        value: Math.abs(Number(x.market_value) || 0),
        cls: "sm-seg-" + (i % 6),
      })),
      { key: "cash", label: "Efectivo", value: cash, cls: "sm-seg-cash" },
    ],
    total = parts.reduce((a, x) => a + x.value, 0);
  return (
    <section className="panel" aria-labelledby="sm-pos-title">
      <div className="section-title">
        <h2 id="sm-pos-title">Posiciones</h2>
        <span className="muted">
          Efectivo <span className="num">{money(s.account?.cash)}</span>
        </span>
      </div>
      {total > 0 && (
        <div className="sm-alloc">
          <div
            className="sm-alloc-bar"
            role="img"
            aria-label={
              "Reparto de la cartera: " +
              parts.map((x) => `${x.label} ${share(x.value, total)}`).join(", ")
            }
          >
            {parts.map(
              (x) =>
                x.value > 0 && (
                  <i
                    key={x.key}
                    className={x.cls}
                    style={{ flexGrow: x.value }}
                  />
                ),
            )}
          </div>
          <ul className="sm-alloc-legend">
            {parts.map((x) => (
              <li key={x.key}>
                <i className={x.cls} aria-hidden="true" />
                <span>{x.label}</span>
                <span className="num">{share(x.value, total)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!rows.length ? (
        <Empty>
          No hay posiciones. Aquí aparecerán las compras ejecutadas en Alpaca
          Paper.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="sm-table">
            <thead>
              <tr>
                <th scope="col">Activo</th>
                <th scope="col">Unidades</th>
                <th scope="col">Precio de entrada</th>
                <th scope="col">Precio actual</th>
                <th scope="col">Valor</th>
                <th scope="col">Peso</th>
                <th scope="col">Resultado no realizado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const pl = Number(x.unrealized_pl),
                  short = isShort(x);
                return (
                  <tr key={x.symbol}>
                    <th scope="row">
                      <span className="sm-asset">
                        <span className="symbol-tag">{x.symbol}</span>
                        {short && <span className="badge sm-short">Corto</span>}
                      </span>
                    </th>
                    <td data-label="Unidades" className="num">
                      {short ? Math.abs(Number(x.qty)) : x.qty}
                    </td>
                    <td data-label="Precio de entrada" className="num">
                      {money(x.avg_entry_price)}
                    </td>
                    <td data-label="Precio actual" className="num">
                      {money(x.current_price)}
                    </td>
                    <td data-label="Valor" className="num">
                      {money(Math.abs(Number(x.market_value)))}
                    </td>
                    <td data-label="Peso" className="num">
                      {share(Math.abs(Number(x.market_value)), equity)}
                    </td>
                    <td data-label="Resultado no realizado">
                      <span className="sm-pl">
                        <span className={"num sm-tone " + tone(pl)}>
                          {pl > 0 ? "+" : ""}
                          {money(x.unrealized_pl)}
                        </span>
                        <Chip value={Number(x.unrealized_plpc) * 100} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Activity({ s }: { s: Data }) {
  const [open, setOpen] = useState(false),
    events = s.events.slice(0, 8),
    total = s.totals?.events ?? s.events.length;
  return (
    <section className="panel" aria-labelledby="sm-act-title">
      <div className="section-title">
        <h2 id="sm-act-title">Actividad reciente</h2>
        <span className="muted">Últimos {events.length}</span>
      </div>
      {!events.length ? (
        <Empty>Todo comienza con una primera observación.</Empty>
      ) : (
        <ol className="sm-timeline">
          {events.map((e) => (
            <EventItem key={e.id} e={e} />
          ))}
        </ol>
      )}
      <div className="sm-act-foot">
        <span className="muted num">
          {total === 1 ? "1 evento" : `${total} eventos`} en el registro
        </span>
        {total > 0 && (
          <button
            type="button"
            className="with-icon"
            onClick={() => setOpen(true)}
          >
            Ver registro completo <ArrowRight size={15} aria-hidden />
          </button>
        )}
      </div>
      <EventLog open={open} onOpenChange={setOpen} latestId={s.events[0]?.id} />
    </section>
  );
}

function Usage({ s, goTo }: { s: Data; goTo: (tab: string) => void }) {
  const rows = s.usage.slice(-48),
    since = Date.now() - 24 * 3600000,
    day = s.usage.filter((u) => Date.parse(u.at) >= since),
    dayTotal = day.reduce((a, u) => a + u.tokens, 0),
    max = Math.max(1, ...rows.map((u) => u.tokens)),
    avg = rows.length
      ? rows.reduce((a, u) => a + u.tokens, 0) / rows.length
      : 0;
  return (
    <section className="panel sm-usage" aria-labelledby="sm-use-title">
      <div className="section-title">
        <h2 id="sm-use-title">Consumo del modelo</h2>
        <span className="muted">tokens</span>
      </div>
      {!rows.length ? (
        <Empty>Aparecerá tras la primera llamada al modelo.</Empty>
      ) : (
        <>
          <div className="stats two">
            <div className="stat">
              <span>Últimas 24 h</span>
              <strong className="num">{num(dayTotal, 0)}</strong>
              <small>
                {day.length === 1 ? "1 llamada" : `${day.length} llamadas`}
              </small>
            </div>
            <div className="stat">
              <span>Media por llamada</span>
              <strong className="num">{num(avg, 0)}</strong>
              <small>en las últimas {rows.length}</small>
            </div>
          </div>
          <svg
            className="sm-usage-bars"
            viewBox={`0 0 ${rows.length * 10} 60`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Tokens de las últimas ${rows.length} llamadas, entre ${num(Math.min(...rows.map((u) => u.tokens)), 0)} y ${num(max, 0)}`}
          >
            <line x1="0" x2={rows.length * 10} y1="60" y2="60" />
            {rows.map((u, i) => {
              const h = Math.max(1.5, (u.tokens / max) * 56);
              return (
                <rect
                  key={u.at + i}
                  x={i * 10 + 1.5}
                  width="7"
                  y={60 - h}
                  height={h}
                >
                  <title>
                    {date(u.at)}: {num(u.tokens, 0)} tokens
                  </title>
                </rect>
              );
            })}
          </svg>
          <div className="between sm-usage-axis num">
            <span>{date(rows[0].at)}</span>
            <span>{date(rows.at(-1)!.at)}</span>
          </div>
        </>
      )}
      <p className="us-more">
        <button type="button" className="link" onClick={() => goTo("Uso")}>
          Ver uso
        </button>
      </p>
    </section>
  );
}

export function Summary(p: ViewProps) {
  const { s } = p;
  const since = s.equity[0]?.at;
  return (
    <div className="sm">
      <Kpis s={s} goTo={p.goTo} />
      <div className="sm-main">
        <section className="panel sm-equity" aria-labelledby="sm-eq-title">
          <div className="section-title">
            <h2 id="sm-eq-title">Evolución del patrimonio</h2>
            <span className="muted">
              USD · {s.equity.length} muestras
              {since ? " desde " + date(since) : ""}
            </span>
          </div>
          <EquityChart points={s.equity} baseline={s.baseline} />
        </section>
        <AgentState s={s} />
      </div>
      <Positions s={s} />
      <div className="sm-bottom">
        <Activity s={s} />
        <Usage s={s} goTo={p.goTo} />
      </div>
    </div>
  );
}
