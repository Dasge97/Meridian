import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Toaster, toast } from "sonner";
import { Command } from "cmdk";
import {
  LayoutDashboard,
  ChartCandlestick,
  ListChecks,
  Crosshair,
  BookOpen,
  Settings,
  RefreshCw,
  Play,
  Pause,
  LogOut,
  Search,
  TriangleAlert,
  PlugZap,
  LoaderCircle,
  ArrowRight,
  X,
} from "lucide-react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import type { Decision } from "../src/domain";
import { money, date, marketOpen, marketText } from "./shared";
import { Badge, Chip, Hint } from "./ui";
import { Market } from "./market";
import type { Data } from "./views/types";
import { Summary } from "./views/summary";
import { Decisions } from "./views/decisions";
import { Watches } from "./views/watches";
import { Learning } from "./views/learning";
import { SettingsView } from "./views/settings";
import { DecisionDetail } from "./views/decision-detail";
import "./style.css";
const TABS = [
  {
    name: "Resumen",
    icon: LayoutDashboard,
    title: "El pulso de tu agente",
    text: "Qué hace el agente, cómo va la cuenta y qué ha pasado.",
  },
  {
    name: "Mercado",
    icon: ChartCandlestick,
    title: "Mercado",
    text: "Los mismos datos que recibe el agente para decidir.",
  },
  {
    name: "Decisiones",
    icon: ListChecks,
    title: "Decisiones",
    text: "Cada hipótesis, su contexto y lo que ocurrió después.",
  },
  {
    name: "Vigilancias",
    icon: Crosshair,
    title: "Vigilancias",
    text: "Condiciones de precio que despiertan al agente.",
  },
  {
    name: "Aprendizaje",
    icon: BookOpen,
    title: "Aprendizaje",
    text: "Lecciones que salen de revisar sus operaciones.",
  },
  {
    name: "Configuración",
    icon: Settings,
    title: "Configuración",
    text: "Tú defines los límites. El agente decide dentro de ellos.",
  },
];
// Aviso tras una acción que sale bien. El resto dice solo que se guardó.
const done = (url: string, body: unknown) =>
  url === "/wake"
    ? "Evaluación pedida al agente"
    : url === "/pause"
      ? (body as { paused: boolean }).paused
        ? "Agente pausado"
        : "Agente activado"
      : "Cambios guardados";
async function api(url: string, body?: unknown, method = "POST") {
  const r = await fetch("/api" + url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "No se pudo completar");
  return d;
}
function Palette(p: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  s: Data;
  busy: boolean;
  ready: boolean;
  goTo: (tab: string) => void;
  openDecision: (d: Decision) => void;
  act: (url: string, body?: unknown) => Promise<boolean>;
}) {
  const run = (fn: () => void) => {
    p.onOpenChange(false);
    fn();
  };
  return (
    <Command.Dialog
      open={p.open}
      onOpenChange={p.onOpenChange}
      label="Buscar o ir a"
      className="palette"
      overlayClassName="overlay"
      contentClassName="palette-dialog"
    >
      <div className="palette-input">
        <Search size={16} aria-hidden />
        <Command.Input placeholder="Busca una vista, una acción o una decisión" />
        <kbd>Esc</kbd>
      </div>
      <Command.List>
        <Command.Empty>Sin resultados.</Command.Empty>
        <Command.Group heading="Ir a">
          {TABS.map((t) => (
            <Command.Item
              key={t.name}
              value={"ir a " + t.name}
              onSelect={() => run(() => p.goTo(t.name))}
            >
              <t.icon size={16} aria-hidden />
              {t.name}
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group heading="Acciones">
          <Command.Item
            value="reevaluar ahora"
            disabled={p.busy}
            onSelect={() => run(() => p.act("/wake"))}
          >
            <RefreshCw size={16} aria-hidden />
            Reevaluar ahora
          </Command.Item>
          <Command.Item
            value={p.s.paused ? "activar agente" : "pausar agente"}
            disabled={p.busy || (p.s.paused && !p.ready)}
            onSelect={() => run(() => p.act("/pause", { paused: !p.s.paused }))}
          >
            {p.s.paused ? (
              <Play size={16} aria-hidden />
            ) : (
              <Pause size={16} aria-hidden />
            )}
            {p.s.paused ? "Activar agente" : "Pausar agente"}
          </Command.Item>
        </Command.Group>
        {p.s.decisions.length > 0 && (
          <Command.Group heading="Decisiones recientes">
            {[...p.s.decisions]
              .reverse()
              .slice(0, 8)
              .map((d) => (
                <Command.Item
                  key={d.id}
                  value={`${d.id} ${d.proposal.action} ${d.proposal.symbol ?? "mercado"} ${d.proposal.note ?? ""} ${d.proposal.reason}`}
                  onSelect={() => run(() => p.openDecision(d))}
                >
                  <Badge value={d.proposal.action} />
                  <b className="num">{d.proposal.symbol ?? "Mercado"}</b>
                  <span className="palette-text">
                    {d.proposal.note || d.proposal.reason}
                  </span>
                  <time>{date(d.at)}</time>
                </Command.Item>
              ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
function App() {
  const [data, setData] = useState<Data | null>(null),
    [auth, setAuth] = useState<boolean | null>(null),
    [tab, setTab] = useState("Resumen"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [palette, setPalette] = useState(false),
    [selected, setSelected] = useState<Decision | null>(null),
    [detail, setDetail] = useState<{ id: string; input: unknown } | null>(null);
  async function refresh() {
    const r = await fetch("/api/state");
    if (r.status === 401) {
      setAuth(false);
      return;
    }
    if (!r.ok) throw new Error("No se puede cargar el panel");
    setData(await r.json());
    setAuth(true);
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const t = setInterval(
      () =>
        refresh().catch(() =>
          setError(
            "Sin conexión con el servidor. Los datos pueden estar desactualizados.",
          ),
        ),
      5000,
    );
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // Tras una acción llega un aviso breve. Con la sesión abierta un fallo también
  // va en aviso; en la pantalla de acceso se queda escrito bajo el formulario.
  async function act(url: string, body?: unknown, method = "POST") {
    setBusy(true);
    setError("");
    try {
      await api(url, body, method);
      await refresh();
      if (url !== "/login" && url !== "/logout") toast.success(done(url, body));
      return true;
    } catch (e) {
      const message = (e as Error).message;
      if (auth) toast.error(message);
      else setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const target = selected.id;
    fetch(`/api/decisions/${target}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setDetail({ id: target, input: d?.input ?? null });
      })
      .catch(() => {
        if (!cancelled) setDetail({ id: target, input: null });
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);
  if (auth === false)
    return (
      <div className="login">
        <div className="login-card">
          <div className="login-side">
            <div className="brand">
              <b className="mark">M</b> meridian<span>LAB</span>
            </div>
            <div>
              <h1>
                Tu laboratorio.
                <br />
                Tu agente.
              </h1>
              <p>
                Un agente que opera en una cuenta simulada de Alpaca. Aquí ves
                cada decisión, su motivo y lo que pasó después.
              </p>
            </div>
            <ul>
              <li>Solo dinero ficticio, en Alpaca Paper</li>
              <li>Cada decisión queda registrada con su contexto</li>
              <li>Los límites los pones tú</li>
            </ul>
          </div>
          <form
            className="login-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              await act("/login", { password: f.get("password") });
            }}
          >
            <h2>Entrar</h2>
            <p className="muted">Acceso privado del propietario.</p>
            <label htmlFor="password">Contraseña</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
            />
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button disabled={busy} className="primary with-icon">
              Entrar al laboratorio <ArrowRight size={16} aria-hidden />
            </button>
          </form>
        </div>
      </div>
    );
  if (!data)
    return (
      <div className="login">
        <p className="loading" role="status">
          {!error && <LoaderCircle className="spin" size={18} aria-hidden />}
          {error || "Conectando con Meridian…"}
        </p>
      </div>
    );
  const s = data,
    active = s.watches.filter((w) => w.status === "active"),
    unresolved = s.decisions.filter((d) =>
      ["unknown", "submitting"].includes(d.status),
    ).length,
    ready = s.connection.alpaca && s.connection.model,
    alive = Boolean(
      s.heartbeat && Date.now() - Date.parse(s.heartbeat) < 120000,
    ),
    open = marketOpen(s),
    current = TABS.find((t) => t.name === tab) ?? TABS[0];
  const delta =
    s.account && s.baseline ? Number(s.account.equity) - s.baseline : null;
  const agent = s.paused
    ? { kind: "", text: "Pausado" }
    : !alive
      ? { kind: "down", text: "Worker sin señal" }
      : s.modelJob
        ? { kind: "busy", text: "Evaluando" }
        : { kind: "on", text: "Observando" };
  const view = {
    s,
    busy,
    act,
    openDecision: setSelected,
    goTo: setTab,
    setError,
  };
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <b className="mark">M</b> meridian<span>LAB</span>
        </div>
        <nav aria-label="Navegación principal">
          {TABS.map((t) => (
            <button
              key={t.name}
              onClick={() => setTab(t.name)}
              className={tab === t.name ? "current" : ""}
              aria-current={tab === t.name ? "page" : undefined}
            >
              <t.icon size={18} strokeWidth={1.75} aria-hidden />
              {t.name}
              {t.name === "Vigilancias" && active.length > 0 && (
                <small>{active.length}</small>
              )}
              {t.name === "Decisiones" && unresolved > 0 && (
                <small
                  className="alert-count"
                  title={`${unresolved} por reconciliar`}
                >
                  {unresolved}
                </small>
              )}
            </button>
          ))}
        </nav>
        <div className="aside-bottom">
          <span className="paper">ALPACA PAPER</span>
          <strong className="num">{money(s.account?.equity)}</strong>
          <div className="aside-delta">
            {delta !== null && s.baseline ? (
              <>
                <Chip value={(delta / s.baseline) * 100} />
                <small>desde el inicio</small>
              </>
            ) : (
              <small>Capital ficticio</small>
            )}
          </div>
          <button className="with-icon" onClick={() => act("/logout")}>
            <LogOut size={16} aria-hidden /> Cerrar sesión
          </button>
        </div>
      </aside>
      <main>
        <header>
          <button
            type="button"
            className="search-trigger with-icon"
            onClick={() => setPalette(true)}
          >
            <Search size={15} aria-hidden />
            <span>Buscar o ir a…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="header-right">
            <Hint label={marketText(s)}>
              <span
                className={"pill " + (open ? "on" : "")}
                tabIndex={0}
                aria-label={"Bolsa de Nueva York: " + marketText(s)}
              >
                <i aria-hidden />
                {!s.feeds?.clock
                  ? "Sin calendario"
                  : open
                    ? "Bolsa abierta"
                    : "Bolsa cerrada"}
              </span>
            </Hint>
            <Hint
              label={
                s.heartbeat
                  ? "Última señal del worker: " + date(s.heartbeat)
                  : "El worker no ha dado señal"
              }
            >
              <span
                className={"pill " + agent.kind}
                tabIndex={0}
                aria-label={"Agente: " + agent.text}
              >
                <i aria-hidden />
                {agent.text}
              </span>
            </Hint>
            <span className="badge sim">Solo simulación</span>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <h1>{current.title}</h1>
              <p className="muted">{current.text}</p>
            </div>
            <div className="actions">
              <Hint label="Pide al agente una evaluación ahora, sin esperar a un evento.">
                <button
                  className="with-icon"
                  disabled={busy}
                  onClick={() => act("/wake")}
                >
                  <RefreshCw size={15} aria-hidden /> Reevaluar
                </button>
              </Hint>
              <button
                className="primary with-icon"
                disabled={busy || (s.paused && !ready)}
                onClick={() => act("/pause", { paused: !s.paused })}
              >
                {s.paused ? (
                  <>
                    <Play size={15} aria-hidden /> Activar agente
                  </>
                ) : (
                  <>
                    <Pause size={15} aria-hidden /> Pausar
                  </>
                )}
              </button>
            </div>
          </div>
          {error && (
            <div className="banner down" role="alert">
              <TriangleAlert size={18} aria-hidden />
              <p>{error}</p>
              <button
                className="icon"
                onClick={() => setError("")}
                aria-label="Cerrar error"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
          )}
          {!ready && (
            <div className="banner">
              <PlugZap size={18} aria-hidden />
              <p>
                <strong>Tu laboratorio está preparado para conectar.</strong>{" "}
                Configura{" "}
                {(!s.connection.alpaca ? "las claves de Alpaca Paper" : "") +
                  (!s.connection.alpaca && !s.connection.model ? " y " : "") +
                  (!s.connection.model ? "el proveedor del modelo" : "")}{" "}
                en el servidor. El agente permanece pausado.
              </p>
              <button onClick={() => setTab("Configuración")}>
                Ver conexiones
              </button>
            </div>
          )}
          {s.feeds && (!s.feeds.trades || !s.feeds.clock) && (
            <div className="banner down" role="status">
              <TriangleAlert size={18} aria-hidden />
              <p>
                Alpaca no está devolviendo{" "}
                {!s.feeds.trades && !s.feeds.clock
                  ? "precios ni el calendario de mercado"
                  : !s.feeds.trades
                    ? "precios de mercado"
                    : "el calendario de mercado"}
                . El saldo y las posiciones siguen sincronizándose. No se
                enviarán órdenes hasta que vuelva a responder.
              </p>
            </div>
          )}
          {tab === "Resumen" && <Summary {...view} />}
          {tab === "Mercado" && <Market {...view} />}
          {tab === "Decisiones" && <Decisions {...view} />}
          {tab === "Vigilancias" && <Watches {...view} />}
          {tab === "Aprendizaje" && <Learning {...view} />}
          {tab === "Configuración" && <SettingsView {...view} />}
          <footer>
            MERIDIAN <span>Laboratorio personal de agentes · v0.1</span>
            <span>Datos de tu cuenta. Sin resultados de ejemplo.</span>
          </footer>
        </div>
      </main>
      {selected && (
        <DecisionDetail
          s={s}
          busy={busy}
          act={act}
          selected={selected}
          setSelected={setSelected}
          detail={detail}
        />
      )}
      <Palette
        open={palette}
        onOpenChange={setPalette}
        s={s}
        busy={busy}
        ready={ready}
        goTo={setTab}
        openDecision={setSelected}
        act={act}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <Tooltip.Provider>
    <App />
    <Toaster
      position="bottom-right"
      theme="system"
      closeButton
      toastOptions={{ className: "toast" }}
    />
  </Tooltip.Provider>,
);
