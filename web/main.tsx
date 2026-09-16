import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Toaster, toast } from "sonner";
import { Command } from "cmdk";
import {
  LayoutDashboard,
  ChartCandlestick,
  GitCompare,
  ListChecks,
  Crosshair,
  BookOpen,
  Gauge,
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
  ArrowLeftRight,
  X,
} from "lucide-react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import type { Decision } from "../src/domain";
import { SIMS, isSimId, type SimId, type SimSummary } from "../src/sims";
import { riskProfileOf } from "../src/risk";
import { money, date, marketOpen, marketText, pct, tone } from "./shared";
import { Badge, Chip, Hint } from "./ui";
import { Market } from "./market";
import type { Data } from "./views/types";
import { Summary } from "./views/summary";
import { Decisions } from "./views/decisions";
import { Watches } from "./views/watches";
import { Learning } from "./views/learning";
import { SettingsView } from "./views/settings";
import { Usage } from "./views/usage";
import { Compare } from "./views/compare";
import { DecisionDetail } from "./views/decision-detail";
import "./style.css";
const TABS: {
  name: string;
  icon: typeof LayoutDashboard;
  title: string;
  text: string;
  // Palabras de más para encontrarla en el buscador.
  keywords?: string;
}[] = [
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
    name: "Comparar",
    icon: GitCompare,
    title: "Comparar simulaciones",
    text: "Las dos en el mismo periodo, con los mismos precios y límites.",
    keywords: "simulaciones alpaca interna resultado niveles de riesgo",
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
    name: "Uso",
    icon: Gauge,
    title: "Uso",
    text: "Cuántos tokens gasta el modelo y en qué.",
  },
  {
    name: "Configuración",
    icon: Settings,
    title: "Configuración",
    text: "Tú defines los límites. El agente decide dentro de ellos.",
  },
];
// Todo lo que es de una simulación va por su ruta.
const apiFor = (sim: SimId) => (path: string) => `/sims/${sim}${path}`;
// La simulación elegida se guarda en ?sim=, para que una recarga o un enlace la
// conserven, y en el navegador, para abrir el panel donde se dejó. Sin ninguna
// de las dos, Alpaca.
const SIM_STORAGE = "meridian.sim";
function savedSim(): SimId {
  try {
    const x = new URLSearchParams(location.search).get("sim");
    if (isSimId(x)) return x;
  } catch {}
  try {
    const x = localStorage.getItem(SIM_STORAGE);
    if (isSimId(x)) return x;
  } catch {}
  return "alpaca";
}
function rememberSim(sim: SimId) {
  try {
    const u = new URL(location.href);
    u.searchParams.set("sim", sim);
    history.replaceState(history.state, "", u);
  } catch {}
  try {
    localStorage.setItem(SIM_STORAGE, sim);
  } catch {}
}
const riskLabel = (riskProfile: string | undefined) =>
  riskProfileOf({ riskProfile }).label;
const simName = (x: Pick<SimSummary, "id" | "riskProfile">) =>
  `${SIMS[x.id].label} · ${riskLabel(x.riskProfile)}`;
// Resultado desde el inicio, en %, o null si aún no hay cuenta.
const resultPct = (x: Pick<SimSummary, "equity" | "baseline">) =>
  x.equity !== null && x.baseline
    ? ((x.equity - x.baseline) / x.baseline) * 100
    : null;
// Cómo está cada simulación, en una palabra y un color.
function simStatus(x: SimSummary) {
  if (x.unresolved > 0)
    return {
      kind: "down",
      text: `${x.unresolved} ${x.unresolved === 1 ? "orden" : "órdenes"} por reconciliar`,
    };
  if (x.paused) return { kind: "", text: "Pausada" };
  if (x.evaluating) return { kind: "busy", text: "Evaluando" };
  return { kind: "on", text: "Observando" };
}
// Aviso tras una acción que sale bien. El resto dice solo que se guardó.
function done(url: string, body: unknown) {
  const id = url.match(/^\/sims\/([^/]+)\//)?.[1];
  const label = isSimId(id) ? SIMS[id].label : "el agente";
  return url.endsWith("/wake")
    ? `Evaluación pedida a ${label}`
    : url.endsWith("/pause")
      ? (body as { paused: boolean }).paused
        ? `${label}: pausada`
        : `${label}: activada`
      : url.endsWith("/orders/cancel-open")
        ? `${label}: pausada y órdenes canceladas`
        : "Cambios guardados";
}
// El selector de simulación de la cabecera. Siempre visible: cada botón dice
// cuál es, su nivel, cómo está y cómo va.
function SimSwitch(p: {
  sims: SimSummary[];
  sim: SimId;
  onChange: (sim: SimId) => void;
}) {
  return (
    <div className="sim-switch" role="group" aria-label="Simulación">
      {p.sims.map((x) => {
        const estado = simStatus(x),
          resultado = resultPct(x),
          actual = x.id === p.sim;
        return (
          <Hint
            key={x.id}
            label={`${simName(x)}. ${estado.text}. ${
              x.broker === "internal"
                ? "Ejecuta sus órdenes dentro de Meridian."
                : "Envía sus órdenes a Alpaca Paper."
            }`}
          >
            <button
              type="button"
              className={"sim-option sim-" + x.id + (actual ? " current" : "")}
              aria-pressed={actual}
              onClick={() => p.onChange(x.id)}
            >
              <i className={"sim-dot " + estado.kind} aria-hidden />
              <span className="sim-text">
                <b>{SIMS[x.id].label}</b>
                <small>{riskLabel(x.riskProfile)}</small>
              </span>
              <span className={"sim-result num " + tone(resultado)}>
                {pct(resultado)}
              </span>
              <span className="sr-only">{estado.text}</span>
            </button>
          </Hint>
        );
      })}
    </div>
  );
}
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
  api: (path: string) => string;
  sim: SimId;
  sims: SimSummary[];
  paused: boolean;
  chooseSim: (sim: SimId) => void;
  pauseAll: () => void;
}) {
  const run = (fn: () => void) => {
    p.onOpenChange(false);
    fn();
  };
  const label = SIMS[p.sim].label;
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
        <Command.Group heading="Simulación">
          {p.sims
            .filter((x) => x.id !== p.sim)
            .map((x) => (
              <Command.Item
                key={x.id}
                value={`cambiar a ${simName(x)} simulación ${x.id}`}
                onSelect={() => run(() => p.chooseSim(x.id))}
              >
                <ArrowLeftRight size={16} aria-hidden />
                Cambiar a {simName(x)}
              </Command.Item>
            ))}
        </Command.Group>
        <Command.Group heading="Ir a">
          {TABS.map((t) => (
            <Command.Item
              key={t.name}
              value={`ir a ${t.name} ${t.keywords ?? ""}`}
              onSelect={() => run(() => p.goTo(t.name))}
            >
              <t.icon size={16} aria-hidden />
              {t.name}
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group heading="Acciones">
          <Command.Item
            value={`reevaluar ${label} ahora`}
            disabled={p.busy}
            onSelect={() => run(() => p.act(p.api("/wake")))}
          >
            <RefreshCw size={16} aria-hidden />
            Reevaluar {label}
          </Command.Item>
          <Command.Item
            value={`${p.paused ? "activar" : "pausar"} ${label} agente`}
            disabled={p.busy || (p.paused && !p.ready)}
            onSelect={() =>
              run(() => p.act(p.api("/pause"), { paused: !p.paused }))
            }
          >
            {p.paused ? (
              <Play size={16} aria-hidden />
            ) : (
              <Pause size={16} aria-hidden />
            )}
            {p.paused ? `Activar ${label}` : `Pausar ${label}`}
          </Command.Item>
          {p.sims.filter((x) => !x.paused).length > 1 && (
            <Command.Item
              value="pausar las dos simulaciones agente"
              disabled={p.busy}
              onSelect={() => run(p.pauseAll)}
            >
              <Pause size={16} aria-hidden />
              Pausar las dos
            </Command.Item>
          )}
        </Command.Group>
        {p.s.decisions.length > 0 && (
          <Command.Group heading={`Decisiones recientes de ${label}`}>
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
// Aviso de un refresco fallido. El siguiente que funciona lo quita: tras un
// despliegue la API vuelve en unos segundos y el aviso se quedaba puesto.
const SIN_CONEXION =
  "Sin conexión con el servidor. Los datos pueden estar desactualizados.";
function App() {
  const [data, setData] = useState<Data | null>(null),
    [auth, setAuth] = useState<boolean | null>(null),
    [tab, setTab] = useState("Resumen"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [palette, setPalette] = useState(false),
    [selected, setSelected] = useState<Decision | null>(null),
    [detail, setDetail] = useState<{ id: string; input: unknown } | null>(null),
    [sim, setSim] = useState<SimId>(savedSim);
  // La simulación elegida, también para las respuestas que llegan tarde.
  const simRef = useRef(sim);
  const simApi = apiFor(sim);
  async function refresh() {
    const pedida = simRef.current;
    const r = await fetch("/api" + apiFor(pedida)("/state"));
    if (r.status === 401) {
      setAuth(false);
      return;
    }
    if (!r.ok) throw new Error("No se puede cargar el panel");
    const d: Data = await r.json();
    // Una respuesta de la otra simulación, pedida antes de cambiar, no se pinta.
    if (d.sim !== simRef.current) return;
    setData(d);
    setAuth(true);
    setError((e) => (e === SIN_CONEXION ? "" : e));
  }
  function chooseSim(next: SimId) {
    if (next === simRef.current) return;
    simRef.current = next;
    // El detalle abierto es de la otra simulación.
    setSelected(null);
    setDetail(null);
    setSim(next);
    rememberSim(next);
  }
  useEffect(() => {
    rememberSim(sim);
    if (auth) refresh().catch((e) => setError(e.message));
  }, [sim]);
  async function pauseAll() {
    setBusy(true);
    try {
      for (const x of data?.sims ?? [])
        if (!x.paused) await api(apiFor(x.id)("/pause"), { paused: true });
      await refresh();
      toast.success("Las dos simulaciones están pausadas");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const t = setInterval(
      () => refresh().catch(() => setError(SIN_CONEXION)),
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
    fetch("/api" + simApi(`/decisions/${target}`))
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
  }, [selected?.id, sim]);
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
    // Hasta que llega el estado de la simulación recién elegida, la cabecera ya
    // habla de ella con su resumen y el contenido espera.
    stale = s.sim !== sim,
    sims: SimSummary[] = s.sims ?? [],
    chosen = sims.find((x) => x.id === sim) ?? null,
    paused = chosen?.paused ?? s.paused,
    label = SIMS[sim].label,
    interna = SIMS[sim].broker === "internal",
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
  const equity = chosen ? chosen.equity : Number(s.account?.equity),
    baseline = chosen ? chosen.baseline : s.baseline,
    delta =
      equity !== null && Number.isFinite(equity) && baseline
        ? equity - baseline
        : null;
  const agent = paused
    ? { kind: "", text: "Pausado" }
    : !alive
      ? { kind: "down", text: "Worker sin señal" }
      : (chosen?.evaluating ?? s.modelJob)
        ? { kind: "busy", text: "Evaluando" }
        : { kind: "on", text: "Observando" };
  const risk = riskProfileOf({
    riskProfile: chosen?.riskProfile ?? s.settings.riskProfile,
  });
  const view = {
    s,
    busy,
    act,
    openDecision: setSelected,
    goTo: setTab,
    setError,
    sim,
    api: simApi,
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
          <span className="paper">{label.toUpperCase()}</span>
          <strong className="num">{money(equity)}</strong>
          <div className="aside-delta">
            {delta !== null && baseline ? (
              <>
                <Chip value={(delta / baseline) * 100} />
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
          <SimSwitch sims={sims} sim={sim} onChange={chooseSim} />
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
            <Hint
              label={`Nivel de ${label}. Revisa el mercado cada ${risk.scanEveryMinutes} min como máximo. Se cambia en Configuración.`}
            >
              <button
                type="button"
                className="pill risk"
                onClick={() => setTab("Configuración")}
              >
                Riesgo {risk.label}
              </button>
            </Hint>
            <span className={"badge sim" + (interna ? " internal" : "")}>
              {interna
                ? "Interna: no envía órdenes a Alpaca"
                : "Solo simulación"}
            </span>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <h1>{current.title}</h1>
              <p className="muted">{current.text}</p>
            </div>
            <div className="actions">
              <Hint
                label={`Pide a ${label} una evaluación ahora, sin esperar a un evento.`}
              >
                <button
                  className="with-icon"
                  disabled={busy || stale}
                  onClick={() => act(simApi("/wake"))}
                >
                  <RefreshCw size={15} aria-hidden /> Reevaluar
                </button>
              </Hint>
              <button
                className="primary with-icon"
                disabled={busy || stale || (paused && !ready)}
                onClick={() => act(simApi("/pause"), { paused: !paused })}
              >
                {paused ? (
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
          {stale ? (
            <p className="loading" role="status">
              <LoaderCircle className="spin" size={18} aria-hidden />
              Cargando {label}…
            </p>
          ) : (
            // Cambiar de simulación monta la vista de nuevo: paginación, filtros
            // y formularios a medias no pasan de una a otra.
            <div key={sim} className="sim-view">
              {tab === "Resumen" && <Summary {...view} />}
              {tab === "Mercado" && <Market {...view} />}
              {tab === "Comparar" && <Compare {...view} />}
              {tab === "Decisiones" && <Decisions {...view} />}
              {tab === "Vigilancias" && <Watches {...view} />}
              {tab === "Aprendizaje" && <Learning {...view} />}
              {tab === "Uso" && <Usage {...view} />}
              {tab === "Configuración" && <SettingsView {...view} />}
            </div>
          )}
          <footer>
            MERIDIAN <span>Laboratorio personal de agentes · v0.1</span>
            <span>Datos de tu cuenta. Sin resultados de ejemplo.</span>
          </footer>
        </div>
      </main>
      {selected && !stale && (
        <DecisionDetail
          s={s}
          busy={busy}
          act={act}
          api={simApi}
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
        api={simApi}
        sim={sim}
        sims={sims}
        paused={paused}
        chooseSim={chooseSim}
        pauseAll={pauseAll}
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
