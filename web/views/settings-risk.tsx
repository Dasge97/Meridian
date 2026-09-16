import React, { useState } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import type { Settings } from "../../src/domain";
// src/risk.ts no tiene dependencias. src/domain.ts lo reexporta, pero importarlo
// desde allí mete zod entero (unos 120 KB) en el paquete del navegador.
import {
  EXIT_ATR,
  RISK_PROFILES,
  SIZING_SHARE,
  riskProfileOf,
  type RiskProfile,
} from "../../src/risk";
import type { Data, ViewProps } from "./types";
import { num } from "../shared";
import { Confirm } from "../ui";

const ORDER: RiskProfile[] = ["prudent", "balanced", "active", "aggressive"];

export const riskOf = (settings: Settings) => riskProfileOf(settings).key;

const times = (n: number) => num(n, Number.isInteger(n) ? 0 : 1);
const exitText = (k: RiskProfile) => {
  const e = EXIT_ATR[RISK_PROFILES[k].exit];
  return e.min === e.max ? times(e.min) : `${times(e.min)}–${times(e.max)}`;
};

const sizeUsd = (k: RiskProfile, s: Data) =>
  s.settings.maxOrderUsd * SIZING_SHARE[RISK_PROFILES[k].sizing];

function Option(p: {
  k: RiskProfile;
  s: Data;
  saved: boolean;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  const r = RISK_PROFILES[p.k],
    id = "st-risk-" + p.k;
  return (
    <li
      className={
        "st-risk" + (p.checked ? " checked" : "") + (p.saved ? " saved" : "")
      }
    >
      <div className="st-risk-head">
        <input
          type="radio"
          id={id}
          name="st-risk"
          value={p.k}
          checked={p.checked}
          disabled={p.disabled}
          onChange={p.onChange}
          aria-describedby={id + "-desc " + id + "-facts"}
        />
        <label htmlFor={id}>{r.label}</label>
        {p.saved && (
          <span className="st-risk-now">
            <CircleCheck size={13} aria-hidden /> En uso
          </span>
        )}
      </div>
      <p id={id + "-desc"}>{r.description}</p>
      <dl id={id + "-facts"}>
        <div>
          <dt>Revisa</dt>
          <dd>
            cada <span className="num">{r.scanEveryMinutes}</span> min
          </dd>
        </div>
        <div>
          <dt>Noticias</dt>
          <dd>
            {r.newsWakesAgent ? "Lo despiertan" : "Esperan a la revisión"}
          </dd>
        </div>
        <div>
          <dt>Por orden</dt>
          <dd>
            ≈ <span className="num">{num(sizeUsd(p.k, p.s), 0)}</span> USD
            <small>
              ·{" "}
              <span className="num">
                {num(SIZING_SHARE[r.sizing] * 100, 0)}
              </span>{" "}
              %
            </small>
          </dd>
        </div>
        <div>
          <dt>Salida si va mal</dt>
          <dd>
            ≈ <span className="num">{exitText(p.k)}</span> × movimiento diario
          </dd>
        </div>
        <div>
          <dt>Cortos</dt>
          <dd className={r.shorts ? "st-risk-yes" : undefined}>
            {r.shorts ? (
              <>
                <TriangleAlert size={13} aria-hidden /> Sí
              </>
            ) : (
              "No"
            )}
          </dd>
        </div>
      </dl>
    </li>
  );
}

export function Risk(p: ViewProps) {
  const { s, busy, act } = p;
  const saved = riskOf(s.settings);
  const [choice, setChoice] = useState<RiskProfile>(saved);
  const dirty = choice !== saved,
    next = RISK_PROFILES[choice];
  // Se envían los límites guardados, no los que estén a medio editar abajo.
  const save = () =>
    act("/settings", { ...s.settings, riskProfile: choice }, "PUT");
  const apply = (onClick?: () => void) => (
    <button
      type="button"
      className="primary"
      disabled={busy || !dirty}
      onClick={onClick}
    >
      {dirty ? `Aplicar nivel ${next.label}` : "Aplicar nivel"}
    </button>
  );
  return (
    <section className="panel st-risk-panel" aria-labelledby="st-risk-title">
      <div className="section-title">
        <div>
          <h2 id="st-risk-title">Nivel de riesgo</h2>
          <span className="muted">
            Marca cuánto arriesga el agente y con qué frecuencia mira el
            mercado. Los límites operativos siguen mandando.
          </span>
        </div>
      </div>
      <fieldset className="st-risk-set">
        <legend className="sr-only">Nivel de riesgo del agente</legend>
        <ul>
          {ORDER.map((k) => (
            <Option
              key={k}
              k={k}
              s={s}
              saved={k === saved}
              checked={k === choice}
              disabled={busy}
              onChange={() => setChoice(k)}
            />
          ))}
        </ul>
      </fieldset>
      <p className="st-risk-note">
        El nivel no cambia tus instrucciones ni sus versiones. Se añade al
        preparar cada evaluación.
      </p>
      <div className={"st-savebar" + (dirty ? " dirty" : "")}>
        <span role="status">
          {dirty ? (
            <>
              <i aria-hidden="true" /> Nivel sin aplicar
            </>
          ) : (
            <>En uso: {RISK_PROFILES[saved].label}</>
          )}
        </span>
        {dirty && (
          <button type="button" onClick={() => setChoice(saved)}>
            Deshacer
          </button>
        )}
        {dirty && choice === "aggressive" ? (
          <Confirm
            title="¿Pasar al nivel Agresivo?"
            description={
              <>
                <p>
                  El agente podrá abrir posiciones cortas. Vende acciones que no
                  tiene y pierde si el precio sube.
                </p>
                <p>
                  Revisará el mercado cada {next.scanEveryMinutes} minutos, así
                  que hará más llamadas al modelo. El tope sigue siendo{" "}
                  <span className="num">{s.settings.maxDailyCalls}</span>{" "}
                  llamadas al día.
                </p>
                <p>
                  Cada orden podrá llegar al máximo por orden:{" "}
                  <span className="num">
                    {num(s.settings.maxOrderUsd, 0)} USD
                  </span>
                  .
                </p>
              </>
            }
            action="Pasar a Agresivo"
            danger
            onConfirm={save}
          >
            {apply()}
          </Confirm>
        ) : (
          apply(save)
        )}
      </div>
    </section>
  );
}
