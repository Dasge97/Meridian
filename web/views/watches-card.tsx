import React from "react";
import { Bot, User, X } from "lucide-react";
import type { Watch } from "../../src/domain";
import type { ViewProps } from "./types";
import { money, date } from "../shared";
import { Confirm, Hint, Meter } from "../ui";
import {
  FRESH_MS,
  WatchRuler,
  distance,
  distanceText,
  outcome,
  priceFor,
  remaining,
  sign,
} from "./watches-parts";

export function Origin(p: { w: Watch; view: ViewProps }) {
  const { w, view } = p;
  if (!w.decisionId)
    return (
      <span className="wt-origin">
        <User size={14} aria-hidden /> Creada por ti
      </span>
    );
  return (
    <button
      type="button"
      className="wt-origin wt-link"
      onClick={() => {
        const d = view.s.decisions.find((x) => x.id === w.decisionId);
        if (d) view.openDecision(d);
        else
          view.setError(
            "La decisión que creó esta vigilancia ya no está en el historial reciente.",
          );
      }}
    >
      <Bot size={14} aria-hidden /> Agente · ver su decisión
    </button>
  );
}

export function ActiveWatch(p: { w: Watch; view: ViewProps }) {
  const { w, view } = p,
    { s, busy, act } = view,
    now = Date.now(),
    quote = priceFor(s, w.symbol),
    d = distance(s, w.symbol, w.price),
    created = Date.parse(w.createdAt),
    expires = Date.parse(w.expiresAt),
    stale = quote.at ? now - Date.parse(quote.at) > FRESH_MS : true,
    state = outcome(
      w.operator,
      w.price,
      w.invalidateBelow,
      w.invalidateAbove,
      quote.price,
    ),
    title = `${w.symbol} ${sign(w.operator)} ${money(w.price)}`;
  return (
    <article className="wt-card" aria-label={title}>
      <div className="wt-card-head">
        <span className="wt-sym">{w.symbol}</span>
        <Origin w={w} view={view} />
      </div>
      <div className="wt-level">
        <span
          className="wt-op"
          aria-label={
            w.operator === "lte" ? "igual o menor que" : "igual o mayor que"
          }
        >
          {sign(w.operator)}
        </span>
        <strong className="num">{money(w.price)}</strong>
      </div>
      <p className="wt-dist">
        {state === "triggered"
          ? "El último precio ya cumple la condición."
          : state === "invalidated"
            ? "El último precio ya está en zona de invalidación."
            : (distanceText(d) ?? "Sin precio para calcular la distancia.")}
        {d?.atr != null && (
          <Hint label="Movimiento diario habitual: rango medio de las últimas 14 sesiones (ATR 14).">
            <button
              type="button"
              className="wt-help"
              aria-label="Qué es un movimiento diario habitual"
            >
              ?
            </button>
          </Hint>
        )}
      </p>
      <WatchRuler
        operator={w.operator}
        level={w.price}
        price={quote.price}
        below={w.invalidateBelow}
        above={w.invalidateAbove}
      />
      <div className="wt-facts">
        <div>
          <span>{quote.live ? "Último precio" : "Último cierre"}</span>
          <strong className="num">{money(quote.price)}</strong>
          <small className={stale && quote.live ? "wt-stale" : undefined}>
            {date(quote.at)}
          </small>
        </div>
        <div>
          <span>Caduca en</span>
          <strong className="num">{remaining(expires - now)}</strong>
          <Meter
            value={Math.max(0, now - created)}
            max={Math.max(1, expires - created)}
            label="Tiempo consumido hasta la caducidad"
          />
          <small>{date(w.expiresAt)}</small>
        </div>
      </div>
      {(w.invalidateBelow !== null || w.invalidateAbove !== null) && (
        <p className="wt-inval">
          Se invalida si el precio llega a{" "}
          {[
            w.invalidateBelow !== null && `${money(w.invalidateBelow)} o menos`,
            w.invalidateAbove !== null && `${money(w.invalidateAbove)} o más`,
          ]
            .filter(Boolean)
            .join(", o a ")}
          .
        </p>
      )}
      <p className="wt-reason" title={w.reason}>
        {w.reason}
      </p>
      <div className="wt-card-foot">
        <small>Creada {date(w.createdAt)}</small>
        <Confirm
          title={`¿Cancelar la vigilancia ${title}?`}
          description={
            <p>
              Dejará de comprobarse y el agente no se despertará por ella. Queda
              en el historial como cancelada.
            </p>
          }
          action="Cancelar vigilancia"
          danger
          onConfirm={() => act(view.api(`/watches/${w.id}/cancel`))}
        >
          <button type="button" className="danger wt-cancel" disabled={busy}>
            <X size={14} aria-hidden /> Cancelar
          </button>
        </Confirm>
      </div>
    </article>
  );
}
