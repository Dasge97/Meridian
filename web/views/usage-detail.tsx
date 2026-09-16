// Detalle de una llamada al modelo en el panel lateral.
import React, { useEffect, useState } from "react";
import { ArrowRight, LoaderCircle, TriangleAlert } from "lucide-react";
import type { Decision } from "../../src/domain";
import type { Data } from "./types";
import { date } from "../shared";
import { Group, Sheet } from "../ui";
import {
  SECTIONS,
  sectionText,
  kindText,
  triggerText,
  tokens,
  share,
  isLegacy,
  triggerOf,
  Status,
  Swatch,
  type UsageItem,
} from "./usage-parts";

type Part = { key: string; label: string; value: number; cls: string };

function Breakdown({ u }: { u: UsageItem }) {
  const est = u.estimated ?? {},
    input: Part[] = SECTIONS.filter((k) => (est[k] ?? 0) > 0).map((k, i) => ({
      key: k,
      label: sectionText[k].label,
      value: est[k]!,
      cls: i % 2 ? "us-part-b" : "us-part-a",
    })),
    all: Part[] = [
      ...input,
      ...(u.completionTokens
        ? [
            {
              key: "completion",
              label: "Respuesta del modelo",
              value: u.completionTokens,
              cls: "us-part-out",
            },
          ]
        : []),
    ],
    total = all.reduce((a, x) => a + x.value, 0);
  if (!input.length)
    return (
      <p className="muted us-none">
        {isLegacy(u)
          ? "Sin desglose: llamada anterior al registro detallado."
          : "Esta llamada no trae desglose de la entrada."}
      </p>
    );
  return (
    <>
      <div
        className="us-stack"
        role="img"
        aria-label={
          "Reparto estimado: " +
          all.map((x) => `${x.label} ${share(x.value, total)}`).join(", ")
        }
      >
        {all.map((x) => (
          <i
            key={x.key}
            className={x.cls}
            style={{ flexGrow: x.value }}
            title={`${x.label}: ${tokens(x.value)} tokens`}
          />
        ))}
      </div>
      <ol className="us-parts">
        {all.map((x) => (
          <li key={x.key}>
            <i className={"us-part-key " + x.cls} aria-hidden="true" />
            <span>{x.label}</span>
            <span className="num">{tokens(x.value)}</span>
            <small className="num">{share(x.value, total)}</small>
          </li>
        ))}
      </ol>
      <p className="us-footnote">
        Las partes de la entrada son una estimación según los caracteres de cada
        una. El proveedor solo da el total.
      </p>
    </>
  );
}

export function CallDetail(p: {
  item: UsageItem | null;
  onClose: () => void;
  s: Data;
  openDecision: (d: Decision) => void;
  api: (path: string) => string;
}) {
  const u = p.item,
    [opening, setOpening] = useState(false),
    [error, setError] = useState("");

  useEffect(() => {
    setOpening(false);
    setError("");
  }, [u]);

  async function showDecision(id: string) {
    const local = p.s.decisions.find((d) => d.id === id);
    if (local) {
      p.onClose();
      p.openDecision(local);
      return;
    }
    setOpening(true);
    setError("");
    try {
      const r = await fetch(
        "/api" + p.api(`/decisions/${encodeURIComponent(id)}`),
      );
      const body = await r.json().catch(() => null);
      if (!r.ok || !body?.proposal)
        throw new Error(body?.error ?? "No se encontró la decisión.");
      p.onClose();
      p.openDecision(body as Decision);
    } catch (e) {
      setError(
        e instanceof TypeError
          ? "Sin conexión con el servidor. No se pudo abrir la decisión."
          : (e as Error).message,
      );
    } finally {
      setOpening(false);
    }
  }

  const trigger = u ? triggerOf(u) : "unknown";
  return (
    <Sheet
      open={Boolean(u)}
      onOpenChange={(open) => !open && p.onClose()}
      title="Llamada al modelo"
      subtitle={
        u && (
          <span className="num">
            {date(u.at)}
            {u.kind && ` · ${kindText[u.kind]}`}
          </span>
        )
      }
    >
      {u && (
        <div className="us-detail">
          {u.ok === false && (
            <div className="banner down" role="status">
              <TriangleAlert size={18} aria-hidden />
              <p>
                <strong>La llamada falló.</strong>{" "}
                {u.error || "No se guardó el motivo."}
              </p>
            </div>
          )}
          <div className="stats four">
            <div className="stat">
              <span>Entrada</span>
              <strong className="num">{tokens(u.promptTokens)}</strong>
            </div>
            <div className="stat">
              <span>Respuesta</span>
              <strong className="num">{tokens(u.completionTokens)}</strong>
            </div>
            <div className="stat">
              <span>Total</span>
              <strong className="num">{tokens(u.tokens)}</strong>
            </div>
            {u.cachedTokens != null && (
              <div className="stat">
                <span>En caché</span>
                <strong className="num">{tokens(u.cachedTokens)}</strong>
                <small>
                  {share(u.cachedTokens, u.promptTokens ?? 0)} de la entrada
                </small>
              </div>
            )}
          </div>

          <Group title="En qué se fueron los tokens" note="tokens">
            <Breakdown u={u} />
          </Group>

          <Group title="Datos de la llamada">
            <dl className="us-facts">
              <div>
                <dt>Qué la provocó</dt>
                <dd>
                  <span className="us-trigger">
                    <Swatch trigger={trigger} />
                    {triggerText[trigger].label}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Evento</dt>
                <dd>{u.event || "—"}</dd>
              </div>
              <div>
                <dt>Tipo</dt>
                <dd>{u.kind ? kindText[u.kind] : "—"}</dd>
              </div>
              <div>
                <dt>Modelo</dt>
                <dd className="num">{u.model || "—"}</dd>
              </div>
              <div>
                <dt>Estado</dt>
                <dd>
                  <Status u={u} />
                </dd>
              </div>
            </dl>
          </Group>

          {u.decisionId && (
            <div className="us-detail-actions">
              <button
                type="button"
                className="with-icon"
                disabled={opening}
                onClick={() => showDecision(u.decisionId!)}
              >
                {opening ? (
                  <LoaderCircle className="spin" size={15} aria-hidden />
                ) : (
                  <ArrowRight size={15} aria-hidden />
                )}
                Ver decisión
              </button>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
