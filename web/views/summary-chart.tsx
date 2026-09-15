import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  BaselineSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { money, date, clockTime, Empty } from "../shared";
import { Chip } from "../ui";

type Point = { at: string; value: number };
const RANGES = [
  { key: "1d", label: "24 h", hours: 24 },
  { key: "3d", label: "3 días", hours: 72 },
  { key: "all", label: "Todo", hours: Infinity },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// La librería no entiende variables CSS: se leen y se pasan como rgba.
function alpha(color: string, a: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
const toDate = (t: Time) => new Date((t as number) * 1000);

function palette() {
  const up = css("--up"),
    down = css("--down");
  return {
    chart: {
      layout: {
        background: { type: ColorType.Solid, color: css("--surface") },
        textColor: css("--muted"),
        fontFamily: css("--mono"),
        fontSize: 11,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: css("--line") },
      },
      timeScale: { borderColor: css("--line") },
      crosshair: {
        vertLine: {
          color: css("--ink-2"),
          labelBackgroundColor: css("--ink"),
        },
        horzLine: {
          color: css("--ink-2"),
          labelBackgroundColor: css("--ink"),
        },
      },
    },
    series: {
      topLineColor: up,
      topFillColor1: alpha(up, 0.26),
      topFillColor2: alpha(up, 0.03),
      bottomLineColor: down,
      bottomFillColor1: alpha(down, 0.03),
      bottomFillColor2: alpha(down, 0.26),
      crosshairMarkerBorderColor: css("--surface"),
    },
    base: css("--muted"),
  };
}

export function EquityChart(p: { points: Point[]; baseline: number | null }) {
  const box = useRef<HTMLDivElement>(null),
    chart = useRef<IChartApi | null>(null),
    series = useRef<ISeriesApi<"Baseline"> | null>(null),
    line = useRef<IPriceLine | null>(null);
  const [range, setRange] = useState<RangeKey>("all");
  const [hover, setHover] = useState<{ time: number; value: number } | null>(
    null,
  );

  // Un punto por segundo y en orden: la librería no admite otra cosa.
  const all = useMemo(() => {
    const m = new Map<number, number>();
    for (const x of p.points) {
      const t = Math.floor(Date.parse(x.at) / 1000);
      if (Number.isFinite(t) && Number.isFinite(x.value)) m.set(t, x.value);
    }
    return [...m]
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
  }, [p.points]);
  const span = all.length ? all.at(-1)!.time - all[0].time : 0;
  const available = (hours: number) =>
    hours === Infinity || span > hours * 3600;
  const current = RANGES.find((r) => r.key === range)!;
  const shown = useMemo(() => {
    if (!available(current.hours)) return all;
    const from = all.at(-1)!.time - current.hours * 3600;
    return all.filter((x) => x.time >= from);
  }, [all, range, span]);
  const base = p.baseline ?? all[0]?.value ?? 0;
  const enough = all.length >= 2;

  useEffect(() => {
    if (!enough || !box.current) return;
    const c = palette();
    const api = createChart(box.current, {
      autoSize: true,
      ...c.chart,
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        ...c.chart.timeScale,
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (t: Time, type: TickMarkType) =>
          type <= TickMarkType.DayOfMonth
            ? toDate(t).toLocaleDateString("es-ES", {
                day: "numeric",
                month: "short",
              })
            : clockTime(toDate(t).toISOString()),
      },
      crosshair: { ...c.chart.crosshair, mode: CrosshairMode.Magnet },
      localization: {
        locale: "es-ES",
        priceFormatter: (v: number) =>
          new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(
            v,
          ),
        timeFormatter: (t: Time) => date(toDate(t).toISOString()),
      },
      handleScroll: false,
      handleScale: false,
    });
    const s = api.addSeries(BaselineSeries, {
      ...c.series,
      baseValue: { type: "price", price: base },
      lineWidth: 2,
      priceLineVisible: false,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    api.subscribeCrosshairMove((param) => {
      const d = param.time && param.seriesData.get(s);
      setHover(
        d && "value" in d
          ? { time: param.time as number, value: d.value }
          : null,
      );
    });
    chart.current = api;
    series.current = s;
    // Al cambiar el tema del sistema cambian las variables: se vuelven a leer.
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const retheme = () =>
      requestAnimationFrame(() => {
        const n = palette();
        api.applyOptions(n.chart);
        s.applyOptions(n.series);
        line.current?.applyOptions({ color: n.base });
      });
    mq.addEventListener("change", retheme);
    return () => {
      mq.removeEventListener("change", retheme);
      api.remove();
      chart.current = null;
      series.current = null;
      line.current = null;
    };
  }, [enough]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    s.applyOptions({ baseValue: { type: "price", price: base } });
    if (line.current) s.removePriceLine(line.current);
    line.current = s.createPriceLine({
      price: base,
      color: css("--muted"),
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
      axisLabelVisible: false,
      title: "inicio",
    });
  }, [base, enough]);

  useEffect(() => {
    if (!series.current || !chart.current) return;
    series.current.setData(shown);
    chart.current.timeScale().fitContent();
  }, [shown, enough]);

  if (!enough)
    return (
      <Empty>
        La curva aparecerá cuando haya dos muestras de tu cuenta simulada.
      </Empty>
    );
  const last = shown.at(-1)!,
    read = hover ?? { time: last.time as number, value: last.value },
    diff = read.value - base,
    first = shown[0];
  return (
    <div className="sm-chart">
      <div className="sm-chart-bar">
        <div className="sm-chart-read" aria-live="off">
          <strong className="num">{money(read.value)}</strong>
          <span className={"num sm-diff " + (diff < 0 ? "down" : "up")}>
            {diff > 0 ? "+" : ""}
            {money(diff)}
          </span>
          <Chip value={base ? (diff / base) * 100 : null} />
          <time
            className="num"
            dateTime={new Date(read.time * 1000).toISOString()}
          >
            {hover ? "" : "último · "}
            {date(new Date(read.time * 1000).toISOString())}
          </time>
        </div>
        <div className="filters" role="group" aria-label="Rango de la curva">
          {RANGES.map((r) => (
            <button
              type="button"
              key={r.key}
              aria-pressed={range === r.key}
              disabled={!available(r.hours)}
              title={
                available(r.hours)
                  ? undefined
                  : "Aún no hay muestras que cubran este rango"
              }
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={box}
        className="sm-chart-canvas"
        role="img"
        aria-label={`Patrimonio de ${money(first.value)} el ${date(new Date(first.time * 1000).toISOString())} a ${money(last.value)} el ${date(new Date(last.time * 1000).toISOString())}. Referencia de inicio ${money(base)}.`}
      />
      <p className="sm-chart-legend">
        <span>
          <i className="sm-key up" aria-hidden="true" /> por encima del
          patrimonio inicial
        </span>
        <span>
          <i className="sm-key down" aria-hidden="true" /> por debajo
        </span>
        <span>
          <i className="sm-key base" aria-hidden="true" /> inicio{" "}
          <span className="num">{money(base)}</span>
          {p.baseline === null && " (primera muestra, falta la referencia)"}
        </span>
      </p>
    </div>
  );
}
