import React, { useState } from "react";
import { X } from "lucide-react";
import type { Settings } from "../../src/domain";
import type { Data, ViewProps } from "./types";
import { money, num, pct } from "../shared";
import { Group, Meter } from "../ui";
import { riskOf } from "./settings-risk";

// riskProfile no es una cifra: lo edita su propio bloque.
type Key = Exclude<keyof Settings, "symbols" | "riskProfile">;
type Usage = { value: number; text: (limit: number) => string };
type Field = {
  k: Key;
  label: string;
  unit: string;
  min: number;
  max: number;
  hint: string;
  usage?: (s: Data) => Usage | null;
};
const today = () => new Date().toISOString().slice(0, 10);
const share = (value: number, limit: number) =>
  limit > 0
    ? ` · ${num((value / limit) * 100, 0)} %` +
      (value > limit ? " · supera el límite" : "")
    : "";

const GROUPS: { title: string; note: string; fields: Field[] }[] = [
  {
    title: "Dinero",
    note: "en dólares",
    fields: [
      {
        k: "maxOrderUsd",
        label: "Máximo por orden",
        unit: "USD",
        min: 1,
        max: 10000,
        hint: "Importe de una sola orden.",
      },
      {
        k: "maxPositionUsd",
        label: "Máximo por posición",
        unit: "USD",
        min: 1,
        max: 100000,
        hint: "Valor total en un mismo activo.",
        usage: (s) => {
          if (!s.positions.length) return null;
          const top = [...s.positions].sort(
            (a, b) =>
              Math.abs(Number(b.market_value)) -
              Math.abs(Number(a.market_value)),
          )[0];
          const value = Math.abs(Number(top.market_value));
          return {
            value,
            text: (l) =>
              `Mayor: ${top.symbol} ${money(value)}${share(value, l)}`,
          };
        },
      },
      {
        k: "maxExposureUsd",
        label: "Exposición máxima",
        unit: "USD",
        min: 1,
        max: 100000,
        hint: "Suma de todas las posiciones. Las cortas cuentan en positivo.",
        usage: (s) => {
          const value = s.positions.reduce(
            (a, x) => a + Math.abs(Number(x.market_value)),
            0,
          );
          return {
            value,
            text: (l) => `En uso ${money(value)}${share(value, l)}`,
          };
        },
      },
    ],
  },
  {
    title: "Ritmo",
    note: "los días cuentan en UTC",
    fields: [
      {
        k: "maxDailyOrders",
        label: "Órdenes al día",
        unit: "órdenes",
        min: 1,
        max: 100,
        hint: "Órdenes enviadas a Alpaca en un día.",
        usage: (s) => {
          const value = s.decisions.filter(
            (d) => d.sentAt?.slice(0, 10) === today(),
          ).length;
          return { value, text: (l) => `Hoy ${value} de ${num(l, 0)}` };
        },
      },
      {
        k: "maxDailyCalls",
        label: "Llamadas al modelo al día",
        unit: "llamadas",
        min: 1,
        max: 200,
        hint: "Evaluaciones y revisiones cuentan igual.",
        usage: (s) => {
          const value = s.calls.day === today() ? s.calls.count : 0;
          return { value, text: (l) => `Hoy ${value} de ${num(l, 0)}` };
        },
      },
      {
        k: "cooldownSeconds",
        label: "Espera entre evaluaciones",
        unit: "segundos",
        min: 60,
        max: 86400,
        hint: "Tiempo mínimo entre dos evaluaciones.",
      },
    ],
  },
  {
    title: "Protección",
    note: "frente al saldo inicial",
    fields: [
      {
        k: "maxDrawdownPct",
        label: "Pérdida máxima",
        unit: "%",
        min: 1,
        max: 50,
        hint: "Al llegar, bloquea compras nuevas. No vende posiciones.",
        usage: (s) => {
          if (!s.account || !s.baseline) return null;
          const change = (Number(s.account.equity) / s.baseline - 1) * 100;
          const value = Math.max(0, -change);
          return {
            value,
            text: (l) =>
              change >= 0
                ? `Sin pérdida: ${pct(change)} sobre ${money(s.baseline)}`
                : `Pérdida actual ${num(value)} % de ${num(l, 0)} %`,
          };
        },
      },
    ],
  },
];

const minutes = (sec: number) =>
  sec >= 3600
    ? `${num(sec / 3600, sec % 3600 ? 1 : 0)} h`
    : `${num(sec / 60, sec % 60 ? 1 : 0)} min`;

function Symbols(p: {
  s: Data;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState(""),
    [problem, setProblem] = useState("");
  function add() {
    const list = draft
      .split(/[\s,;]+/)
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
    if (!list.length) return;
    const bad = list.find((x) => !/^[A-Z]{1,5}$/.test(x));
    if (bad)
      return setProblem(
        `«${bad}» no vale. Usa de 1 a 5 letras, sin números ni puntos.`,
      );
    const next = [...new Set([...p.value, ...list])];
    if (next.length > 20) return setProblem("Caben como mucho 20 activos.");
    p.onChange(next);
    setDraft("");
    setProblem("");
  }
  const removed = p.s.settings.symbols.filter((x) => !p.value.includes(x));
  const lost = p.s.watches.filter(
    (w) => w.status === "active" && removed.includes(w.symbol),
  ).length;
  return (
    <Group title="Activos permitidos" note={`${p.value.length} de 20`}>
      {p.value.length ? (
        <ul className="st-tags" aria-label="Activos permitidos">
          {p.value.map((x) => (
            <li key={x}>
              <span className="num">{x}</span>
              <button
                type="button"
                aria-label={`Quitar ${x}`}
                onClick={() => p.onChange(p.value.filter((y) => y !== x))}
              >
                <X size={13} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="st-problem" role="alert">
          Añade al menos un activo para poder guardar.
        </p>
      )}
      <label htmlFor="st-symbol" className="sr-only">
        Añadir activo
      </label>
      <div className="st-tag-add">
        <input
          id="st-symbol"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value.toUpperCase());
            setProblem("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="MSFT"
          autoComplete="off"
          aria-invalid={Boolean(problem)}
          aria-describedby="st-symbol-help"
        />
        <button type="button" onClick={add} disabled={!draft.trim()}>
          Añadir
        </button>
      </div>
      <small
        id="st-symbol-help"
        className={problem ? "st-problem" : undefined}
        role={problem ? "alert" : undefined}
      >
        {problem ||
          "De 1 a 5 letras mayúsculas. Pulsa Intro para añadir. Puedes pegar varios separados por comas."}
      </small>
      {lost > 0 && (
        <small className="st-warn">
          Al guardar se cancelarán {lost}{" "}
          {lost === 1 ? "vigilancia activa" : "vigilancias activas"} de{" "}
          {removed.join(", ")}.
        </small>
      )}
    </Group>
  );
}

export function Limits(p: ViewProps) {
  const { s, busy, act } = p;
  const initial = () =>
    Object.fromEntries(
      GROUPS.flatMap((g) => g.fields).map((f) => [
        f.k,
        String(s.settings[f.k]),
      ]),
    ) as Record<Key, string>;
  const [values, setValues] = useState(initial),
    [symbols, setSymbols] = useState(s.settings.symbols);
  const dirty =
    symbols.join() !== s.settings.symbols.join() ||
    GROUPS.some((g) =>
      g.fields.some((f) => Number(values[f.k]) !== s.settings[f.k]),
    );
  return (
    <form
      className="panel st-limits"
      onSubmit={(e) => {
        e.preventDefault();
        // El servidor sustituye la configuración entera: el nivel guardado
        // viaja con los límites para no perderlo.
        const body: Record<string, unknown> = {
          symbols,
          riskProfile: riskOf(s.settings),
        };
        for (const k of Object.keys(values) as Key[])
          body[k] = Number(values[k]);
        act("/settings", body, "PUT");
      }}
    >
      <div className="section-title">
        <div>
          <h2>Límites operativos</h2>
          <span className="muted">
            Controles previos a cada orden. No garantizan el precio final ni la
            pérdida máxima.
          </span>
        </div>
      </div>
      <Symbols s={s} value={symbols} onChange={setSymbols} />
      {GROUPS.map((g) => (
        <Group key={g.title} title={g.title} note={g.note}>
          <div className="st-fields">
            {g.fields.map((f) => {
              const raw = values[f.k],
                limit = raw === "" ? s.settings[f.k] : Number(raw),
                usage = f.usage?.(s),
                id = "st-" + f.k;
              return (
                <div className="st-field" key={f.k}>
                  <label htmlFor={id}>{f.label}</label>
                  <div className="st-input">
                    <input
                      id={id}
                      name={f.k}
                      type="number"
                      inputMode="numeric"
                      min={f.min}
                      max={f.max}
                      step="1"
                      value={raw}
                      onChange={(e) =>
                        setValues({ ...values, [f.k]: e.target.value })
                      }
                      required
                      aria-describedby={id + "-help"}
                    />
                    <span aria-hidden="true">{f.unit}</span>
                  </div>
                  <small id={id + "-help"}>
                    {f.hint}{" "}
                    <span className="num">
                      {num(f.min, 0)}–{num(f.max, 0)}
                    </span>
                    {f.k === "cooldownSeconds" && raw !== "" && (
                      <> · {minutes(Number(raw))}</>
                    )}
                  </small>
                  {usage && (
                    <div className="st-usage">
                      <Meter
                        value={usage.value}
                        max={limit}
                        label={`${f.label}: uso actual`}
                      />
                      <span>{usage.text(limit)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Group>
      ))}
      <div className={"st-savebar" + (dirty ? " dirty" : "")}>
        <span role="status">
          {dirty ? (
            <>
              <i aria-hidden="true" /> Cambios sin guardar
            </>
          ) : (
            "Sin cambios"
          )}
        </span>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setValues(initial());
              setSymbols(s.settings.symbols);
            }}
          >
            Deshacer
          </button>
        )}
        <button
          className="primary"
          disabled={busy || !dirty || !symbols.length}
        >
          Guardar límites
        </button>
      </div>
    </form>
  );
}
