import React, { useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Plus } from "lucide-react";
import type { ViewProps } from "./types";
import { money, date, Empty } from "../shared";
import { Badge, Stat } from "../ui";
import { ActiveWatch, Origin } from "./watches-card";
import { NewWatch } from "./watches-form";
import { sign } from "./watches-parts";
import "./watches.css";

export function Watches(p: ViewProps) {
  const { s } = p;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("active");
  const newest = [...s.watches].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const active = newest
      .filter((w) => w.status === "active")
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)),
    history = newest.filter((w) => w.status !== "active"),
    count = (...st: string[]) =>
      s.watches.filter((w) => st.includes(w.status)).length,
    byAgent = s.watches.filter((w) => w.decisionId).length,
    cancelled = count("cancelled");
  return (
    <>
      <div className="section-title wt-title">
        <p className="muted wt-lead">
          Cada una despierta al agente una sola vez. Las crea el agente o tú.
        </p>
        <button
          type="button"
          className="primary wt-new"
          onClick={() => setOpen(true)}
        >
          <Plus size={16} aria-hidden /> Nueva vigilancia
        </button>
      </div>
      <section className="panel wt-summary" aria-label="Resumen de vigilancias">
        <div className="stats four">
          <Stat label="Activas" value={String(active.length)}>
            <small>se comprueban cada 2 segundos</small>
          </Stat>
          <Stat label="Activadas" value={String(count("triggered"))}>
            <small>despertaron al agente</small>
          </Stat>
          <Stat
            label="Caducadas o invalidadas"
            value={String(count("expired", "invalidated"))}
          >
            <small>
              {cancelled === 1
                ? "y 1 cancelada"
                : cancelled
                  ? `y ${cancelled} canceladas`
                  : "ninguna cancelada"}
            </small>
          </Stat>
          <Stat
            label="Origen"
            value={`${byAgent} · ${s.watches.length - byAgent}`}
          >
            <small>del agente · tuyas</small>
          </Stat>
        </div>
      </section>
      <Tabs.Root value={tab} onValueChange={setTab} className="wt-tabs">
        <Tabs.List className="tabs" aria-label="Vigilancias">
          <Tabs.Trigger value="active">
            Activas <small className="num">{active.length}</small>
          </Tabs.Trigger>
          <Tabs.Trigger value="history">
            Historial <small className="num">{history.length}</small>
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="active" className="wt-pane">
          {active.length ? (
            <div className="wt-grid">
              {active.map((w) => (
                <ActiveWatch key={w.id} w={w} view={p} />
              ))}
            </div>
          ) : (
            <section className="panel">
              <Empty>
                No hay condiciones en observación. Añade una o deja que el
                agente proponga las suyas al analizar el mercado.
              </Empty>
            </section>
          )}
        </Tabs.Content>
        <Tabs.Content value="history" className="wt-pane">
          <section className="panel wt-history">
            {history.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Estado</th>
                      <th scope="col">Condición</th>
                      <th scope="col">Invalidación</th>
                      <th scope="col">Creada</th>
                      <th scope="col">Caducidad</th>
                      <th scope="col">Origen</th>
                      <th scope="col">Motivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((w) => (
                      <tr key={w.id}>
                        <td>
                          <Badge value={w.status} />
                        </td>
                        <td className="num wt-cond">
                          <b>{w.symbol}</b> {sign(w.operator)} {money(w.price)}
                        </td>
                        <td className="num">
                          {[
                            w.invalidateBelow !== null &&
                              "≤ " + money(w.invalidateBelow),
                            w.invalidateAbove !== null &&
                              "≥ " + money(w.invalidateAbove),
                          ]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </td>
                        <td className="num">{date(w.createdAt)}</td>
                        <td className="num">{date(w.expiresAt)}</td>
                        <td>
                          <Origin w={w} view={p} />
                        </td>
                        <td className="wt-why" title={w.reason}>
                          {w.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                Aquí quedarán las vigilancias activadas, caducadas, invalidadas
                o canceladas.
              </Empty>
            )}
          </section>
        </Tabs.Content>
      </Tabs.Root>
      <NewWatch view={p} open={open} onOpenChange={setOpen} />
    </>
  );
}
