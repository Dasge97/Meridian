// Gráficas de la pestaña Mercado: velas diarias con lo que hizo el agente
// encima, y la sesión de hoy en velas de 5 minutos.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Bar, Intraday } from "../src/market";
import type { Decision, Watch } from "../src/domain";
import {
  newYorkDate,
  NEW_YORK,
  SESSION_OPEN_MINUTE,
  SESSION_CLOSE_MINUTE,
} from "../src/clock";
import type { Data } from "./views/types";
import { money, num, clockTime, Empty } from "./shared";
import { Badge, Chip } from "./ui";
import { decisionType } from "./views/decisions-intent";

export type ChartBars = {
  daily: Record<string, Bar[]>;
  intraday: Record<string, Bar[]>;
};

// Colores de las variables CSS. Se vuelven a leer al cambiar el tema del
// sistema, porque la librería dibuja en un canvas y no ve las variables.
type Palette = ReturnType<typeof readPalette>;
function readPalette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    ink: v("--ink"),
    ink2: v("--ink-2"),
    muted: v("--muted"),
    line: v("--line"),
    up: v("--up"),
    down: v("--down"),
    warn: v("--warn"),
    series: v("--series"),
    series2: v("--series-2") || v("--warn"),
    mono: v("--mono"),
  };
}
function usePalette() {
  const [palette, setPalette] = useState(readPalette);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setPalette(readPalette());
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return palette;
}
// En el móvil las etiquetas de las líneas y los textos de las marcas se
// solapan: se quitan y la leyenda explica cada trazo.
function useNarrow() {
  const query = "(max-width: 720px)";
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return narrow;
}
// La librería no entiende color-mix: la transparencia se aplica aquí.
function alpha(color: string, a: number) {
  const hex = color.replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((x) => x + x)
          .join("")
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return color;
  const n = parseInt(full, 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function baseOptions(p: Palette) {
  return {
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: p.muted,
      fontFamily: p.mono,
      fontSize: 11,
      panes: { separatorColor: p.line, enableResize: false },
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { color: p.line },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: p.muted, labelBackgroundColor: p.ink },
      horzLine: { color: p.muted, labelBackgroundColor: p.ink },
    },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false },
  };
}
const longDay = (ymd: string) =>
  new Date(ymd + "T12:00:00Z").toLocaleDateString("es-ES", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const shortDay = (ymd: string) =>
  new Date(ymd + "T12:00:00Z").toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
  });
const volume = (n: number) =>
  new Intl.NumberFormat("es-ES", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const timeKey = (t: Time) =>
  typeof t === "string"
    ? t
    : typeof t === "number"
      ? newYorkDate(t * 1000)
      : `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;

// Decisiones que llegaron a enviar una orden. Son las que se marcan en la gráfica.
const SENT = ["filled", "new", "partially_filled", "submitting", "unknown"];
const tradeText = (d: Decision) =>
  `${decisionType(d).text} de ${d.proposal.qty ?? "—"} a ${money(d.proposal.limitPrice)}`;
const watchWords: Record<string, string> = {
  triggered: "activada",
  expired: "caducada",
  invalidated: "invalidada",
};
// Cuándo dejó de estar activa una vigilancia. No se guarda con ella: la
// caducada usa su fecha de caducidad, la activada la decisión que despertó, y
// si no, el registro de eventos.
function watchClosedAt(s: Data, w: Watch) {
  if (w.status === "expired") return w.expiresAt;
  if (w.status === "triggered") {
    const d = s.decisions.find((x) => x.event.startsWith(`Vigilancia ${w.id}`));
    if (d) return d.at;
  }
  const e = s.events
    .filter(
      (x) =>
        x.type === "watch" &&
        x.message === `${w.symbol}: vigilancia ${w.status}` &&
        Date.parse(x.at) >= Date.parse(w.createdAt),
    )
    .at(-1);
  return e?.at ?? null;
}
type Happening =
  | { kind: "trade"; day: string; decision: Decision }
  | { kind: "watch"; day: string; watch: Watch };
// Coloca cada hecho en la última sesión que no es posterior a su fecha: una
// vigilancia que caduca en sábado cae en el viernes.
function happenings(s: Data, symbol: string, days: string[]) {
  const place = (at: string) => {
    const day = newYorkDate(at);
    let i = days.length - 1;
    while (i >= 0 && days[i] > day) i--;
    return i >= 0 ? days[i] : null;
  };
  const list: Happening[] = [];
  for (const d of s.decisions)
    if (
      d.proposal.symbol === symbol &&
      d.proposal.action !== "wait" &&
      SENT.includes(d.status)
    ) {
      const day = place(d.sentAt ?? d.at);
      if (day) list.push({ kind: "trade", day, decision: d });
    }
  for (const w of s.watches)
    if (w.symbol === symbol && watchWords[w.status]) {
      const at = watchClosedAt(s, w);
      const day = at && place(at);
      if (day) list.push({ kind: "watch", day, watch: w });
    }
  return list.sort((a, b) => a.day.localeCompare(b.day));
}
function sma(closes: number[], n: number) {
  let sum = 0;
  return closes.map((c, i) => {
    sum += c - (i >= n ? closes[i - n] : 0);
    return i >= n - 1 ? sum / n : null;
  });
}
const PERIODS = [
  { label: "1M", sessions: 21, name: "un mes" },
  { label: "3M", sessions: 63, name: "tres meses" },
  { label: "6M", sessions: 126, name: "seis meses" },
  { label: "1A", sessions: 252, name: "un año" },
];

export function DailyChart(p: {
  s: Data;
  symbol: string;
  bars: Bar[] | undefined;
  openDecision: (d: Decision) => void;
}) {
  const { s, symbol } = p;
  const palette = usePalette();
  const narrow = useNarrow();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{
    candles: ISeriesApi<"Candlestick">;
    volume: ISeriesApi<"Histogram">;
    sma20: ISeriesApi<"Line">;
    sma50: ISeriesApi<"Line">;
    markers: ISeriesMarkersPluginApi<Time>;
  } | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const levels = useRef<number[]>([]);
  const [period, setPeriod] = useState("3M");
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);

  const rows = useMemo(() => {
    const byDay = new Map<string, Bar>();
    for (const b of p.bars ?? []) byDay.set(newYorkDate(b.t), b);
    const days = [...byDay.keys()].sort();
    const bars = days.map((d) => byDay.get(d)!);
    const closes = bars.map((b) => b.c);
    return { days, bars, sma20: sma(closes, 20), sma50: sma(closes, 50) };
  }, [p.bars]);
  const events = useMemo(
    () => happenings(s, symbol, rows.days),
    [s.decisions, s.watches, s.events, symbol, rows.days],
  );
  const position = s.positions.find((x) => x.symbol === symbol);
  const watches = s.watches.filter(
    (w) => w.symbol === symbol && w.status === "active",
  );
  // El clic en la gráfica usa siempre lo último, sin volver a suscribirse.
  const latest = useRef({ events, openDecision: p.openDecision });
  latest.current = { events, openDecision: p.openDecision };

  useEffect(() => {
    setPinned(null);
    setHover(null);
  }, [symbol]);

  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      ...baseOptions(readPalette()),
      // El formato va en cada serie: uno general taparía el del volumen.
      localization: { locale: "es-ES" },
      timeScale: { borderVisible: false, rightOffset: 2 },
    });
    const price = {
      type: "custom" as const,
      formatter: (n: number) => num(n),
      minMove: 0.01,
    };
    const candles = c.addSeries(CandlestickSeries, {
      priceFormat: price,
      borderVisible: false,
      priceLineVisible: false,
      // Los niveles del agente cerca del precio entran siempre en la escala.
      autoscaleInfoProvider: (original: () => any) => {
        const r = original();
        if (!r || !levels.current.length) return r;
        return {
          ...r,
          priceRange: {
            minValue: Math.min(r.priceRange.minValue, ...levels.current),
            maxValue: Math.max(r.priceRange.maxValue, ...levels.current),
          },
        };
      },
    });
    const line = {
      priceFormat: price,
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    };
    const sma20 = c.addSeries(LineSeries, line);
    const sma50 = c.addSeries(LineSeries, line);
    const vol = c.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "custom", formatter: volume, minMove: 1 },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      1,
    );
    c.panes()[0].setStretchFactor(4);
    c.panes()[1]?.setStretchFactor(1);
    const markers = createSeriesMarkers(candles, []);
    const move = (e: MouseEventParams<Time>) =>
      setHover(e.time === undefined ? null : timeKey(e.time));
    const click = (e: MouseEventParams<Time>) => {
      if (e.time === undefined) return;
      const day = timeKey(e.time);
      const trades = latest.current.events.flatMap((x) =>
        x.kind === "trade" && x.day === day ? [x.decision] : [],
      );
      const hit = trades.find((d) => d.id === e.hoveredObjectId);
      setPinned(day);
      if (hit || trades.length === 1)
        latest.current.openDecision(hit ?? trades[0]);
    };
    c.subscribeCrosshairMove(move);
    c.subscribeClick(click);
    chart.current = c;
    series.current = { candles, volume: vol, sma20, sma50, markers };
    return () => {
      c.unsubscribeCrosshairMove(move);
      c.unsubscribeClick(click);
      c.remove();
      chart.current = null;
      series.current = null;
      lines.current = [];
    };
  }, []);

  useEffect(() => {
    const x = series.current;
    if (!x) return;
    chart.current!.applyOptions(baseOptions(palette));
    x.candles.applyOptions({
      upColor: palette.up,
      downColor: palette.down,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
    });
    x.sma20.applyOptions({ color: palette.series });
    x.sma50.applyOptions({ color: palette.series2 });
  }, [palette]);

  useEffect(() => {
    const x = series.current;
    if (!x) return;
    const { days, bars } = rows;
    x.candles.setData(
      bars.map((b, i) => ({
        time: days[i],
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
      })),
    );
    x.volume.setData(
      bars.map((b, i) => ({
        time: days[i],
        value: b.v,
        color: alpha(b.c >= b.o ? palette.up : palette.down, 0.45),
      })),
    );
    const avg = (values: (number | null)[]) =>
      values.map((value, i) =>
        value === null ? { time: days[i] } : { time: days[i], value },
      );
    x.sma20.setData(avg(rows.sma20));
    x.sma50.setData(avg(rows.sma50));
  }, [rows, palette]);

  useEffect(() => {
    const n = rows.days.length;
    if (!chart.current || !n) return;
    const count = PERIODS.find((x) => x.label === period)!.sessions;
    chart.current.timeScale().setVisibleLogicalRange({
      from: Math.max(0, n - count) - 0.5,
      to: n + 1,
    });
  }, [period, symbol, rows.days.length > 0]);

  useEffect(() => {
    series.current?.markers.setMarkers(
      events.map((x): SeriesMarker<Time> => {
        if (x.kind === "watch")
          return {
            time: x.day,
            position: "aboveBar",
            shape: "circle",
            color: x.watch.status === "expired" ? palette.muted : palette.warn,
            // Sin texto: se solaparía con las etiquetas de las líneas. La
            // leyenda y la lista de debajo dicen qué es.
            text: "",
            size: 0.8,
          };
        const buy = x.decision.proposal.action === "buy";
        return {
          id: x.decision.id,
          time: x.day,
          position: buy ? "belowBar" : "aboveBar",
          shape: buy ? "arrowUp" : "arrowDown",
          color: buy ? palette.up : palette.down,
          text: `${decisionType(x.decision).text} ${x.decision.proposal.qty ?? ""}`,
        };
      }),
    );
  }, [events, palette, narrow]);

  const entry = position ? Number(position.avg_entry_price) : null;
  // Alpaca da los cortos con unidades negativas.
  const short = Boolean(
    position && (position.side === "short" || Number(position.qty) < 0),
  );
  const linesKey = JSON.stringify([
    watches.map((w) => [w.operator, w.price]),
    entry,
    short,
  ]);
  useEffect(() => {
    const x = series.current;
    if (!x) return;
    for (const l of lines.current) x.candles.removePriceLine(l);
    const last = rows.bars.at(-1)?.c;
    // Solo el precio en el eje, sin título: una etiqueta con texto era más ancha
    // que la escala y tapaba sus cifras. Qué es cada línea lo dice la leyenda.
    // lightweight-charts no dibuja el título si se oculta la etiqueta del eje.
    const made = watches.map((w) =>
      x.candles.createPriceLine({
        price: w.price,
        color: palette.warn,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "",
      }),
    );
    if (entry && Number.isFinite(entry))
      made.push(
        x.candles.createPriceLine({
          price: entry,
          color: palette.ink2,
          lineWidth: 2,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: "",
        }),
      );
    lines.current = made;
    // Un nivel muy lejano aplastaría las velas: solo entra en la escala si está
    // a menos de un 15 % del último cierre.
    levels.current = [...watches.map((w) => w.price), ...(entry ? [entry] : [])]
      .filter((v) => last && Math.abs(v / last - 1) < 0.15)
      .sort((a, b) => a - b);
    x.candles.applyOptions({});
  }, [linesKey, palette, rows, narrow]);

  const n = rows.days.length;
  const shown = hover ?? pinned ?? rows.days[n - 1];
  const i = rows.days.indexOf(shown);
  const bar = rows.bars[i],
    prev = rows.bars[i - 1];
  const onDay = events.filter((x) => x.day === shown);
  const periodName = PERIODS.find((x) => x.label === period)!.name;
  const recent = [...events].reverse().slice(0, 8);

  return (
    <section className="panel mk-chart-panel">
      <div className="section-title">
        <div>
          <h2>Velas diarias de {symbol}</h2>
          <span className="muted">
            {n} sesiones · pasa el cursor para leer un día
          </span>
        </div>
        <div className="filters" role="group" aria-label="Periodo visible">
          {PERIODS.map((x) => (
            <button
              type="button"
              key={x.label}
              aria-pressed={period === x.label}
              aria-label={`Ver ${x.name}`}
              onClick={() => setPeriod(x.label)}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>
      {!p.bars ? (
        <Empty>Cargando las velas…</Empty>
      ) : (
        !n && (
          <Empty>
            No hay velas diarias de {symbol}. Aparecerán tras la próxima
            descarga.
          </Empty>
        )
      )}
      {/* El contenedor existe siempre: la gráfica se crea una sola vez. */}
      {n > 0 && (
        <div className="mk-readout">
          <span className="mk-day">
            {longDay(shown)}
            {pinned && !hover && pinned !== rows.days[n - 1] && (
              <button
                type="button"
                className="link"
                onClick={() => setPinned(null)}
              >
                volver al último día
              </button>
            )}
          </span>
          {bar && (
            <dl>
              <div>
                <dt>Apertura</dt>
                <dd className="num">{num(bar.o)}</dd>
              </div>
              <div>
                <dt>Máximo</dt>
                <dd className="num">{num(bar.h)}</dd>
              </div>
              <div>
                <dt>Mínimo</dt>
                <dd className="num">{num(bar.l)}</dd>
              </div>
              <div>
                <dt>Cierre</dt>
                <dd className="num">{num(bar.c)}</dd>
              </div>
              <div>
                <dt>Cambio</dt>
                <dd>
                  <Chip value={prev ? (bar.c / prev.c - 1) * 100 : null} />
                </dd>
              </div>
              <div>
                <dt>Volumen</dt>
                <dd className="num">{volume(bar.v)}</dd>
              </div>
              <div>
                <dt>
                  <i className="mk-key s20" aria-hidden="true" />
                  Media 20
                </dt>
                <dd className="num">{num(rows.sma20[i])}</dd>
              </div>
              <div>
                <dt>
                  <i className="mk-key s50" aria-hidden="true" />
                  Media 50
                </dt>
                <dd className="num">{num(rows.sma50[i])}</dd>
              </div>
            </dl>
          )}
          {onDay.length > 0 && (
            <div className="mk-onday">
              {onDay.map((x) =>
                x.kind === "trade" ? (
                  <button
                    type="button"
                    key={x.decision.id}
                    className={
                      "mk-trade " +
                      (x.decision.proposal.action === "buy" ? "up" : "down")
                    }
                    onClick={() => p.openDecision(x.decision)}
                  >
                    {tradeText(x.decision)} · ver decisión
                  </button>
                ) : (
                  <span key={x.watch.id} className="mk-watch-note">
                    Vigilancia {x.watch.operator === "lte" ? "≤" : "≥"}{" "}
                    {money(x.watch.price)} {watchWords[x.watch.status]}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
      )}
      <div
        ref={box}
        className="mk-chart"
        hidden={!n}
        role="img"
        aria-label={`Velas diarias de ${symbol}, periodo visible de ${periodName}, con volumen y medias de 20 y 50 sesiones.`}
      />
      {n > 0 && (
        <>
          <div className="mk-legend">
            <span>
              <i className="mk-key s20" aria-hidden="true" />
              Media de 20 sesiones
            </span>
            <span>
              <i className="mk-key s50" aria-hidden="true" />
              Media de 50
            </span>
            {watches.length > 0 && (
              <span>
                <i className="mk-key watch" aria-hidden="true" />
                Vigilancia activa
              </span>
            )}
            {position && (
              <span>
                <i className="mk-key entry" aria-hidden="true" />
                {short ? "Precio de entrada del corto" : "Precio de entrada"}
              </span>
            )}
            <span>▲ compra · ▼ venta · ● vigilancia cerrada</span>
          </div>
          {recent.length > 0 && (
            <div className="mk-history">
              <h3>Lo que hizo el agente con {symbol}</h3>
              <ul>
                {recent.map((x) =>
                  x.kind === "trade" ? (
                    <li key={x.decision.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setPinned(x.day);
                          p.openDecision(x.decision);
                        }}
                      >
                        <span className="num">{shortDay(x.day)}</span>
                        <span
                          className={
                            "mk-arrow " +
                            (x.decision.proposal.action === "buy"
                              ? "up"
                              : "down")
                          }
                          aria-hidden="true"
                        >
                          {x.decision.proposal.action === "buy" ? "▲" : "▼"}
                        </span>
                        <span>{tradeText(x.decision)}</span>
                        <Badge value={x.decision.status} />
                      </button>
                    </li>
                  ) : (
                    <li key={x.watch.id}>
                      <div>
                        <span className="num">{shortDay(x.day)}</span>
                        <span className="mk-arrow watch" aria-hidden="true">
                          ●
                        </span>
                        <span>
                          Vigilancia {x.watch.operator === "lte" ? "≤" : "≥"}{" "}
                          {money(x.watch.price)}
                        </span>
                        <Badge value={x.watch.status} />
                      </div>
                    </li>
                  ),
                )}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Hora exacta de un minuto de Nueva York en una fecha dada, con su horario de
// verano o de invierno.
function newYorkInstant(ymd: string, minute: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minute);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: NEW_YORK,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    })
      .formatToParts(guess)
      .map((x) => [x.type, Number(x.value)]),
  );
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  return guess - (wall - guess);
}
const localTime = (t: Time) =>
  typeof t === "number" ? clockTime(new Date(t * 1000).toISOString()) : "";

export function IntradayChart(p: { d5: Intraday; bars: Bar[] }) {
  const palette = usePalette();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{
    price: ISeriesApi<"Area">;
    iex: ISeriesApi<"Line">;
    vwap: ISeriesApi<"Line">;
  } | null>(null);
  const open = useRef<IPriceLine | null>(null);

  const view = useMemo(() => {
    const start = newYorkInstant(p.d5.date, SESSION_OPEN_MINUTE) / 1000;
    const end = newYorkInstant(p.d5.date, SESSION_CLOSE_MINUTE) / 1000;
    const bars = p.bars
      .map((b) => ({ ...b, time: Math.floor(Date.parse(b.t) / 1000) }))
      .filter((b) => b.time >= start && b.time < end)
      .sort((a, b) => a.time - b.time);
    // Las últimas velas pueden venir de IEX. Si la descarga del panel no casa
    // con el resumen, se cuentan desde el final igualmente.
    const split = Math.max(0, bars.length - (p.d5.iexBars ?? 0));
    return { start, end, bars, split };
  }, [p.bars, p.d5.date, p.d5.iexBars]);

  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      ...baseOptions(readPalette()),
      localization: {
        locale: "es-ES",
        priceFormatter: (n: number) => num(n),
        timeFormatter: localTime,
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        tickMarkFormatter: localTime,
      },
      handleScroll: false,
      handleScale: false,
    });
    const common = {
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    };
    const price = c.addSeries(AreaSeries, { ...common, lineWidth: 2 });
    const iex = c.addSeries(LineSeries, {
      ...common,
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
    });
    const vwap = c.addSeries(LineSeries, { ...common, lineWidth: 1 });
    chart.current = c;
    series.current = { price, iex, vwap };
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      open.current = null;
    };
  }, []);

  useEffect(() => {
    const x = series.current;
    if (!x) return;
    const { start, end, bars, split } = view;
    chart.current!.applyOptions(baseOptions(palette));
    x.price.applyOptions({
      lineColor: palette.ink,
      topColor: alpha(palette.ink, 0.12),
      bottomColor: alpha(palette.ink, 0),
      lastValueVisible: split === bars.length,
    });
    x.iex.applyOptions({
      color: palette.ink,
      lastValueVisible: split < bars.length,
    });
    x.vwap.applyOptions({ color: palette.series });
    const at = new Map(bars.map((b, i) => [b.time, i]));
    // Huecos cada 5 minutos para que el eje cubra la sesión entera aunque aún
    // falten velas.
    const slots: number[] = [];
    for (let t = start; t < end; t += 300) slots.push(t);
    let volume = 0,
      weighted = 0;
    const vwap = new Map<number, number>();
    for (const b of bars) {
      volume += b.v;
      weighted += ((b.h + b.l + b.c) / 3) * b.v;
      if (volume > 0) vwap.set(b.time, weighted / volume);
    }
    const time = (t: number) => t as UTCTimestamp;
    x.price.setData(
      slots.map((t) => {
        const i = at.get(t);
        return i !== undefined && i < split
          ? { time: time(t), value: bars[i].c }
          : { time: time(t) };
      }),
    );
    x.iex.setData(
      bars
        .slice(Math.max(0, split - 1))
        .filter((_, i) => split < bars.length || i > 0)
        .map((b) => ({ time: time(b.time), value: b.c })),
    );
    x.vwap.setData(
      bars.flatMap((b) =>
        vwap.has(b.time)
          ? [{ time: time(b.time), value: vwap.get(b.time)! }]
          : [],
      ),
    );
    if (open.current) x.price.removePriceLine(open.current);
    open.current = bars.length
      ? x.price.createPriceLine({
          price: bars[0].o,
          color: palette.muted,
          lineWidth: 1,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: true,
          title: "Apertura",
        })
      : null;
    // Ajustar al contenido se para en la última vela: el rango se fija a mano
    // para que el eje llegue hasta el cierre.
    chart.current!.timeScale().setVisibleLogicalRange({
      from: -0.5,
      to: slots.length - 0.5,
    });
  }, [view, palette]);

  const iex = view.bars.length - view.split;
  return (
    <>
      <div
        ref={box}
        className="mk-chart small"
        role="img"
        aria-label={`Precio de la sesión en velas de 5 minutos, con el precio medio ponderado por volumen y la apertura. La sesión va de ${clockTime(new Date(view.start * 1000).toISOString())} a ${clockTime(new Date(view.end * 1000).toISOString())} en tu hora.`}
      />
      <div className="mk-legend">
        <span>
          <i className="mk-key price" aria-hidden="true" />
          Precio
        </span>
        {iex > 0 && (
          <span>
            <i className="mk-key iex" aria-hidden="true" />
            IEX, aún sin sip
          </span>
        )}
        <span>
          <i className="mk-key vwap" aria-hidden="true" />
          VWAP
        </span>
        <span>
          <i className="mk-key open" aria-hidden="true" />
          Apertura
        </span>
        <span>
          {clockTime(new Date(view.start * 1000).toISOString())}–
          {clockTime(new Date(view.end * 1000).toISOString())} en tu hora
        </span>
      </div>
    </>
  );
}

// Pide las velas completas al abrir la pestaña, cada 5 minutos y cuando el
// worker guarda un análisis nuevo, para que casen con el resto de la vista.
export function useChartBars(version: string) {
  const [data, setData] = useState<ChartBars | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/market")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
        .then((d: ChartBars) => {
          if (!alive) return;
          setData(d);
          setFailed(false);
        })
        .catch(() => alive && setFailed(true));
    load();
    const t = setInterval(load, 300000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [version]);
  return { data, failed };
}
