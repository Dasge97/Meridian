// Piezas compartidas por la lista de decisiones y su detalle.
import React from "react";
import { CircleCheck, Clock, CircleSlash } from "lucide-react";
import type { Decision } from "../../src/domain";
import { money, date } from "../shared";
import { decisionType } from "./decisions-intent";
import "./decisions.css";

// El color sigue la dirección del dinero: verde al comprar y rojo al vender.
export function ActionIcon({ d, size = 18 }: { d: Decision; size?: number }) {
  const t = decisionType(d);
  return (
    <span className={"dc-icon " + t.side} aria-hidden="true">
      <t.Icon size={size} strokeWidth={1.9} />
    </span>
  );
}

// Tiene una intención que Alpaca no confirmó y hay que resolver a mano.
export const needsReconcile = (d: Decision) =>
  ["unknown", "submitting"].includes(d.status);

// Llegó a salir hacia Alpaca, aunque luego se ejecutara, cancelara o quedara en duda.
export const wasSent = (d: Decision) =>
  Boolean(d.sentAt || d.orderId) ||
  !["observed", "blocked", "pending", "not_submitted"].includes(d.status);

export const amount = (d: Decision) =>
  d.proposal.qty && d.proposal.limitPrice
    ? d.proposal.qty * d.proposal.limitPrice
    : null;

export function reviewState(d: Decision) {
  if (d.review)
    return {
      kind: "done" as const,
      label: "Revisada",
      detail: "el " + date(d.review.at),
    };
  if (d.reviewSkipped)
    return {
      kind: "skipped" as const,
      label: "Sin revisión",
      detail: d.reviewSkipped,
    };
  return {
    kind: "pending" as const,
    label: "Revisión pendiente",
    detail:
      date(d.reviewAt) +
      (d.reviewAttempts ? ` · ${d.reviewAttempts} de 3 intentos` : ""),
  };
}

export function ReviewLine({ d }: { d: Decision }) {
  const r = reviewState(d);
  const Icon =
    r.kind === "done"
      ? CircleCheck
      : r.kind === "pending"
        ? Clock
        : CircleSlash;
  return (
    <span className={"dc-review " + r.kind}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      <b>{r.label}</b>
      <span>{r.detail}</span>
    </span>
  );
}

export const orderText = (d: Decision) =>
  d.proposal.qty || d.proposal.limitPrice
    ? `${d.proposal.qty ?? "—"} × ${money(d.proposal.limitPrice)}`
    : null;
