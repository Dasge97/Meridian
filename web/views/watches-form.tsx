import React, { useState } from "react";
import type { ViewProps } from "./types";
import { money, date } from "../shared";
import { Sheet } from "../ui";
import {
  type Operator,
  WatchRuler,
  distance,
  distanceText,
  outcome,
  priceFor,
  sign,
} from "./watches-parts";

type Draft = {
  symbol: string;
  operator: Operator;
  price: string;
  expires: string;
  below: string;
  above: string;
  reason: string;
};
type Field = keyof Draft | "form";
const DAY = 86400000;
// Valor para <input type="datetime-local"> en la hora del navegador.
const localInput = (t: number) => {
  const d = new Date(t);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const blank = (symbols: string[]): Draft => ({
  symbol: symbols[0] ?? "",
  operator: "lte",
  price: "",
  expires: localInput(Date.now() + 3 * DAY),
  below: "",
  above: "",
  reason: "",
});
const optional = (v: string) => (v.trim() === "" ? null : Number(v));

// Mismas reglas que watchSchema y watchProblem, más las que dejarían la
// vigilancia sin posibilidad de activarse.
function problems(d: Draft, s: ViewProps["s"]) {
  const e: Partial<Record<Field, string>> = {},
    price = Number(d.price),
    below = optional(d.below),
    above = optional(d.above),
    expires = Date.parse(d.expires),
    now = Date.now();
  if (!s.settings.symbols.includes(d.symbol))
    e.symbol = "Elige un activo de la lista permitida.";
  if (d.price.trim() === "")
    e.price = "Escribe el precio que activa la vigilancia.";
  else if (!(price > 0)) e.price = "El precio tiene que ser mayor que cero.";
  else if (price > 1e8) e.price = "El precio es demasiado alto.";
  if (!Number.isFinite(expires)) e.expires = "Indica cuándo caduca.";
  else if (expires <= now) e.expires = "La caducidad tiene que ser futura.";
  else if (expires > now + 30 * DAY)
    e.expires = "La caducidad no puede pasar de 30 días.";
  if (below !== null && !(below > 0))
    e.below = "Tiene que ser un precio mayor que cero.";
  else if (
    below !== null &&
    d.operator === "lte" &&
    price > 0 &&
    below >= price
  )
    e.below = `Tiene que quedar por debajo de ${money(price)}. Si no, se invalidaría antes de activarse.`;
  if (above !== null && !(above > 0))
    e.above = "Tiene que ser un precio mayor que cero.";
  else if (
    above !== null &&
    d.operator === "gte" &&
    price > 0 &&
    above <= price
  )
    e.above = `Tiene que quedar por encima de ${money(price)}. Si no, se invalidaría antes de activarse.`;
  else if (above !== null && below !== null && below >= above)
    e.above = "Tiene que quedar por encima de la invalidación inferior.";
  if (d.reason.length < 5)
    e.reason = "Explica en al menos 5 caracteres qué debe reevaluar el agente.";
  else if (d.reason.length > 2000)
    e.reason = "El texto no puede pasar de 2000 caracteres.";
  const active = s.watches.filter((w) => w.status === "active");
  if (active.length >= 50) e.form = "Ya hay 50 vigilancias activas.";
  else if (
    active.some(
      (w) =>
        w.symbol === d.symbol && w.operator === d.operator && w.price === price,
    )
  )
    e.form = `Ya vigilas ${d.symbol} ${sign(d.operator)} ${money(price)}.`;
  return e;
}

function Preview({ d, s }: { d: Draft; s: ViewProps["s"] }) {
  const quote = priceFor(s, d.symbol),
    level = Number(d.price),
    below = optional(d.below),
    above = optional(d.above),
    valid = level > 0,
    dist = valid ? distance(s, d.symbol, level) : null,
    now = outcome(
      d.operator,
      level,
      below !== null && below > 0 ? below : null,
      above !== null && above > 0 ? above : null,
      quote.price,
    );
  return (
    <section
      className="wt-preview"
      aria-live="polite"
      aria-label="Vista previa"
    >
      <div className="wt-preview-head">
        <div>
          <span>
            {quote.live ? "Último precio" : "Último cierre"} de {d.symbol}
          </span>
          <strong className="num">{money(quote.price)}</strong>
          <small>{date(quote.at)}</small>
        </div>
        <span className={"wt-now " + now}>
          {now === "triggered"
            ? "Ya se cumple"
            : now === "invalidated"
              ? "Ya invalidada"
              : now === "waiting"
                ? "Aún no se cumple"
                : "Sin nivel"}
        </span>
      </div>
      {valid ? (
        <>
          <p className="wt-dist">
            {distanceText(dist) ?? "Sin precio para calcular la distancia."}
          </p>
          <WatchRuler
            operator={d.operator}
            level={level}
            price={quote.price}
            below={below !== null && below > 0 ? below : null}
            above={above !== null && above > 0 ? above : null}
          />
          {now === "triggered" && (
            <p className="wt-warn">
              El panel comprueba niveles, no cruces. Con este precio se
              activaría en la primera comprobación y despertaría al agente
              enseguida.
            </p>
          )}
          {now === "invalidated" && (
            <p className="wt-warn">
              El precio ya está en la zona de invalidación. Se invalidaría en la
              primera comprobación sin despertar al agente.
            </p>
          )}
        </>
      ) : (
        <p className="muted wt-dist">
          Escribe un precio para ver la distancia y si ya se cumple.
        </p>
      )}
    </section>
  );
}

function FieldError({ id, text }: { id: string; text?: string }) {
  return text ? (
    <span className="wt-error" id={id}>
      {text}
    </span>
  ) : null;
}

export function NewWatch(p: {
  view: ViewProps;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { s, busy, act } = p.view;
  const [d, setD] = useState<Draft>(() => blank(s.settings.symbols));
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [tried, setTried] = useState(false);
  const errors = problems(d, s),
    show = (f: Field) => (tried || touched[f] ? errors[f] : undefined);
  const set =
    <K extends keyof Draft>(k: K) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >,
    ) =>
      setD((x) => ({ ...x, [k]: e.target.value }));
  const field = (k: keyof Draft) => ({
    id: "wt-" + k,
    name: k,
    value: d[k],
    onChange: set(k),
    onBlur: () => setTouched((t) => ({ ...t, [k]: true })),
    "aria-invalid": Boolean(show(k)),
    "aria-describedby": show(k) ? "wt-" + k + "-error" : undefined,
  });
  const reset = () => {
    setD(blank(s.settings.symbols));
    setTouched({});
    setTried(false);
  };
  const quote = priceFor(s, d.symbol);
  const expiresIn = Date.parse(d.expires) - Date.now();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errors).length) {
      const first = (Object.keys(errors) as Field[]).find((k) => k !== "form");
      if (first) document.getElementById("wt-" + first)?.focus();
      return;
    }
    const expiresAt = new Date(d.expires).toISOString();
    const ok = await act("/watches", {
      symbol: d.symbol,
      operator: d.operator,
      price: Number(d.price),
      expiresAt,
      reason: d.reason,
      invalidateBelow: optional(d.below),
      invalidateAbove: optional(d.above),
    });
    // act ya avisa con un toast del resultado.
    if (ok) {
      p.onOpenChange(false);
      reset();
    }
  }
  return (
    <Sheet
      open={p.open}
      onOpenChange={p.onOpenChange}
      title="Nueva vigilancia"
      subtitle="Despierta al agente una sola vez cuando el precio cumple la condición."
    >
      <form className="wt-form" onSubmit={submit} noValidate>
        <label htmlFor="wt-symbol">
          Activo
          <select {...field("symbol")}>
            {s.settings.symbols.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <FieldError id="wt-symbol-error" text={show("symbol")} />
        </label>
        <fieldset className="wt-seg">
          <legend>Condición</legend>
          <div>
            {(["lte", "gte"] as const).map((op) => (
              <label key={op}>
                <input
                  type="radio"
                  name="operator"
                  value={op}
                  checked={d.operator === op}
                  onChange={() => setD((x) => ({ ...x, operator: op }))}
                />
                <b aria-hidden="true">{sign(op)}</b>
                {op === "lte" ? "Igual o menor" : "Igual o mayor"}
              </label>
            ))}
          </div>
        </fieldset>
        <label htmlFor="wt-price" className="wide">
          Precio USD
          <span className="wt-inline">
            <input
              {...field("price")}
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              placeholder={quote.price ? String(quote.price) : undefined}
            />
            {quote.price && (
              <button
                type="button"
                onClick={() =>
                  setD((x) => ({ ...x, price: String(quote.price) }))
                }
              >
                Usar el último precio
              </button>
            )}
          </span>
          <FieldError id="wt-price-error" text={show("price")} />
        </label>
        <div className="wide">
          <Preview d={d} s={s} />
        </div>
        <div className="wide">
          <label htmlFor="wt-expires">
            Caducidad (hora local)
            <input {...field("expires")} type="datetime-local" />
          </label>
          <div
            className="wt-quick"
            role="group"
            aria-label="Atajos de caducidad"
          >
            {(
              [
                ["1 día", 1],
                ["3 días", 3],
                ["1 semana", 7],
              ] as const
            ).map(([label, days]) => (
              <button
                type="button"
                key={days}
                aria-pressed={Math.abs(expiresIn - days * DAY) < 15 * 60000}
                onClick={() =>
                  setD((x) => ({
                    ...x,
                    expires: localInput(Date.now() + days * DAY),
                  }))
                }
              >
                {label}
              </button>
            ))}
          </div>
          <FieldError id="wt-expires-error" text={show("expires")} />
        </div>
        <label htmlFor="wt-below">
          Invalidar por debajo de (opcional)
          <input
            {...field("below")}
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
          />
          <FieldError id="wt-below-error" text={show("below")} />
        </label>
        <label htmlFor="wt-above">
          Invalidar por encima de (opcional)
          <input
            {...field("above")}
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
          />
          <FieldError id="wt-above-error" text={show("above")} />
        </label>
        <label htmlFor="wt-reason" className="wide">
          Qué debe reevaluar el agente
          <textarea {...field("reason")} maxLength={2000} />
          <span className="wt-count num">{d.reason.length} / 2000</span>
          <FieldError id="wt-reason-error" text={show("reason")} />
        </label>
        {tried && errors.form && (
          <p className="wt-error wide" role="alert">
            {errors.form}
          </p>
        )}
        <div className="wt-form-actions wide">
          <button type="button" onClick={() => p.onOpenChange(false)}>
            Volver
          </button>
          <button className="primary" disabled={busy}>
            Guardar vigilancia
          </button>
        </div>
      </form>
    </Sheet>
  );
}
