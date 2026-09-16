import React, { useState } from "react";
import type { State } from "../src/domain";
import type { Bar } from "../src/market";
import type { ViewProps } from "./views/types";
import { DailyChart, IntradayChart, useChartBars } from "./market-charts";
import "./market.css";
import {
  money,
  date,
  clockTime,
  weekdayTime,
  num,
  pct,
  tone,
  marketOpen,
  Empty,
} from "./shared";
import { Chip, Sparkline, Bars, Ruler, Group, Stat } from "./ui";
// Precio que se enseña: el del momento con la sesión abierta y, fuera de ella,
// el último cierre, igual que hace el análisis.
function priceOf(s: State, symbol: string) {
  const q = s.quotes[symbol],
    a = s.analysis[symbol];
  if (marketOpen(s) && q) return q.price;
  return (
    a?.lastSession?.close ??
    s.intraday?.[symbol]?.last ??
    a?.indicators?.price ??
    q?.price ??
    null
  );
}
const shortDay = (ymd: string) =>
  new Date(ymd + "T12:00:00Z").toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
  });
function dayChange(s: State, symbol: string, price: number | null) {
  const a = s.analysis[symbol];
  if (a?.today?.prevClose && price)
    return { value: (price / a.today.prevClose - 1) * 100, label: "hoy" };
  if (a?.lastSession)
    return {
      value: a.lastSession.changePct,
      label: "sesión del " + shortDay(a.lastSession.date),
    };
  return { value: null, label: "" };
}
const duration = (ms: number) => {
  const h = Math.floor(ms / 3600000),
    m = Math.floor((ms % 3600000) / 60000);
  return h ? `${h} h ${m} min` : `${m} min`;
};
const ago = (s: string) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(s)) / 60000));
  if (min < 60) return `hace ${min} min`;
  if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 1440)} días`;
};
function Status({ s, symbol }: { s: State; symbol: string }) {
  const open = marketOpen(s),
    d5 = s.intraday?.[symbol],
    a = s.analysis[symbol];
  return (
    <div className="mk-status" role="status">
      <span className={"live" + (open ? " on" : "")}>
        <i aria-hidden="true" />
        Bolsa de Nueva York {open ? "abierta" : "cerrada"}
      </span>
      <span>
        {!s.feeds?.clock ? (
          "Calendario no disponible"
        ) : open ? (
          <>
            cierra en{" "}
            <b className="num">
              {duration(Date.parse(s.market.nextClose!) - Date.now())}
            </b>{" "}
            · {clockTime(s.market.nextClose!)}
          </>
        ) : s.market.nextOpen ? (
          "abre el " + weekdayTime(s.market.nextOpen)
        ) : (
          "sin fecha de apertura"
        )}
      </span>
      <span>
        <em>Precio</em>{" "}
        {s.stream === "connected"
          ? "en directo (IEX)"
          : marketOpen(s)
            ? "sin conexión en directo"
            : "último cierre"}
      </span>
      {d5 && (
        <span>
          <em>Velas de 5 min</em> sip
          {d5.iexBars ? `, ${d5.iexBars} de IEX` : ""}
        </span>
      )}
      <span>
        <em>Análisis</em> <span className="num">{clockTime(a.at)}</span>
      </span>
    </div>
  );
}
function Ticker(p: {
  s: State;
  symbol: string;
  pressed: boolean;
  onSelect: () => void;
}) {
  const { s, symbol } = p,
    closes = s.analysis[symbol].bars.slice(-20).map((b) => b.c),
    price = priceOf(s, symbol),
    change = dayChange(s, symbol, price),
    watches = s.watches.filter(
      (w) => w.symbol === symbol && w.status === "active",
    ).length,
    flags = [
      s.positions.some((x) => x.symbol === symbol) && "posición",
      watches === 1 && "1 vigilancia",
      watches > 1 && `${watches} vigilancias`,
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <button
      type="button"
      className="mk-tick"
      aria-pressed={p.pressed}
      onClick={p.onSelect}
    >
      <span className="mk-sym">{symbol}</span>
      <span className="mk-px num">{num(price)}</span>
      <span className="mk-when">{change.label}</span>
      <Chip value={change.value} />
      <Sparkline values={closes} />
      <span className="mk-foot">
        <span>{closes.length} sesiones</span>
        <span>{flags}</span>
      </span>
    </button>
  );
}
function summary(
  symbol: string,
  i: NonNullable<State["analysis"][string]["indicators"]>,
) {
  const d20 = i.distanceToSma20Pct,
    d50 = i.distanceToSma50Pct;
  const parts = [
    d20 === null || d50 === null
      ? null
      : d20 > 0 && d50 > 0
        ? "por encima de sus medias de 20 y 50 sesiones"
        : d20 < 0 && d50 < 0
          ? "por debajo de sus medias de 20 y 50 sesiones"
          : "entre sus medias de 20 y 50 sesiones",
    i.positionIn52wRangePct === null
      ? null
      : `en el ${num(i.positionIn52wRangePct, 0)} % de su rango de 52 semanas`,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    `${symbol} cotiza ${parts.join(" y ")}.` +
    (i.volumeRatio20 === null
      ? ""
      : ` Su última sesión completa movió ${num(i.volumeRatio20, 1)} veces su volumen medio.`)
  );
}
function Reading({ s, symbol }: { s: State; symbol: string }) {
  const a = s.analysis[symbol],
    i = a.indicators,
    price = priceOf(s, symbol),
    change = dayChange(s, symbol, price),
    session = a.today ?? a.lastSession ?? null,
    text = i && summary(symbol, i);
  return (
    <section className="panel mk-reading">
      <div className="mk-head">
        <div>
          <h2>{symbol}</h2>
          <div className="mk-price">
            <strong className="num">{money(price)}</strong>
            <Chip value={change.value} />
            <span className="muted">{change.label}</span>
          </div>
        </div>
        <span className="muted">
          {a.barsUsed} sesiones · calculado {date(a.at)}
        </span>
      </div>
      {!i ? (
        <Empty>Sin sesiones suficientes para calcular indicadores.</Empty>
      ) : (
        <>
          {text && <p className="mk-summary">{text}</p>}
          <div className="mk-groups">
            {i.high52w !== null && i.low52w !== null && (
              <Group
                title="Rango de 52 semanas"
                note={`${pct((i.price / i.high52w - 1) * 100, 1)} del máximo`}
              >
                <Ruler
                  lo={i.low52w}
                  hi={i.high52w}
                  label={`Precio en el ${num(i.positionIn52wRangePct, 0)} % del rango de 52 semanas`}
                  marks={[
                    { kind: "sma", value: i.sma200 },
                    { kind: "price", value: i.price },
                  ]}
                  legend={
                    <>
                      precio {num(i.positionIn52wRangePct, 0)} %
                      {i.sma200 !== null && (
                        <>
                          {" · "}
                          <span className="sma">media 200</span>
                        </>
                      )}
                    </>
                  }
                />
              </Group>
            )}
            <Group
              title="Distancia a sus medias"
              note="precio frente a la media"
            >
              <Bars
                rows={[
                  ["20 sesiones", i.distanceToSma20Pct],
                  ["50 sesiones", i.distanceToSma50Pct],
                  [
                    "200 sesiones",
                    i.sma200 ? (i.price / i.sma200 - 1) * 100 : null,
                  ],
                ]}
              />
            </Group>
            <Group title="Variación" note="entre cierres">
              <Bars
                rows={[
                  ["1 sesión", i.changePct1d],
                  ["5 sesiones", i.changePct5d],
                  ["20 sesiones", i.changePct20d],
                ]}
              />
            </Group>
            <Group title="Volatilidad y volumen">
              <div className="stats two">
                <Stat
                  label="Movimiento diario habitual"
                  value={i.atr14 === null ? "—" : "±" + money(i.atr14)}
                >
                  <small>
                    {pct(i.atr14Pct).replace("+", "")} del precio · ATR 14
                  </small>
                </Stat>
                <Stat
                  label="Volumen de la última sesión"
                  value={
                    i.volumeRatio20 === null
                      ? "—"
                      : num(i.volumeRatio20, 1) + "×"
                  }
                >
                  <span className="volume-meter" aria-hidden="true">
                    <i
                      style={{
                        width: `${Math.min(100, ((i.volumeRatio20 ?? 0) / 3) * 100)}%`,
                      }}
                    />
                    <b />
                  </span>
                  <small>la marca es su media de 20</small>
                </Stat>
              </div>
            </Group>
            {session && (
              <Group
                title={
                  a.today
                    ? "Sesión en curso"
                    : "Última sesión · " + shortDay(session.date)
                }
                note={<Chip value={session.changePct} />}
              >
                <div className="stats four">
                  <Stat label="Apertura" value={num(session.open)} />
                  <Stat label="Máximo" value={num(session.high)} />
                  <Stat label="Mínimo" value={num(session.low)} />
                  {a.today ? (
                    <Stat
                      label="Cierre anterior"
                      value={num(session.prevClose)}
                    />
                  ) : (
                    <Stat label="Cierre" value={num(session.close)} />
                  )}
                </div>
              </Group>
            )}
          </div>
        </>
      )}
      {a.barsDiscarded > 0 && (
        <p className="muted source">
          Se descartaron {a.barsDiscarded} sesiones porque el proveedor las dio
          con datos imposibles. No entran en ningún cálculo.
        </p>
      )}
      <p className="muted source">Origen: {a.source}</p>
    </section>
  );
}
function Intraday({
  s,
  symbol,
  bars,
}: {
  s: State;
  symbol: string;
  bars: Bar[] | undefined;
}) {
  const d5 = s.intraday?.[symbol],
    today = s.analysis[symbol]?.today;
  if (!d5)
    return (
      <section className="panel">
        <h2>Sesión en velas de 5 minutos</h2>
        <Empty>
          Aparecerá tras la próxima descarga de velas. El worker la repite cada
          cinco minutos.
        </Empty>
      </section>
    );
  return (
    <section className="panel">
      <div className="group-title">
        <h2>
          {today?.date === d5.date ? "Hoy" : "Sesión del " + shortDay(d5.date)}
        </h2>
        <span>
          {d5.positionInDayRangePct === null
            ? ""
            : `${num(d5.positionInDayRangePct, 0)} % del rango del día`}
        </span>
      </div>
      {bars?.length ? (
        <IntradayChart d5={d5} bars={bars} />
      ) : (
        <Ruler
          lo={d5.low}
          hi={d5.high}
          label="Apertura, precio medio y precio actual dentro del rango del día"
          marks={[
            { kind: "open", value: d5.open },
            { kind: "vwap", value: d5.vwap },
            { kind: "price", value: d5.last },
          ]}
          legend={
            <>
              <span className="open">apertura</span> ·{" "}
              <span className="sma">VWAP {num(d5.vwap)}</span> · precio
            </>
          }
        />
      )}
      <div className="mk-rows">
        <Bars
          rows={[
            ["Desde apertura", d5.changeFromOpenPct],
            ["30 minutos", d5.change30mPct],
            ["60 minutos", d5.change60mPct],
          ]}
        />
      </div>
      <p className="muted source">
        {d5.barsUsed} velas de 5 minutos
        {d5.iexBars ? ` · las ${d5.iexBars} últimas de IEX, aún sin sip` : ""} ·
        calculado {date(d5.at)}
      </p>
    </section>
  );
}
function Holdings({ s, symbol }: { s: State; symbol: string }) {
  const p = s.positions.find((x) => x.symbol === symbol),
    watches = s.watches.filter(
      (w) => w.symbol === symbol && w.status === "active",
    ),
    price = priceOf(s, symbol);
  return (
    <section className="panel">
      <h2>Posición y vigilancias</h2>
      {!p && !watches.length && (
        <p className="muted">
          Sin posición ni vigilancias activas en {symbol}.
        </p>
      )}
      {p && (
        <div className="stats two">
          <Stat label="Unidades" value={String(p.qty)} />
          <Stat label="Precio de entrada" value={money(p.avg_entry_price)} />
          <Stat label="Valor" value={money(p.market_value)} />
          <Stat label="Resultado no realizado" value={money(p.unrealized_pl)}>
            <Chip value={Number(p.unrealized_plpc) * 100} />
          </Stat>
        </div>
      )}
      {watches.map((w) => (
        <div className="mk-watch-row" key={w.id}>
          <div>
            <strong className="num">
              {w.operator === "lte" ? "≤" : "≥"} {money(w.price)}
            </strong>
            {price && (
              <span className="muted num">
                {pct((w.price / price - 1) * 100)} del precio
              </span>
            )}
          </div>
          <p>{w.reason}</p>
          <small>Caduca {date(w.expiresAt)}</small>
        </div>
      ))}
    </section>
  );
}
function News({ s }: { s: State }) {
  const [filter, setFilter] = useState<string | null>(null);
  const stories = [...(s.stories || [])].reverse();
  // La decisión más reciente que comenta una noticia es la que vale.
  const comments = new Map(
    s.decisions.flatMap((d) =>
      (d.newsCommented ?? []).map((c) => [c.storyId, c] as const),
    ),
  );
  const counts = s.settings.symbols
    .map(
      (x) => [x, stories.filter((n) => n.symbols.includes(x)).length] as const,
    )
    .filter(([, n]) => n > 0);
  const active = filter && counts.some(([x]) => x === filter) ? filter : null;
  const shown = active
    ? stories.filter((n) => n.symbols.includes(active))
    : stories;
  return (
    <section className="panel mk-news">
      <div className="section-title">
        <div>
          <h2>Noticias que está viendo</h2>
          <span className="muted">
            {stories.length} de las últimas 96 horas ·{" "}
            {stories.filter((n) => comments.get(n.id)?.matters).length} importan
            al agente
          </span>
        </div>
        {counts.length > 1 && (
          <div className="filters" role="group" aria-label="Filtrar por activo">
            <button
              type="button"
              aria-pressed={!active}
              onClick={() => setFilter(null)}
            >
              Todas
            </button>
            {counts.map(([x, n]) => (
              <button
                type="button"
                key={x}
                aria-pressed={active === x}
                onClick={() => setFilter(x)}
              >
                {x} <small>{n}</small>
              </button>
            ))}
          </div>
        )}
      </div>
      {!stories.length ? (
        <Empty>
          Aquí aparecerán los titulares sobre tus activos. El worker los busca
          cada media hora.
        </Empty>
      ) : (
        shown.map((n) => {
          const c = comments.get(n.id);
          return (
            <article className="mk-story" key={n.id}>
              <time dateTime={n.at}>
                <span className="num">{clockTime(n.at)}</span>
                <small>{ago(n.at)}</small>
              </time>
              <div>
                <h3>{n.headline}</h3>
                {n.summary && <p className="mk-story-summary">{n.summary}</p>}
                <div className="mk-meta">
                  {n.symbols.map((x) => (
                    <span className="symbol-tag" key={x}>
                      {x}
                    </span>
                  ))}
                  <span>{n.source}</span>
                  {n.url && (
                    <a href={n.url} target="_blank" rel="noreferrer">
                      leer ↗
                    </a>
                  )}
                </div>
                {c ? (
                  <div
                    className={
                      "mk-opinion " + (c.matters ? "matters" : "noise")
                    }
                  >
                    <span>{c.matters ? "Importa" : "Ruido"}</span>
                    <p className="preserve">{c.comment}</p>
                  </div>
                ) : (
                  <p className="mk-pending">
                    El agente aún no la ha comentado.
                  </p>
                )}
              </div>
            </article>
          );
        })
      )}
    </section>
  );
}
export function Market(p: ViewProps) {
  const { s } = p;
  const [chosen, setChosen] = useState<string | null>(null);
  const symbols = s.settings.symbols.filter((x) => s.analysis?.[x]);
  const symbol = chosen && symbols.includes(chosen) ? chosen : symbols[0];
  // Cada análisis nuevo del worker trae velas nuevas: se vuelven a pedir.
  const version = symbols
    .map((x) => `${s.analysis[x].at}|${s.intraday?.[x]?.at ?? ""}`)
    .join(",");
  const charts = useChartBars(version);
  return (
    <>
      {!symbol ? (
        <section className="panel">
          <Empty>
            El análisis aparecerá tras la primera descarga de velas diarias. El
            worker la repite cada cinco minutos.
          </Empty>
        </section>
      ) : (
        <>
          <Status s={s} symbol={symbol} />
          <div className="mk-tickers" role="group" aria-label="Activos">
            {symbols.map((x) => (
              <Ticker
                key={x}
                s={s}
                symbol={x}
                pressed={x === symbol}
                onSelect={() => setChosen(x)}
              />
            ))}
          </div>
          {charts.failed && !charts.data ? (
            <section className="panel">
              <h2>Velas diarias de {symbol}</h2>
              <Empty>
                No se pudieron cargar las velas. Se vuelve a intentar en cinco
                minutos.
              </Empty>
            </section>
          ) : (
            <DailyChart
              s={s}
              symbol={symbol}
              bars={charts.data ? (charts.data.daily[symbol] ?? []) : undefined}
              openDecision={p.openDecision}
            />
          )}
          <div className="mk-main">
            <Reading s={s} symbol={symbol} />
            <div className="mk-side">
              <Intraday
                s={s}
                symbol={symbol}
                bars={charts.data?.intraday[symbol]}
              />
              <Holdings s={s} symbol={symbol} />
            </div>
          </div>
        </>
      )}
      <News s={s} />
    </>
  );
}
