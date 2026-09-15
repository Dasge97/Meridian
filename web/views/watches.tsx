import React, { useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Plus } from "lucide-react";
import type { ViewProps } from "./types";
import { Empty } from "../shared";
import { Stat } from "../ui";
import { FilterBar, SearchInput, fold } from "../listing";
import { ActiveWatch } from "./watches-card";
import { NewWatch } from "./watches-form";
import { NoMatches, WatchHistory, symbolsOf } from "./watches-history";
import "./watches.css";

// Con pocas activas los filtros sobran.
const FILTER_FROM = 5;

export function Watches(p: ViewProps) {
  const { s } = p;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("active");
  const [q, setQ] = useState(""),
    [symbol, setSymbol] = useState("");
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
  const needle = fold(q.trim()),
    filtering = q !== "" || symbol !== "",
    shownActive = active.filter(
      (w) =>
        (!symbol || w.symbol === symbol) &&
        (!needle || fold(`${w.symbol} ${w.reason}`).includes(needle)),
    ),
    activeSymbols = symbolsOf(active);
  if (symbol && !activeSymbols.includes(symbol)) activeSymbols.push(symbol);
  const clearActive = () => {
    setQ("");
    setSymbol("");
  };
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
          {(active.length >= FILTER_FROM || filtering) && (
            <FilterBar
              active={filtering}
              onClear={clearActive}
              summary={
                filtering ? (
                  <>
                    <span className="num">{shownActive.length}</span> de{" "}
                    <span className="num">{active.length}</span>
                  </>
                ) : undefined
              }
            >
              <SearchInput
                id="wt-a-q"
                label="Buscar entre las activas"
                placeholder="Activo o motivo"
                value={q}
                onChange={setQ}
              />
              <div className="wt-select">
                <label htmlFor="wt-a-activo">Activo</label>
                <select
                  id="wt-a-activo"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                >
                  <option value="">Todos</option>
                  {activeSymbols.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </div>
            </FilterBar>
          )}
          {shownActive.length ? (
            <div className="wt-grid">
              {shownActive.map((w) => (
                <ActiveWatch key={w.id} w={w} view={p} />
              ))}
            </div>
          ) : (
            <section className="panel">
              {active.length ? (
                <NoMatches
                  what="Ninguna vigilancia activa"
                  onClear={clearActive}
                />
              ) : (
                <Empty>
                  No hay condiciones en observación. Añade una o deja que el
                  agente proponga las suyas al analizar el mercado.
                </Empty>
              )}
            </section>
          )}
        </Tabs.Content>
        <Tabs.Content value="history" className="wt-pane">
          <WatchHistory history={history} view={p} />
        </Tabs.Content>
      </Tabs.Root>
      <NewWatch view={p} open={open} onOpenChange={setOpen} />
    </>
  );
}
