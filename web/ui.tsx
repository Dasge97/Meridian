// Piezas comunes a todas las vistas. Cada vista compone con estas antes de
// inventar las suyas, para que el panel se lea como un solo sistema.
import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { money, pct, tone } from "./shared";
export const labels: Record<string, string> = {
  active: "Vigilando",
  triggered: "Activada",
  expired: "Caducada",
  cancelled: "Cancelada",
  invalidated: "Invalidada",
  proposed: "Propuesta",
  accepted: "Aceptada",
  rejected: "Descartada",
  retired: "Retirada",
  observed: "Observación",
  blocked: "Bloqueada",
  pending: "En cola",
  submitting: "Enviando",
  not_submitted: "No enviada",
  unknown: "Por reconciliar",
  filled: "Ejecutada",
  new: "Abierta",
  partially_filled: "Parcial",
  buy: "Comprar",
  sell: "Vender",
  wait: "Esperar",
  canceled: "Cancelada",
};
export function Badge({ value }: { value: string }) {
  return <span className={"badge " + value}>{labels[value] ?? value}</span>;
}
// Porcentaje con signo y color de subida o bajada.
export function Chip({ value }: { value: number | null | undefined }) {
  return <span className={"chip " + tone(value)}>{pct(value)}</span>;
}
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className="spark" aria-hidden="true" />;
  const lo = Math.min(...values),
    span = Math.max(...values) - lo || 1,
    line = values
      .map(
        (v, i) =>
          `${(i / (values.length - 1)) * 200},${32 - ((v - lo) / span) * 28}`,
      )
      .join(" "),
    t = values.at(-1)! >= values[0] ? "up" : "down";
  return (
    <svg
      className="spark"
      viewBox="0 0 200 34"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon points={`0,34 ${line} 200,34`} className={"area " + t} />
      <polyline
        points={line}
        className={"line " + t}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
// Barras a izquierda o derecha de cero, en la misma escala dentro del grupo.
export function Bars({ rows }: { rows: [string, number | null][] }) {
  const max = Math.max(5, ...rows.map(([, v]) => Math.abs(v ?? 0)));
  return rows.map(([k, v]) => {
    const w = v === null ? 0 : Math.min(50, (Math.abs(v) / max) * 50);
    return (
      <div className="bar-row" key={k}>
        <span>{k}</span>
        <span className="bar" aria-hidden="true">
          {v !== null && w > 0 && (
            <i
              className={tone(v)}
              style={{ left: v > 0 ? "50%" : `${50 - w}%`, width: `${w}%` }}
            />
          )}
        </span>
        <span className="num">{pct(v)}</span>
      </div>
    );
  });
}
export type Mark = {
  kind: "price" | "open" | "vwap" | "sma";
  value: number | null;
};
// Regleta con un rango y marcas dentro. Los extremos van debajo, en dólares.
export function Ruler(p: {
  lo: number;
  hi: number;
  marks: Mark[];
  label: string;
  legend: React.ReactNode;
}) {
  const at = (v: number) =>
    Math.max(0, Math.min(100, ((v - p.lo) / (p.hi - p.lo || 1)) * 100));
  return (
    <>
      <div className="ruler" role="img" aria-label={p.label}>
        <div className="ruler-track" />
        {p.marks.map(
          (m) =>
            m.value !== null && (
              <span
                key={m.kind}
                className={"ruler-mark " + m.kind}
                style={{ left: `${at(m.value)}%` }}
              />
            ),
        )}
      </div>
      <div className="ruler-legend num">
        <span>{money(p.lo)}</span>
        <span>{p.legend}</span>
        <span>{money(p.hi)}</span>
      </div>
    </>
  );
}
export function Group(p: {
  title: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="group">
      <div className="group-title">
        <h3>{p.title}</h3>
        {p.note && <span>{p.note}</span>}
      </div>
      {p.children}
    </div>
  );
}
export function Stat(p: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="stat">
      <span>{p.label}</span>
      <strong className="num">{p.value}</strong>
      {p.children}
    </div>
  );
}
// Barra de consumo de un límite: verde, ámbar desde el 75 % y roja al llegar.
export function Meter(p: { value: number; max: number; label: string }) {
  const ratio = p.max > 0 ? Math.min(1, p.value / p.max) : 0;
  return (
    <span
      className={
        "meter" + (ratio >= 1 ? " full" : ratio >= 0.75 ? " high" : "")
      }
      role="meter"
      aria-valuemin={0}
      aria-valuemax={p.max}
      aria-valuenow={p.value}
      aria-label={p.label}
    >
      <i style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}
// Explicación breve al pasar el ratón o enfocar con el teclado. El
// Tooltip.Provider vive en main.tsx.
export function Hint(p: {
  label: React.ReactNode;
  children: React.ReactElement;
}) {
  return (
    <Tooltip.Root delayDuration={250}>
      <Tooltip.Trigger asChild>{p.children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="hint" sideOffset={6}>
          {p.label}
          <Tooltip.Arrow className="hint-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
// Sustituye a confirm(): dice qué va a pasar y el botón nombra la acción.
export function Confirm(p: {
  title: string;
  description: React.ReactNode;
  action: string;
  danger?: boolean;
  onConfirm: () => void;
  children: React.ReactElement;
}) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>{p.children}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay" />
        <AlertDialog.Content className="dialog small">
          <AlertDialog.Title>{p.title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="dialog-text">{p.description}</div>
          </AlertDialog.Description>
          <div className="dialog-actions">
            <AlertDialog.Cancel asChild>
              <button type="button">Volver</button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                className={p.danger ? "danger solid" : "primary"}
                onClick={p.onConfirm}
              >
                {p.action}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
// Panel lateral que entra desde la derecha. Gestiona foco, Escape y fondo.
export function Sheet(p: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={p.open} onOpenChange={p.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet">
          <div className="sheet-head">
            <div>
              <Dialog.Title>{p.title}</Dialog.Title>
              {p.subtitle ? (
                <Dialog.Description asChild>
                  <div className="muted">{p.subtitle}</div>
                </Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">
                  Detalle
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon" aria-label="Cerrar">
                <X size={18} aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          <div className="sheet-body">{p.children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
