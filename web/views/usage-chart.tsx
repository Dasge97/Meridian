// Tokens por día UTC en barras apiladas por lo que provocó cada llamada. SVG
// propio: lightweight-charts no apila.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  TRIGGERS,
  triggerText,
  tokens,
  compact,
  plural,
  share,
  utcDay,
  Swatch,
  type TriggerKey,
  type UsageDay,
} from "./usage-parts";

const HEIGHT = 230,
  TOP = 14,
  BOTTOM = 28,
  RIGHT = 6,
  GAP = 2;

// Escala con pasos redondos: 1, 2 o 5 por potencia de diez.
function ticks(max: number, count = 4) {
  if (max <= 0) return { top: 1, list: [0] };
  const raw = max / count,
    mag = 10 ** Math.floor(Math.log10(raw)),
    step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!,
    top = Math.ceil(max / step) * step;
  const list: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) list.push(v);
  return { top, list };
}

// Si un día no trae reparto pero sí tokens, se cuentan como "Sin dato".
function parts(d: UsageDay) {
  const out = TRIGGERS.map(
    (t) => [t, d.byTrigger[t] ?? 0] as [TriggerKey, number],
  ).filter(([, v]) => v > 0);
  if (!out.length && d.tokens > 0) out.push(["unknown", d.tokens]);
  return out;
}

// Rectángulo con las esquinas de arriba redondeadas.
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + k}Q${x},${y} ${x + k},${y}H${x + w - k}Q${x + w},${y} ${x + w},${y + k}V${y + h}Z`;
}

function describe(d: UsageDay) {
  return (
    `${utcDay(d.day, true)}: ${tokens(d.tokens)} tokens en ${plural(d.calls, "llamada", "llamadas")}. ` +
    parts(d)
      .map(([t, v]) => `${triggerText[t].label} ${tokens(v)}`)
      .join(", ")
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Readout(p: {
  day: UsageDay;
  docked?: boolean;
  style?: React.CSSProperties;
}) {
  const segs = parts(p.day);
  return (
    <div className={"us-tip" + (p.docked ? " docked" : "")} style={p.style}>
      <strong>{capital(utcDay(p.day.day, true))}</strong>
      <span className="num us-tip-total">{tokens(p.day.tokens)} tokens</span>
      <small>{plural(p.day.calls, "llamada", "llamadas")}</small>
      {segs.length > 0 && (
        <ul>
          {[...segs].reverse().map(([t, v]) => (
            <li key={t}>
              <Swatch trigger={t} />
              <span>{triggerText[t].label}</span>
              <span className="num">{tokens(v)}</span>
              <small className="num">{share(v, p.day.tokens)}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DailyChart(p: { days: UsageDay[]; present: TriggerKey[] }) {
  const box = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(0),
    [active, setActive] = useState<number | null>(null),
    [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Si cambian los días, la barra señalada puede no existir.
  useEffect(() => {
    setActive((a) => (a !== null && a >= p.days.length ? null : a));
  }, [p.days.length]);

  const n = p.days.length,
    scale = ticks(Math.max(0, ...p.days.map((d) => d.tokens))),
    // El eje deja sitio a su etiqueta más larga (unos 7 px por carácter).
    LEFT = 14 + 7 * Math.max(...scale.list.map((v) => compact(v).length)),
    plotW = Math.max(0, width - LEFT - RIGHT),
    plotH = HEIGHT - TOP - BOTTOM,
    y = (v: number) => TOP + plotH - (v / scale.top) * plotH,
    step = n ? plotW / n : 0,
    barW = Math.max(1, Math.min(32, step * (step > 8 ? 0.68 : 0.8))),
    every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 58))));

  function onKey(e: React.KeyboardEvent) {
    if (!n) return;
    const cur = active ?? n - 1;
    const next =
      e.key === "ArrowLeft"
        ? Math.max(0, cur - 1)
        : e.key === "ArrowRight"
          ? Math.min(n - 1, cur + 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  }

  const day = active !== null ? p.days[active] : null,
    cx = active !== null ? LEFT + step * active + step / 2 : 0,
    right = cx > width / 2,
    narrow = width > 0 && width < 520;

  return (
    <div className="us-chart">
      <ul className="us-legend" aria-label="Qué provocó las llamadas">
        {p.present.map((t) => (
          <li key={t}>
            <Swatch trigger={t} />
            {triggerText[t].label}
          </li>
        ))}
      </ul>
      <div
        ref={box}
        className={"us-plot" + (focused ? " focused" : "")}
        tabIndex={n ? 0 : -1}
        role="group"
        aria-label="Tokens por día UTC. Usa las flechas izquierda y derecha para recorrer los días."
        onKeyDown={onKey}
        onFocus={() => {
          setFocused(true);
          setActive((a) => a ?? n - 1);
        }}
        onBlur={() => {
          setFocused(false);
          setActive(null);
        }}
        onMouseLeave={() => !focused && setActive(null)}
      >
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            aria-hidden="true"
          >
            <defs>
              <pattern
                id="us-hatch-other"
                width="5"
                height="5"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="5" height="5" className="us-hatch-bg" />
                <line x1="0" y1="0" x2="0" y2="5" className="us-hatch-other" />
              </pattern>
              <pattern
                id="us-hatch-unknown"
                width="5"
                height="5"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(135)"
              >
                <rect width="5" height="5" className="us-hatch-bg" />
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="5"
                  className="us-hatch-unknown"
                />
              </pattern>
            </defs>
            {scale.list.map((v) => (
              <g key={v} className="us-grid">
                <line x1={LEFT} x2={width - RIGHT} y1={y(v)} y2={y(v)} />
                <text x={LEFT - 8} y={y(v)} dy="0.32em" textAnchor="end">
                  {v === 0 ? "0" : compact(v)}
                </text>
              </g>
            ))}
            {active !== null && (
              <rect
                className="us-col"
                x={LEFT + step * active}
                y={TOP}
                width={step}
                height={plotH}
              />
            )}
            {p.days.map((d, i) => {
              const x = LEFT + step * i + (step - barW) / 2;
              let acc = 0;
              const segs = parts(d);
              return (
                <g
                  key={d.day}
                  className={
                    "us-day" + (active !== null && active !== i ? " dim" : "")
                  }
                >
                  {segs.map(([t, v], k) => {
                    const y0 = y(acc),
                      y1 = y(acc + v);
                    acc += v;
                    const h = Math.max(0, y0 - y1 - (k > 0 ? GAP : 0));
                    if (h <= 0) return null;
                    return k === segs.length - 1 ? (
                      <path
                        key={t}
                        className={"us-seg us-c-" + t}
                        d={topRounded(x, y1, barW, h, 3)}
                      />
                    ) : (
                      <rect
                        key={t}
                        className={"us-seg us-c-" + t}
                        x={x}
                        y={y1}
                        width={barW}
                        height={h}
                      />
                    );
                  })}
                </g>
              );
            })}
            <line
              className="us-base"
              x1={LEFT}
              x2={width - RIGHT}
              y1={TOP + plotH}
              y2={TOP + plotH}
            />
            {p.days.map((d, i) =>
              (n - 1 - i) % every === 0 ? (
                <text
                  key={d.day}
                  className="us-xlabel"
                  x={Math.min(
                    width - RIGHT - utcDay(d.day).length * 3.5,
                    Math.max(
                      LEFT + utcDay(d.day).length * 3.5,
                      LEFT + step * i + step / 2,
                    ),
                  )}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                >
                  {utcDay(d.day)}
                </text>
              ) : null,
            )}
            {/* Zonas de ratón más anchas que la barra. */}
            {p.days.map((d, i) => (
              <rect
                key={d.day}
                className="us-hit"
                x={LEFT + step * i}
                y={TOP}
                width={step}
                height={plotH + BOTTOM}
                onMouseEnter={() => setActive(i)}
              />
            ))}
          </svg>
        )}
        {day && !narrow && (
          <Readout
            day={day}
            style={
              right
                ? { right: width - cx + 10 }
                : { left: Math.max(0, cx + 10) }
            }
          />
        )}
      </div>
      {/* En pantallas estrechas la lectura va debajo y no tapa las barras. */}
      {narrow && n > 0 && <Readout day={day ?? p.days[n - 1]} docked />}
      <p className="sr-only" aria-live="polite">
        {day && focused ? describe(day) : ""}
      </p>
    </div>
  );
}
