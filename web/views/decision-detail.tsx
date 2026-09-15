import React, { useState } from "react";
import { toast } from "sonner";
import {
  Copy,
  Check,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  ChevronRight,
} from "lucide-react";
import type { Decision } from "../../src/domain";
import type { Data, Act } from "./types";
import { money, date } from "../shared";
import { Badge, Chip, Confirm, Group, Sheet, Stat } from "../ui";
import {
  ActionIcon,
  ReviewLine,
  actionText,
  amount,
  needsReconcile,
} from "./decisions-parts";
import "./decisions.css";

function Context({
  detail,
  id,
}: {
  detail: { id: string; input: unknown } | null;
  id: string;
}) {
  const [copied, setCopied] = useState(false);
  const loading = detail?.id !== id,
    missing = !loading && detail!.input === null,
    text = loading || missing ? "" : JSON.stringify(detail!.input, null, 2);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Contexto copiado al portapapeles");
    } catch {
      toast.error("No se pudo copiar el contexto");
    }
  }
  return (
    <details className="dc-context">
      <summary>
        <ChevronRight size={16} aria-hidden="true" />
        Información disponible al decidir
        {!loading && !missing && (
          <span className="muted num">
            {(text.length / 1000).toLocaleString("es-ES", {
              maximumFractionDigits: 1,
            })}{" "}
            mil caracteres
          </span>
        )}
      </summary>
      {loading ? (
        <p className="muted">Cargando…</p>
      ) : missing ? (
        <p className="muted">
          El contexto guardado solo se conserva para las decisiones recientes.
        </p>
      ) : (
        <>
          <div className="dc-context-bar">
            <button type="button" onClick={copy}>
              {copied ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
              {copied ? "Copiado" : "Copiar"}
            </button>
          </div>
          <pre className="dc-json">{text}</pre>
        </>
      )}
    </details>
  );
}

export function DecisionDetail(p: {
  s: Data;
  busy: boolean;
  act: Act;
  selected: Decision;
  setSelected: (d: Decision | null) => void;
  detail: { id: string; input: unknown } | null;
}) {
  const { s, busy, act, setSelected, detail } = p;
  // El estado se refresca cada 5 s: se enseña la versión más reciente.
  const d = s.decisions.find((x) => x.id === p.selected.id) ?? p.selected;
  const pr = d.proposal,
    total = amount(d),
    fromEntry =
      d.review?.price && pr.limitPrice
        ? (d.review.price / pr.limitPrice - 1) * 100
        : null,
    lessons = s.lessons.filter((l) => l.decisionId === d.id),
    version = s.versions.find((v) => v.id === d.versionId);

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && setSelected(null)}
      title={
        <span className="dc-sheet-title">
          <ActionIcon action={pr.action} size={20} />
          {actionText[pr.action]} · {pr.symbol || "Mercado"}
        </span>
      }
      subtitle={
        <span className="dc-sheet-sub">
          <Badge value={d.status} />
          <time dateTime={d.at}>{date(d.at)}</time>
        </span>
      }
    >
      <div className="dc-detail">
        {needsReconcile(d) && (
          <div className="dc-callout" role="status">
            <TriangleAlert size={18} aria-hidden="true" />
            <div>
              <strong>Orden por reconciliar</strong>
              <p>
                Alpaca no confirmó si recibió la orden. El agente no envía nada
                más hasta resolverlo.
              </p>
              <div className="dc-callout-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    if (await act(`/orders/${d.id}/reconcile`))
                      setSelected(null);
                  }}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Reconciliar con Alpaca
                </button>
                {d.status === "unknown" && (
                  <Confirm
                    title="Verificar que la orden no se envió"
                    description={
                      <>
                        <p>
                          Comprueba primero en Alpaca que la orden no aparece.
                        </p>
                        <p>
                          Se consultará la orden. Si Alpaca responde que no
                          existe, la intención queda resuelta y no se reenvía.
                        </p>
                      </>
                    }
                    action="Verificar y resolver"
                    danger
                    onConfirm={async () => {
                      if (await act(`/orders/${d.id}/confirm-absent`))
                        setSelected(null);
                    }}
                  >
                    <button type="button" disabled={busy}>
                      <ShieldCheck size={14} aria-hidden="true" />
                      Verificar que no se envió
                    </button>
                  </Confirm>
                )}
              </div>
            </div>
          </div>
        )}

        {d.error && (
          <div className="error dc-error" role="note">
            <strong>
              {d.status === "blocked" ? "Motivo del bloqueo" : "Error"}
            </strong>
            <p className="preserve">{d.error}</p>
          </div>
        )}

        {pr.note && (
          <blockquote className="dc-note">
            <span>Nota del agente</span>
            <p className="preserve">{pr.note}</p>
          </blockquote>
        )}

        <div className="stats four dc-stats">
          <Stat
            label="Unidades"
            value={pr.qty == null ? "—" : String(pr.qty)}
          />
          <Stat label="Precio límite" value={money(pr.limitPrice)} />
          <Stat label="Importe" value={money(total)} />
          <Stat label="Versión" value={d.versionId.slice(0, 8)}>
            <small>
              {d.versionId === s.activeVersion
                ? "la activa"
                : version
                  ? date(version.createdAt)
                  : "ya no existe"}
            </small>
          </Stat>
          {fromEntry !== null && (
            <Stat label="Precio en la revisión" value={money(d.review!.price)}>
              <Chip value={fromEntry} />
              <small>desde el precio límite</small>
            </Stat>
          )}
        </div>

        <Group title="Razonamiento">
          <p className="dc-prose preserve">{pr.reason}</p>
        </Group>
        <Group title="Hipótesis">
          <p className="dc-prose preserve">{pr.hypothesis}</p>
        </Group>
        <Group title="Evento que la activó">
          <p className="dc-prose preserve">{d.event}</p>
        </Group>

        <Group
          title="Vigilancias que dejó puestas"
          note={pr.watches.length ? String(pr.watches.length) : undefined}
        >
          {!pr.watches.length ? (
            <p className="muted dc-flat">
              En esta decisión no pidió vigilar ninguna condición de precio.
            </p>
          ) : (
            <ul className="dc-list">
              {pr.watches.map((w, i) => {
                const saved = s.watches.find(
                  (x) =>
                    x.decisionId === d.id &&
                    x.symbol === w.symbol &&
                    x.price === w.price &&
                    x.operator === w.operator,
                );
                return (
                  <li key={i} className="dc-watch">
                    <div>
                      <strong className="num">
                        {w.symbol} {w.operator === "lte" ? "≤" : "≥"}{" "}
                        {money(w.price)}
                      </strong>
                      {saved ? (
                        <Badge value={saved.status} />
                      ) : (
                        <span className="badge dc-unsaved">
                          Fuera de límites, no se guardó
                        </span>
                      )}
                    </div>
                    <p>{w.reason}</p>
                    <small>
                      Caduca {date(w.expiresAt)}
                      {w.invalidateBelow
                        ? ` · se invalida por debajo de ${money(w.invalidateBelow)}`
                        : ""}
                      {w.invalidateAbove
                        ? ` · se invalida por encima de ${money(w.invalidateAbove)}`
                        : ""}
                    </small>
                  </li>
                );
              })}
            </ul>
          )}
        </Group>

        <Group title="Revisión posterior">
          <ReviewLine d={d} />
          {d.review && <p className="dc-prose preserve">{d.review.text}</p>}
          {d.review?.price != null && fromEntry === null && (
            <small>Precio en la revisión: {money(d.review.price)}</small>
          )}
        </Group>

        {lessons.length > 0 && (
          <Group title="Lecciones que salieron de ella">
            <ul className="dc-list">
              {lessons.map((l) => (
                <li key={l.id} className="dc-watch">
                  <div>
                    <strong>{l.title}</strong>
                    <Badge value={l.status} />
                  </div>
                  <p className="preserve">{l.body}</p>
                </li>
              ))}
            </ul>
          </Group>
        )}

        {/* Solo las decisiones antiguas traen lecciones: ahora salen de las revisiones. */}
        {pr.lessons.length > 0 && (
          <Group title="Lecciones que propuso">
            <ul className="dc-list">
              {pr.lessons.map((l, i) => (
                <li key={i} className="dc-watch">
                  <strong>{l.title}</strong>
                  <p className="preserve">{l.body}</p>
                </li>
              ))}
            </ul>
          </Group>
        )}

        <Context detail={detail} id={d.id} />

        <dl className="dc-ids num">
          <div>
            <dt>Decisión</dt>
            <dd>{d.id}</dd>
          </div>
          {d.orderId && (
            <div>
              <dt>Orden en Alpaca</dt>
              <dd>{d.orderId}</dd>
            </div>
          )}
          {d.sentAt && (
            <div>
              <dt>Enviada</dt>
              <dd>{date(d.sentAt)}</dd>
            </div>
          )}
        </dl>
      </div>
    </Sheet>
  );
}
