// Patrimonio de las simulaciones en índice 100 al empezar el periodo.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { money, date, clockTime, num, Empty } from "../shared";
import {
  identity,
  riskLabel,
  signedMoney,
  leaderOf,
  SimKey,
  type CompareResponse,
} from "./compare-parts";
import type { SimId } from "../../src/sims";

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const toDate = (t: Time) => new Date((t as number) * 1000);

function chartColors() {
  return {
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
      vertLine: { color: css("--ink-2"), labelBackgroundColor: css("--ink") },
      horzLine: { color: css("--ink-2"), labelBackgroundColor: css("--ink") },
    },
  };
}

type Line = {
  id: SimId;
  index: number;
  label: string;
  points: { time: UTCTimestamp; value: number }[];
};

export function CompareChart({ data }: { data: CompareResponse }) {
  const box = useRef<HTMLDivElement>(null),
    chart = useRef<IChartApi | null>(null),
    series = useRef<ISeriesApi<"Line">[]>([]);
  const [hover, setHover] = useState<number | null>(null);

  // Un punto por segundo y en orden. column dice qué columna de la respuesta
  // corresponde a cada segundo, para leer el USD bajo el cursor.
  const { lines, column, times } = useMemo(() => {
    const column = new Map<number, number>();
    data.series.at.forEach((at, i) => {
      const t = Math.floor(Date.parse(at) / 1000);
      if (Number.isFinite(t)) column.set(t, i);
    });
    const times = [...column.keys()].sort((a, b) => a - b);
    const lines: Line[] = data.sims.map((id, index) => ({
      id,
      index,
      label: data.bySim[id]?.label ?? id,
      points: times.flatMap((t) => {
        const v = data.series.indexed[id]?.[column.get(t)!];
        return v == null ? [] : [{ time: t as UTCTimestamp, value: v }];
      }),
    }));
    return { lines, column, times };
  }, [data]);
  const enough = lines.some((l) => l.points.length >= 2);
  const shape = lines.map((l) => l.id).join(",");

  useEffect(() => {
    if (!enough || !box.current) return;
    const api = createChart(box.current, {
      autoSize: true,
      ...chartColors(),
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.14, bottom: 0.1 },
      },
      timeScale: {
        ...chartColors().timeScale,
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
      crosshair: { ...chartColors().crosshair, mode: CrosshairMode.Magnet },
      localization: {
        locale: "es-ES",
        priceFormatter: (v: number) => num(v, 2),
        timeFormatter: (t: Time) => date(toDate(t).toISOString()),
      },
      handleScroll: false,
      handleScale: false,
    });
    const made = lines.map((l, i) => {
      const x = identity(l.id, l.index);
      const s = api.addSeries(LineSeries, {
        color: css(x.color),
        lineWidth: 2,
        lineStyle: x.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerRadius: 4,
        crosshairMarkerBorderColor: css("--surface"),
        crosshairMarkerBorderWidth: 2,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      });
      if (i === 0)
        s.createPriceLine({
          price: 100,
          color: css("--muted"),
          lineStyle: LineStyle.Dotted,
          lineWidth: 1,
          axisLabelVisible: false,
          title: "inicio 100",
        });
      return s;
    });
    api.subscribeCrosshairMove((param) =>
      setHover(param.time ? (param.time as number) : null),
    );
    chart.current = api;
    series.current = made;
    // Al cambiar el tema del sistema cambian las variables: se vuelven a leer.
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const retheme = () =>
      requestAnimationFrame(() => {
        api.applyOptions(chartColors());
        made.forEach((s, i) =>
          s.applyOptions({
            color: css(identity(lines[i].id, lines[i].index).color),
            crosshairMarkerBorderColor: css("--surface"),
          }),
        );
      });
    mq.addEventListener("change", retheme);
    return () => {
      mq.removeEventListener("change", retheme);
      api.remove();
      chart.current = null;
      series.current = [];
    };
  }, [enough, shape]);

  useEffect(() => {
    if (!chart.current) return;
    series.current.forEach((s, i) => s.setData(lines[i]?.points ?? []));
    chart.current.timeScale().fitContent();
  }, [lines, enough, shape]);

  if (!enough)
    return (
      <Empty>
        La gráfica aparecerá cuando haya al menos dos muestras de patrimonio en
        este periodo.
      </Empty>
    );

  const lastTime = times.at(-1)!,
    time = hover !== null && column.has(hover) ? hover : lastTime,
    col = column.get(time)!;
  const reading = lines.map((l) => {
    const base = data.series.base[l.id],
      value = data.series.values[l.id]?.[col] ?? null,
      level = data.series.indexed[l.id]?.[col] ?? null;
    return {
      ...l,
      value,
      level,
      diff: value !== null && base !== null ? value - base : null,
    };
  });
  const lead = leaderOf(data);
  const first = new Date(times[0] * 1000).toISOString(),
    last = new Date(lastTime * 1000).toISOString();

  return (
    <div className="cmp-chart">
      <div className="cmp-read" aria-live="off">
        <time className="num" dateTime={new Date(time * 1000).toISOString()}>
          {hover !== null && column.has(hover) ? "" : "Último dato · "}
          {date(new Date(time * 1000).toISOString())}
        </time>
        <ul>
          {reading.map((r) => (
            <li key={r.id}>
              <SimKey id={r.id} index={r.index} />
              <span className="cmp-read-name">{r.label}</span>
              <strong className="num" title="Índice: 100 al empezar el periodo">
                {num(r.level, 2)}
              </strong>
              <span className="num cmp-read-usd">{money(r.value)}</span>
              <span
                className={
                  "num cmp-read-diff " +
                  (r.diff === null || r.diff === 0
                    ? ""
                    : r.diff > 0
                      ? "up"
                      : "down")
                }
              >
                {signedMoney(r.diff)}
                <span className="sr-only"> desde el inicio del periodo</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div
        ref={box}
        className="cmp-canvas"
        role="img"
        aria-label={
          `Patrimonio en índice 100 del ${date(first)} al ${date(last)}. ` +
          lines
            .map((l) => {
              const v = l.points.at(-1)?.value ?? null;
              return `${l.label} termina en ${num(v, 2)}, ${signedMoney(data.bySim[l.id]?.result.usd)}`;
            })
            .join(". ") +
          "."
        }
      />
      <p className="cmp-legend">
        {lines.map((l) => (
          <span key={l.id}>
            <SimKey id={l.id} index={l.index} />
            {l.label} · {riskLabel(data.bySim[l.id]?.riskProfile ?? "")}
            {identity(l.id, l.index).dashed ? " (a trazos)" : " (continua)"}
          </span>
        ))}
        <span>
          <i className="cmp-key base" aria-hidden="true" /> 100 = patrimonio al
          empezar el periodo
        </span>
      </p>
      <p className="cmp-gap">
        {lead === null ? (
          "Falta el resultado de alguna simulación para calcular la diferencia en USD."
        ) : lead.id === null ? (
          <>
            Al final del periodo las dos tienen el mismo resultado:{" "}
            <strong className="num">
              {signedMoney(data.bySim[lead.runnerUp].result.usd)}
            </strong>
            .
          </>
        ) : (
          <>
            Al final del periodo, <strong>{data.bySim[lead.id].label}</strong>{" "}
            lleva <strong className="num">{money(lead.gap)}</strong> más que{" "}
            {data.bySim[lead.runnerUp].label} (
            <span className="num">
              {signedMoney(data.bySim[lead.id].result.usd)}
            </span>{" "}
            frente a{" "}
            <span className="num">
              {signedMoney(data.bySim[lead.runnerUp].result.usd)}
            </span>
            ).
          </>
        )}
      </p>
    </div>
  );
}
