import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { State, Decision } from "../src/domain";
import "./style.css";
type Data = State & {
  totals: { decisions: number; events: number; equity: number };
  connection: { alpaca: boolean; model: boolean; modelName: string | null };
};
const money = (n: number | string | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(Number(n));
const date = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleString("es-ES", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
const labels: Record<string, string> = {
  active: "Vigilando",
  triggered: "Activada",
  expired: "Caducada",
  cancelled: "Cancelada",
  invalidated: "Invalidada",
  proposed: "Propuesta",
  accepted: "Aceptada",
  rejected: "Descartada",
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
function Badge({ value }: { value: string }) {
  return <span className={"badge " + value}>{labels[value] ?? value}</span>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <span>◇</span>
      <p>{children}</p>
    </div>
  );
}
function Chart({ values }: { values: { at: string; value: number }[] }) {
  if (values.length < 2)
    return (
      <Empty>
        La curva aparecerá cuando haya dos muestras de tu cuenta simulada.
      </Empty>
    );
  const lo = Math.min(...values.map((v) => v.value)),
    hi = Math.max(...values.map((v) => v.value)),
    range = hi - lo || 1;
  const points = values
    .map(
      (v, i) =>
        `${(i / (values.length - 1)) * 900},${160 - ((v.value - lo) / range) * 140}`,
    )
    .join(" ");
  return (
    <>
      <svg
        className="chart"
        viewBox="0 0 900 190"
        role="img"
        aria-label={`Patrimonio: ${money(values[0].value)} a ${money(values.at(-1)!.value)}`}
      >
        <line x1="0" x2="900" y1="160" y2="160" stroke="#e4e8ec" />
        <line
          x1="0"
          x2="900"
          y1="90"
          y2="90"
          stroke="#e4e8ec"
          strokeDasharray="5 5"
        />
        <polyline
          points={points}
          fill="none"
          stroke="#4d7e22"
          strokeWidth="3"
        />
      </svg>
      <div className="between muted">
        <span>{date(values[0].at)}</span>
        <span>{date(values.at(-1)!.at)}</span>
      </div>
    </>
  );
}
function App() {
  const [data, setData] = useState<Data | null>(null),
    [auth, setAuth] = useState<boolean | null>(null),
    [tab, setTab] = useState("Resumen"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Decision | null>(null),
    [showWatch, setShowWatch] = useState(false),
    [showLesson, setShowLesson] = useState(false),
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
  async function act(url: string, body?: unknown, method = "POST") {
    setBusy(true);
    setError("");
    try {
      await api(url, body, method);
      await refresh();
      setNotice("Cambios guardados");
      return true;
    } catch (e) {
      setError((e as Error).message);
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
  useEffect(() => {
    if (!selected) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
      if (e.key === "Tab") {
        const els = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".modal button:not(:disabled),.modal summary,.modal input",
          ),
        );
        const first = els[0],
          last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [selected]);
  if (auth === false)
    return (
      <div className="login">
        <div className="login-box">
          <div className="brand">
            <b className="mark">M</b> meridian<span>LAB</span>
          </div>
          <h1>
            Tu laboratorio.
            <br />
            Tu agente.
          </h1>
          <p className="muted">Acceso privado · Solo simulación</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              await act("/login", { password: f.get("password") });
            }}
          >
            <label>
              Contraseña
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                autoFocus
              />
            </label>
            <button disabled={busy} className="primary">
              Entrar al laboratorio →
            </button>
          </form>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  if (!data)
    return (
      <div className="login">
        <p>{error || "Conectando con Meridian…"}</p>
      </div>
    );
  const s = data,
    active = s.watches.filter((w) => w.status === "active"),
    v = s.versions.find((v) => v.id === s.activeVersion)!,
    ready = s.connection.alpaca && s.connection.model,
    alive = s.heartbeat && Date.now() - Date.parse(s.heartbeat) < 120000;
  const delta =
    s.account && s.baseline ? Number(s.account.equity) - s.baseline : null;
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <b className="mark">M</b> meridian<span>LAB</span>
        </div>
        <div className="workspace">ESPACIO PERSONAL</div>
        <nav aria-label="Navegación principal">
          {[
            "Resumen",
            "Decisiones",
            "Vigilancias",
            "Aprendizaje",
            "Configuración",
          ].map((name, i) => (
            <button
              key={name}
              onClick={() => setTab(name)}
              className={tab === name ? "current" : ""}
            >
              <span>{["◈", "≡", "◎", "◇", "⚙"][i]}</span>
              {name}
              {name === "Vigilancias" && <small>{active.length}</small>}
            </button>
          ))}
        </nav>
        <div className="aside-bottom">
          <span className="paper">ALPACA PAPER</span>
          <p>
            Capital ficticio.
            <br />
            Decisiones reales que estudiar.
          </p>
          <button onClick={() => act("/logout")}>Cerrar sesión ↗</button>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            Laboratorio <span>/</span> {tab}
          </div>
          <div className="header-right">
            <span className="badge">Solo simulación</span>
            <span className={"status " + (!s.paused && alive ? "running" : "")}>
              {s.paused ? "Pausado" : alive ? "Observando" : "Worker sin señal"}
            </span>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                MERIDIAN /{" "}
                {String(
                  [
                    "Resumen",
                    "Decisiones",
                    "Vigilancias",
                    "Aprendizaje",
                    "Configuración",
                  ].indexOf(tab) + 1,
                ).padStart(2, "0")}
              </div>
              <h1>{tab === "Resumen" ? "El pulso de tu agente" : tab}</h1>
              <p className="muted">
                {
                  (
                    {
                      Resumen: "Observa sus decisiones. Entiende su evolución.",
                      Decisiones:
                        "Cada hipótesis, su contexto y lo que ocurrió después.",
                      Vigilancias:
                        "El agente espera condiciones, no horas en el calendario.",
                      Aprendizaje:
                        "Experiencias que se convierten en hipótesis comprobables.",
                      Configuración:
                        "Tú defines los límites. El agente decide dentro de ellos.",
                    } as any
                  )[tab]
                }
              </p>
            </div>
            <div className="actions">
              <button disabled={busy} onClick={() => act("/wake")}>
                Reevaluar
              </button>
              <button
                className="primary"
                disabled={busy || (!s.paused ? false : !ready)}
                onClick={() => act("/pause", { paused: !s.paused })}
              >
                {s.paused ? "▶ Activar agente" : "Ⅱ Pausar"}
              </button>
            </div>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
              <button onClick={() => setError("")} aria-label="Cerrar error">
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="alert" role="status">
              {notice}
              <button onClick={() => setNotice("")} aria-label="Cerrar aviso">
                ×
              </button>
            </div>
          )}
          {!ready && (
            <div className="setup">
              <div>
                <strong>Tu laboratorio está preparado para conectar.</strong>
                <p>
                  Configura{" "}
                  {(!s.connection.alpaca ? "las claves de Alpaca Paper" : "") +
                    (!s.connection.alpaca && !s.connection.model ? " y " : "") +
                    (!s.connection.model ? "el proveedor del modelo" : "")}{" "}
                  en el servidor. El agente permanece pausado.
                </p>
              </div>
              <button onClick={() => setTab("Configuración")}>
                Ver conexiones ↗
              </button>
            </div>
          )}
          {tab === "Resumen" && (
            <>
              <div className="metrics">
                <article>
                  <label>Patrimonio simulado</label>
                  <strong>{money(s.account?.equity)}</strong>
                  <small>Cuenta sincronizada {date(s.lastSync)}</small>
                </article>
                <article>
                  <label>Variación desde el inicio</label>
                  <strong
                    className={
                      delta !== null && delta < 0 ? "negative" : "positive"
                    }
                  >
                    {money(delta)}
                  </strong>
                  <small>Incluye cambios de mercado y de saldo</small>
                </article>
                <article>
                  <label>Vigilancias activas</label>
                  <strong>{active.length.toString().padStart(2, "0")}</strong>
                  <small>{s.queue.length} eventos pendientes</small>
                </article>
                <article>
                  <label>Evaluaciones hoy · UTC</label>
                  <strong>
                    {s.calls.day === new Date().toISOString().slice(0, 10)
                      ? s.calls.count
                      : 0}
                    <em> / {s.settings.maxDailyCalls}</em>
                  </strong>
                  <small>
                    {s.lessons.filter((l) => l.status === "proposed").length}{" "}
                    lecciones por revisar
                  </small>
                </article>
              </div>
              <div className="dashboard-grid">
                <section className="panel">
                  <div className="section-title">
                    <h2>Evolución del patrimonio</h2>
                    <span className="muted">USD · últimas 120 muestras</span>
                  </div>
                  <Chart values={s.equity.slice(-120)} />
                </section>
                <section className="panel agent-card">
                  <div className="section-title">
                    <h2>Estado del agente</h2>
                    <span className="orbit">◎</span>
                  </div>
                  <h3>
                    {s.paused
                      ? "En pausa"
                      : s.queue.length
                        ? "Tiene algo que revisar"
                        : "Esperando una condición"}
                  </h3>
                  <p>
                    {s.paused
                      ? "Actívalo cuando hayas revisado los límites y las conexiones."
                      : "La vigilancia funciona sin consultar al modelo en cada cambio de precio."}
                  </p>
                  <dl>
                    <div>
                      <dt>Conexión de mercado</dt>
                      <dd>
                        {s.stream === "connected"
                          ? "Conectada"
                          : "Sin señal reciente"}
                      </dd>
                    </div>
                    <div>
                      <dt>Última evaluación</dt>
                      <dd>{date(s.lastDecision)}</dd>
                    </div>
                    <div>
                      <dt>Worker</dt>
                      <dd>{alive ? "Conectado" : "Sin señal"}</dd>
                    </div>
                  </dl>
                </section>
              </div>
              <section className="panel">
                <div className="section-title">
                  <h2>Posiciones</h2>
                  <span className="muted">
                    Efectivo {money(s.account?.cash)}
                  </span>
                </div>
                {!s.positions.length ? (
                  <Empty>
                    No hay posiciones. Aquí aparecerán las compras ejecutadas en
                    Alpaca Paper.
                  </Empty>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Activo</th>
                          <th>Unidades</th>
                          <th>Valor</th>
                          <th>Resultado no realizado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.positions.map((p) => (
                          <tr key={p.symbol}>
                            <td>
                              <strong>{p.symbol}</strong>
                            </td>
                            <td>{p.qty}</td>
                            <td>{money(p.market_value)}</td>
                            <td>{money(p.unrealized_pl)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section className="panel">
                <div className="section-title">
                  <h2>Actividad reciente</h2>
                  <span className="muted">Registro del laboratorio</span>
                </div>
                {s.events.length ? (
                  s.events.slice(0, 8).map((e) => (
                    <div className="event" key={e.id}>
                      <span className="event-type">{e.type}</span>
                      <p>{e.message}</p>
                      <time>{date(e.at)}</time>
                    </div>
                  ))
                ) : (
                  <Empty>Todo comienza con una primera observación.</Empty>
                )}
              </section>
            </>
          )}
          {tab === "Decisiones" && (
            <section className="panel">
              <div className="section-title">
                <h2>Historial completo</h2>
                <span className="muted">{s.totals.decisions} decisiones</span>
              </div>
              {!s.decisions.length ? (
                <Empty>
                  Cuando el agente evalúe un evento, guardará aquí su
                  información, hipótesis y decisión.
                </Empty>
              ) : (
                <div className="decision-list">
                  {[...s.decisions].reverse().map((d) => (
                    <button
                      className="decision"
                      key={d.id}
                      onClick={() => setSelected(d)}
                    >
                      <div>
                        <Badge value={d.proposal.action} />
                        <strong>{d.proposal.symbol || "Mercado"}</strong>
                        <time>{date(d.at)}</time>
                      </div>
                      <p>{d.proposal.reason}</p>
                      <div>
                        <Badge value={d.status} />
                        <span className="muted">
                          {d.review
                            ? "Revisión disponible"
                            : "Revisar " + date(d.reviewAt)}
                        </span>
                        <span>Ver detalle ↗</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          {tab === "Vigilancias" && (
            <>
              <div className="section-title">
                <h2>{active.length} condiciones en observación</h2>
                <button onClick={() => setShowWatch(!showWatch)}>
                  + Nueva vigilancia
                </button>
              </div>
              {showWatch && (
                <form
                  className="panel form-grid"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    if (
                      await act("/watches", {
                        symbol: f.get("symbol"),
                        operator: f.get("operator"),
                        price: Number(f.get("price")),
                        expiresAt: new Date(
                          String(f.get("expires")),
                        ).toISOString(),
                        reason: f.get("reason"),
                        invalidateBelow: f.get("below")
                          ? Number(f.get("below"))
                          : null,
                        invalidateAbove: f.get("above")
                          ? Number(f.get("above"))
                          : null,
                      })
                    )
                      setShowWatch(false);
                  }}
                >
                  <label>
                    Activo
                    <select name="symbol">
                      {s.settings.symbols.map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Condición
                    <select name="operator">
                      <option value="lte">Precio igual o menor que</option>
                      <option value="gte">Precio igual o mayor que</option>
                    </select>
                  </label>
                  <label>
                    Precio USD
                    <input
                      name="price"
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                    />
                  </label>
                  <label>
                    Caducidad local
                    <input name="expires" type="datetime-local" required />
                  </label>
                  <label>
                    Invalidar por debajo (opcional)
                    <input name="below" type="number" min="0.01" step="0.01" />
                  </label>
                  <label>
                    Invalidar por encima (opcional)
                    <input name="above" type="number" min="0.01" step="0.01" />
                  </label>
                  <label className="wide">
                    Qué debe reevaluar
                    <textarea
                      name="reason"
                      minLength={5}
                      maxLength={2000}
                      required
                    />
                  </label>
                  <button className="primary" disabled={busy}>
                    Guardar vigilancia
                  </button>
                </form>
              )}
              <div className="watch-grid">
                {[...s.watches].reverse().map((w) => (
                  <article className="panel watch-card" key={w.id}>
                    <div className="section-title">
                      <h2>{w.symbol}</h2>
                      <Badge value={w.status} />
                    </div>
                    <div className="target">
                      {w.operator === "lte" ? "≤" : "≥"} {money(w.price)}
                    </div>
                    <p>{w.reason}</p>
                    <dl>
                      <div>
                        <dt>Último precio</dt>
                        <dd>{money(s.quotes[w.symbol]?.price)}</dd>
                      </div>
                      <div>
                        <dt>Fecha del precio</dt>
                        <dd>{date(s.quotes[w.symbol]?.at)}</dd>
                      </div>
                      <div>
                        <dt>Caduca</dt>
                        <dd>{date(w.expiresAt)}</dd>
                      </div>
                      {w.invalidateBelow && (
                        <div>
                          <dt>Invalidar ≤</dt>
                          <dd>{money(w.invalidateBelow)}</dd>
                        </div>
                      )}
                      {w.invalidateAbove && (
                        <div>
                          <dt>Invalidar ≥</dt>
                          <dd>{money(w.invalidateAbove)}</dd>
                        </div>
                      )}
                    </dl>
                    <div className="between">
                      <small>Activación única · Reevaluar</small>
                      {w.status === "active" && (
                        <button
                          disabled={busy}
                          onClick={() => act(`/watches/${w.id}/cancel`)}
                        >
                          Cancelar
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {!s.watches.length && (
                <section className="panel">
                  <Empty>
                    Añade una condición o deja que el agente proponga sus
                    propias vigilancias al analizar el mercado.
                  </Empty>
                </section>
              )}
            </>
          )}
          {tab === "Aprendizaje" && (
            <>
              <div className="section-title">
                <h2>Memoria del agente</h2>
                <button onClick={() => setShowLesson(!showLesson)}>
                  + Aportar conocimiento
                </button>
              </div>
              <p className="muted">
                Aceptar una lección crea una nueva versión. Las propuestas no se
                incorporan automáticamente a su memoria activa.
              </p>
              {showLesson && (
                <form
                  className="panel form-grid"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    if (await act("/lessons", Object.fromEntries(f)))
                      setShowLesson(false);
                  }}
                >
                  <label className="wide">
                    Título
                    <input
                      name="title"
                      minLength={3}
                      maxLength={150}
                      required
                    />
                  </label>
                  <label className="wide">
                    Lección, contexto y excepciones
                    <textarea
                      name="body"
                      minLength={10}
                      maxLength={4000}
                      required
                    />
                  </label>
                  <label className="wide">
                    Fuente o referencia
                    <input
                      name="source"
                      minLength={3}
                      maxLength={1000}
                      placeholder="URL, libro, experiencia documentada…"
                      required
                    />
                  </label>
                  <button className="primary" disabled={busy}>
                    Añadir propuesta
                  </button>
                </form>
              )}
              {!s.lessons.length ? (
                <section className="panel">
                  <Empty>
                    Aquí se reunirán las lecciones de sus revisiones y el
                    conocimiento que tú aportes.
                  </Empty>
                </section>
              ) : (
                [...s.lessons].reverse().map((l) => (
                  <article className="panel lesson" key={l.id}>
                    <div className="section-title">
                      <h2>{l.title}</h2>
                      <Badge value={l.status} />
                    </div>
                    <p className="preserve">{l.body}</p>
                    <p className="muted source">Fuente: {l.source}</p>
                    <div className="between">
                      <span className="muted">{date(l.createdAt)}</span>
                      <div className="actions">
                        {l.status !== "rejected" && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              act(`/lessons/${l.id}/status`, {
                                status: "rejected",
                              })
                            }
                          >
                            Descartar
                          </button>
                        )}
                        {l.status !== "accepted" && (
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() =>
                              act(`/lessons/${l.id}/status`, {
                                status: "accepted",
                              })
                            }
                          >
                            Aceptar en nueva versión
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                ))
              )}
            </>
          )}
          {tab === "Configuración" && (
            <>
              <div className="connections">
                <section className="panel">
                  <h2>Alpaca Paper</h2>
                  <Badge
                    value={
                      s.connection.alpaca ? "Configurado" : "Sin configurar"
                    }
                  />
                  <p>
                    Claves de simulación en ALPACA_KEY_ID y ALPACA_SECRET_KEY.
                    La conexión se verifica al sincronizar la cuenta.
                  </p>
                  <small>Última sincronización: {date(s.lastSync)}</small>
                </section>
                <section className="panel">
                  <h2>Modelo</h2>
                  <Badge
                    value={
                      s.connection.model ? "Configurado" : "Sin configurar"
                    }
                  />
                  <p>
                    {s.connection.modelName ||
                      "Configura LLM_API_KEY y LLM_MODEL en el servidor."}
                  </p>
                  <small>
                    Compatible con Chat Completions y respuesta JSON.
                  </small>
                </section>
              </div>
              <form
                className="panel form-grid"
                key={JSON.stringify(s.settings)}
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget),
                    values: any = {};
                  for (const [k, val] of f)
                    values[k] =
                      k === "symbols"
                        ? String(val)
                            .split(",")
                            .map((x) => x.trim().toUpperCase())
                            .filter(Boolean)
                        : Number(val);
                  act("/settings", values, "PUT");
                }}
              >
                <h2 className="wide">Límites operativos</h2>
                <label className="wide">
                  Activos permitidos, separados por comas
                  <input
                    name="symbols"
                    defaultValue={s.settings.symbols.join(", ")}
                    required
                  />
                </label>
                {(
                  [
                    ["maxOrderUsd", "Máximo por orden · USD", 1, 10000],
                    ["maxPositionUsd", "Máximo por posición · USD", 1, 100000],
                    ["maxExposureUsd", "Exposición máxima · USD", 1, 100000],
                    ["maxDailyOrders", "Órdenes diarias · UTC", 1, 100],
                    [
                      "maxDailyCalls",
                      "Llamadas al modelo al día · UTC",
                      1,
                      200,
                    ],
                    [
                      "maxDrawdownPct",
                      "Pérdida desde saldo inicial · %",
                      1,
                      50,
                    ],
                    [
                      "cooldownSeconds",
                      "Espera mínima entre evaluaciones · segundos",
                      60,
                      86400,
                    ],
                  ] as const
                ).map(([k, label, min, max]) => (
                  <label key={k}>
                    {label}
                    <input
                      name={k}
                      type="number"
                      min={min}
                      max={max}
                      step="1"
                      defaultValue={s.settings[k]}
                      required
                    />
                  </label>
                ))}
                <p className="muted wide">
                  El umbral de pérdida bloquea compras nuevas. Pausar no vende
                  posiciones ni cancela órdenes ya enviadas.
                </p>
                <button className="primary" disabled={busy}>
                  Guardar límites
                </button>
              </form>
              <form
                className="panel"
                key={v.id}
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  act("/versions", Object.fromEntries(f));
                }}
              >
                <div className="section-title">
                  <h2>Instrucciones del agente</h2>
                  <span className="muted">{s.versions.length} versiones</span>
                </div>
                <label>
                  Instrucciones activas
                  <textarea
                    name="instructions"
                    defaultValue={v.instructions}
                    minLength={30}
                    maxLength={12000}
                    rows={7}
                    required
                  />
                </label>
                <label>
                  Motivo del cambio
                  <input
                    name="note"
                    minLength={3}
                    maxLength={300}
                    required
                    placeholder="Qué esperas mejorar con esta versión"
                  />
                </label>
                <button className="primary" disabled={busy}>
                  Crear y activar versión
                </button>
              </form>
              <section className="panel">
                <h2>Versiones</h2>
                {[...s.versions].reverse().map((x) => (
                  <div className="event" key={x.id}>
                    <p>
                      <strong>{x.note}</strong>
                      <br />
                      <small>
                        {date(x.createdAt)} · {x.lessonIds.length} lecciones
                      </small>
                    </p>
                    {x.id === s.activeVersion ? (
                      <Badge value="Activa" />
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() => act(`/versions/${x.id}/activate`)}
                      >
                        Recuperar
                      </button>
                    )}
                  </div>
                ))}
              </section>
              <section className="panel">
                <h2>Detener operaciones pendientes</h2>
                <p>
                  Pausa el agente y solicita a Alpaca cancelar todas las órdenes
                  abiertas de esta cuenta. Usa una cuenta Paper exclusiva para
                  Meridian.
                </p>
                <button
                  className="danger"
                  disabled={busy || !s.connection.alpaca}
                  onClick={() => {
                    if (
                      confirm(
                        "¿Pausar y solicitar la cancelación de todas las órdenes abiertas de esta cuenta Paper?",
                      )
                    )
                      act("/orders/cancel-open");
                  }}
                >
                  Pausar y cancelar órdenes
                </button>
              </section>
            </>
          )}
          <footer>
            MERIDIAN <span>Laboratorio personal de agentes · v0.1</span>
            <span>Datos de tu cuenta. Sin resultados de ejemplo.</span>
          </footer>
        </div>
      </main>
      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-title">
              <h2 id="detail-title">
                Decisión · {selected.proposal.symbol || "Mercado"}
              </h2>
              <button
                onClick={() => setSelected(null)}
                autoFocus
                aria-label="Cerrar detalle"
              >
                ×
              </button>
            </div>
            <Badge value={selected.proposal.action} />
            <Badge value={selected.status} />
            <p>{selected.proposal.reason}</p>
            <h3>Hipótesis</h3>
            <p>{selected.proposal.hypothesis}</p>
            <h3>Evento que la activó</h3>
            <p>{selected.event}</p>
            <dl>
              <div>
                <dt>Unidades</dt>
                <dd>{selected.proposal.qty ?? "—"}</dd>
              </div>
              <div>
                <dt>Precio límite</dt>
                <dd>{money(selected.proposal.limitPrice)}</dd>
              </div>
              <div>
                <dt>Versión</dt>
                <dd>{selected.versionId.slice(0, 8)}</dd>
              </div>
            </dl>
            {selected.error && <p className="error">{selected.error}</p>}
            <h3>Revisión posterior</h3>
            <p className="preserve">
              {selected.review?.text || "Pendiente: " + date(selected.reviewAt)}
            </p>
            {["unknown", "submitting"].includes(selected.status) && (
              <button
                disabled={busy}
                onClick={async () => {
                  if (await act(`/orders/${selected.id}/reconcile`))
                    setSelected(null);
                }}
              >
                Reconciliar con Alpaca
              </button>
            )}
            {selected.status === "unknown" && (
              <button
                disabled={busy}
                onClick={async () => {
                  if (
                    confirm(
                      "Comprueba primero en Alpaca. Esta acción verifica que la orden no existe (404) y resuelve la intención sin reenviarla. ¿Continuar?",
                    ) &&
                    (await act(`/orders/${selected.id}/confirm-absent`))
                  )
                    setSelected(null);
                }}
              >
                Verificar que no se envió
              </button>
            )}
            <details>
              <summary>Información disponible al decidir</summary>
              <pre>
                {detail?.id !== selected.id
                  ? "Cargando…"
                  : detail.input === null
                    ? "El contexto guardado solo se conserva para las decisiones recientes."
                    : JSON.stringify(detail.input, null, 2)}
              </pre>
            </details>
            <small>ID: {selected.id}</small>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
