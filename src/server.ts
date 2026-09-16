import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import serveStatic from "@fastify/static";
import {
  scryptSync,
  timingSafeEqual,
  createHmac,
  randomBytes,
} from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  pool,
  readShared,
  readSim,
  readSimParts,
  readPanel,
  readCompare,
  changeSim,
  changeAll,
  type CompareRows,
} from "./db.ts";
import { composeState, simSummary } from "./sim-state.ts";
import { SIMS, SIM_IDS, isSimId, type SimId } from "./sims.ts";
import { cancelOpenInternal } from "./paper.ts";
import { compareSims } from "./compare.ts";
import {
  sharedSettingsSchema,
  watchSchema,
  lessonSchema,
  id,
  now,
  log,
  logShared,
  enqueue,
  watchProblem,
  adoptLessons,
  riskProfileOf,
  RISK_PROFILE_KEYS,
  UserError,
} from "./domain.ts";
import { configured, alpaca, AlpacaError } from "./alpaca.ts";
import { modelConfigured } from "./model.ts";
import { recentBars, chartBars } from "./market.ts";
import { telegramConfigured } from "./telegram.ts";
import {
  compareFrom,
  decisionFilter,
  eventFilter,
  listDecisions,
  listEvents,
  mergeEvents,
} from "./listing.ts";
import { listUsage, usageFilter } from "./usage.ts";
const secret = process.env.SESSION_SECRET ?? "",
  password = process.env.ADMIN_PASSWORD ?? "",
  origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
if (
  secret.length < 32 ||
  password.length < 16 ||
  secret.startsWith("replace-") ||
  password.startsWith("replace-")
)
  throw new Error("SESSION_SECRET >=32 y ADMIN_PASSWORD >=16 obligatorios");
const salt = randomBytes(16),
  expected = scryptSync(password, salt, 32);
const sign = (v: string) =>
  createHmac("sha256", secret).update(v).digest("hex");
function authenticated(value: string | undefined) {
  if (!value) return false;
  const [expires, sig] = value.split(".");
  if (
    !expires ||
    !sig ||
    !/^[a-f0-9]{64}$/.test(sig) ||
    Number(expires) < Date.now()
  )
    return false;
  return timingSafeEqual(Buffer.from(sign(expires)), Buffer.from(sig));
}
export const app = Fastify({
  logger: { level: "warn" },
  bodyLimit: 65536,
  trustProxy: process.env.TRUST_PROXY === "true",
});
await app.register(cookie);
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
});
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
app.addHook("onRequest", async (req, reply) => {
  if (req.routeOptions.url?.startsWith("/api/")) {
    reply.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== origin
    )
      return reply.code(403).send({ error: "Origen no permitido" });
    if (
      !["/api/login", "/api/health"].includes(req.routeOptions.url ?? "") &&
      !authenticated(req.cookies.meridian)
    )
      return reply.code(401).send({ error: "Inicia sesión" });
  }
});
app.setErrorHandler((e, req, reply) => {
  if (e instanceof UserError) return reply.code(400).send({ error: e.message });
  if (e instanceof z.ZodError)
    return reply.code(400).send({
      error: "Datos no válidos",
      details: e.issues.map((x) => ({ path: x.path, message: x.message })),
    });
  // Fastify ya clasifica los fallos de la petición: límite de peticiones
  // superado, cuerpo mal formado, método no permitido. Su código y su mensaje
  // están dirigidos a quien llama, así que se respetan en lugar de esconderlos.
  const status = (e as { statusCode?: unknown }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500)
    return reply
      .code(status)
      .send({ error: e instanceof Error ? e.message : "Petición no válida" });
  req.log.error(
    { message: e instanceof Error ? e.message : "Unknown error" },
    "Request failed",
  );
  reply.code(500).send({ error: "No se pudo completar la operación" });
});
app.get("/api/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true };
});
app.post(
  "/api/login",
  { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const body = z.object({ password: z.string().max(1024) }).parse(req.body);
    if (!timingSafeEqual(scryptSync(body.password, salt, 32), expected))
      return reply.code(401).send({ error: "Contraseña incorrecta" });
    const expires = String(Date.now() + 12 * 3600000);
    reply.setCookie("meridian", expires + "." + sign(expires), {
      httpOnly: true,
      secure: origin.startsWith("https:"),
      sameSite: "strict",
      path: "/",
      maxAge: 43200,
    });
    return { ok: true };
  },
);
app.post("/api/logout", async (req, reply) => {
  reply.clearCookie("meridian", { path: "/" });
  return { ok: true };
});
// The panel polls this every few seconds, so it never carries the whole history.
export const PANEL_DECISIONS = 300,
  PANEL_EVENTS = 200,
  PANEL_EQUITY = 500,
  PANEL_USAGE = 200,
  PANEL_FILLS = 200;
// Un año de velas diarias y la sesión entera en velas de 5 minutos, por activo.
// El panel las pide al abrir la pestaña Mercado y cada 5 minutos, que es lo que
// tarda el worker en volver a descargarlas. Son compartidas.
app.get("/api/market", async () => chartBars(await readShared()));
// Las dos simulaciones en el mismo periodo. from es opcional: sin él empieza en
// el inicio de la comparación. El panel la pide cada minuto. No lee el contexto
// guardado de las decisiones ni el detalle del consumo (ver readCompare).
app.get("/api/compare", async (req) => {
  // Se valida antes de leer la base de datos.
  const from = compareFrom(req.query);
  const rows = await readCompare();
  const input = (x: CompareRows) => ({
    label: SIMS[x.id].label,
    riskProfile: x.riskProfile,
    equity: x.equity,
    fills: x.fills,
    comparison: x.comparison,
    usage: x.usage,
    decisions: x.decisions,
    account: x.account,
  });
  return compareSims(
    { alpaca: input(rows.alpaca), internal: input(rows.internal) },
    from,
    Date.now(),
  );
});
// Los límites son compartidos: valen para todas las simulaciones. El nivel de
// riesgo no va aquí sino en /api/sims/:sim/risk, y si llega se ignora: un
// formulario de antes lo envía con los límites.
app.put("/api/settings", async (req) => {
  // Se valida antes de leer la base de datos.
  const settings = sharedSettingsSchema.parse(req.body);
  await changeAll((sh, views) => {
    sh.settings = settings;
    // Quitar un activo cancela sus vigilancias en todas las simulaciones.
    for (const s of Object.values(views))
      for (const w of s.watches)
        if (w.status === "active" && !settings.symbols.includes(w.symbol))
          w.status = "cancelled";
    logShared(sh, "config", "Límites actualizados por el propietario");
  });
  return { ok: true };
});
// Las rutas de antes de separar las simulaciones. Una pestaña abierta desde
// entonces no debe pausar ni cancelar en una simulación que nadie ha elegido.
export const RETIRED_ROUTES = [
  ["GET", "/api/state"],
  ["GET", "/api/decisions"],
  ["GET", "/api/decisions/:id"],
  ["GET", "/api/events"],
  ["GET", "/api/usage"],
  ["POST", "/api/pause"],
  ["POST", "/api/wake"],
  ["POST", "/api/watches"],
  ["POST", "/api/watches/:id/cancel"],
  ["POST", "/api/lessons"],
  ["POST", "/api/lessons/:id/status"],
  ["POST", "/api/versions"],
  ["POST", "/api/versions/:id/activate"],
  ["POST", "/api/orders/:id/reconcile"],
  ["POST", "/api/orders/:id/confirm-absent"],
  ["POST", "/api/orders/cancel-open"],
] as const;
for (const [method, url] of RETIRED_ROUTES)
  app.route({
    method,
    url,
    handler: async (_req, reply) =>
      reply
        .code(410)
        .send({ error: "El panel se ha actualizado: recarga la página" }),
  });

// Todo lo que es de una simulación va con su id en la ruta. No hay simulación
// por defecto: un parámetro olvidado acabaría pausando o cancelando en otra.
const simOf = (req: FastifyRequest) => (req.params as { sim: SimId }).sim;
async function simRoutes(r: FastifyInstance) {
  r.addHook("onRequest", async (req, reply) => {
    if (!isSimId((req.params as { sim?: unknown }).sim))
      return reply.code(404).send({ error: "Esa simulación no existe" });
  });
  r.get("/state", async (req) => {
    const sim = simOf(req);
    const parts = await readPanel(sim);
    const s = composeState(parts.shared, parts.sim);
    const events = mergeEvents(s.events, parts.shared.systemEvents);
    return {
      ...s,
      // Las velas completas van por /api/market: aquí solo las recientes.
      ...recentBars(s),
      // The saved model context is fetched per decision from /decisions/:id.
      decisions: s.decisions
        .slice(-PANEL_DECISIONS)
        .map((d) => ({ ...d, input: null })),
      // Los de la simulación y los compartidos, marcados con scope.
      events: events.slice(0, PANEL_EVENTS),
      equity: s.equity.slice(-PANEL_EQUITY),
      // Solo lo que cabe en una barra. El detalle de cada llamada va por
      // /usage: con él, 200 registros pesarían en cada consulta de 5 segundos.
      usage: s.usage
        .slice(-PANEL_USAGE)
        .map(({ at, tokens, kind, trigger, ok }) => ({
          at,
          tokens,
          kind,
          trigger,
          ok,
        })),
      fills: s.fills.slice(-PANEL_FILLS),
      // Todas las simulaciones en pocas cifras, para el selector del panel. Salen
      // de las filas calientes: no se lee el historial de las demás.
      sims: SIM_IDS.map((x) => simSummary(parts.hot[x])),
      totals: {
        decisions: s.decisions.length,
        events: events.length,
        equity: s.equity.length,
      },
      connection: {
        alpaca: configured(),
        model: modelConfigured(),
        modelName: process.env.LLM_MODEL ?? null,
        telegram: telegramConfigured(),
      },
    };
  });
  // El historial guarda hasta 2.000 decisiones y el estado solo lleva 300, así
  // que buscar y paginar lo hace el servidor. Los parámetros se validan antes de
  // leer la base de datos.
  r.get("/decisions", async (req) => {
    const f = decisionFilter(req.query);
    return listDecisions((await readSim(simOf(req))).decisions, f);
  });
  r.get("/events", async (req) => {
    const f = eventFilter(req.query);
    const parts = await readSimParts(simOf(req));
    return listEvents(
      mergeEvents(parts.sim.events, parts.shared.systemEvents),
      f,
    );
  });
  // Consumo del modelo por llamada, con su resumen. Mismo estilo que las listas.
  r.get("/usage", async (req) => {
    const f = usageFilter(req.query);
    return listUsage((await readSim(simOf(req))).usage, f);
  });
  r.get("/decisions/:id", async (req, reply) => {
    const p = z.object({ id: z.uuid() }).parse(req.params);
    const d = (await readSim(simOf(req))).decisions.find((d) => d.id === p.id);
    return d ? d : reply.code(404).send({ error: "Esa decisión no existe" });
  });
  r.post("/pause", async (req) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    await changeSim(simOf(req), (s) => {
      if (!paused && (!configured() || !modelConfigured()))
        throw new UserError(
          "Faltan las claves de Alpaca Paper o del modelo. Configúralas en el servidor.",
        );
      if (
        !paused &&
        s.decisions.some((d) => ["unknown", "submitting"].includes(d.status))
      )
        throw new UserError(
          "Hay una orden sin reconciliar. Resuélvela antes de activar el agente.",
        );
      s.paused = paused;
      log(s, "control", paused ? "Agente pausado" : "Agente activado");
      if (!paused && !s.queue.length)
        enqueue(
          s,
          "Inicio de observación solicitado por el propietario",
          "manual",
        );
    });
    return { ok: true };
  });
  r.post("/wake", async (req) => {
    await changeSim(simOf(req), (s) => {
      enqueue(s, "Reevaluación solicitada por el propietario", "manual");
      log(s, "control", "Reevaluación en cola");
    });
    return { ok: true };
  });
  // El nivel de riesgo de esta simulación. Una evaluación en curso con el nivel
  // de antes queda obsoleta y su propuesta no se envía.
  r.put("/risk", async (req) => {
    const { riskProfile } = z
      .object({ riskProfile: z.enum(RISK_PROFILE_KEYS) })
      .parse(req.body);
    await changeSim(simOf(req), (s) => {
      const antes = riskProfileOf(s.settings);
      s.settings.riskProfile = riskProfile;
      const despues = riskProfileOf(s.settings);
      if (despues.key !== antes.key)
        log(
          s,
          "config",
          `Nivel de riesgo: ${antes.label} → ${despues.label}. ${despues.description}`,
        );
    });
    return { ok: true };
  });
  r.post("/watches", async (req) => {
    const w = watchSchema.parse(req.body);
    await changeSim(simOf(req), (s) => {
      const problema = watchProblem(w, s);
      if (problema) throw new UserError(problema);
      s.watches.push({ ...w, id: id(), status: "active", createdAt: now() });
      log(s, "watch", `Vigilancia manual: ${w.symbol}`);
    });
    return { ok: true };
  });
  r.post("/watches/:id/cancel", async (req) => {
    const p = z.object({ id: z.uuid() }).parse(req.params);
    await changeSim(simOf(req), (s) => {
      const w = s.watches.find((w) => w.id === p.id);
      if (!w) throw new UserError("Esa vigilancia no existe");
      w.status = "cancelled";
      log(s, "watch", `Vigilancia cancelada: ${w.symbol}`);
    });
    return { ok: true };
  });
  r.post("/lessons", async (req) => {
    const l = lessonSchema.parse(req.body);
    // Lo aporta el propietario: entra directamente en la memoria activa.
    await changeSim(simOf(req), (s) => {
      adoptLessons(
        s,
        [l],
        `Conocimiento aportado por el propietario: ${l.title}`,
      );
    });
    return { ok: true };
  });
  r.post("/lessons/:id/status", async (req) => {
    const p = z.object({ id: z.uuid() }).parse(req.params);
    const { status } = z
      .object({ status: z.enum(["accepted", "rejected"]) })
      .parse(req.body);
    await changeSim(simOf(req), (s) => {
      const l = s.lessons.find((l) => l.id === p.id);
      if (!l) throw new UserError("Esa lección no existe");
      l.status = status;
      const previous = s.versions.find((v) => v.id === s.activeVersion)!;
      const v = {
        id: id(),
        instructions: previous.instructions,
        lessonIds: s.lessons
          .filter((l) => l.status === "accepted")
          .map((l) => l.id),
        createdAt: now(),
        note: `Lección ${status}: ${l.title}`,
      };
      s.versions.push(v);
      s.activeVersion = v.id;
      log(s, "version", v.note);
    });
    return { ok: true };
  });
  r.post("/versions", async (req) => {
    const v = z
      .object({
        instructions: z.string().min(30).max(12000),
        note: z.string().min(3).max(300),
      })
      .parse(req.body);
    await changeSim(simOf(req), (s) => {
      const next = {
        ...v,
        id: id(),
        lessonIds: s.lessons
          .filter((l) => l.status === "accepted")
          .map((l) => l.id),
        createdAt: now(),
      };
      s.versions.push(next);
      s.activeVersion = next.id;
      log(s, "version", v.note);
    });
    return { ok: true };
  });
  r.post("/versions/:id/activate", async (req) => {
    const { id: versionId } = z.object({ id: z.uuid() }).parse(req.params);
    await changeSim(simOf(req), (s) => {
      const v = s.versions.find((v) => v.id === versionId);
      if (!v) throw new UserError("Esa versión no existe");
      s.activeVersion = v.id;
      for (const l of s.lessons)
        if (v.lessonIds.includes(l.id)) l.status = "accepted";
        else if (l.status === "accepted") l.status = "proposed";
      log(s, "version", `Versión recuperada: ${v.note}`);
    });
    return { ok: true };
  });
  // Reconciliar y confirmar una orden ausente preguntan a Alpaca: solo tienen
  // sentido en una simulación cuyas órdenes salen allí.
  const alpacaOnly = (sim: SimId) => {
    if (SIMS[sim].broker !== "alpaca")
      throw new UserError(
        `No aplica a ${SIMS[sim].label}: sus órdenes no salen a Alpaca`,
      );
  };
  r.post("/orders/:id/reconcile", async (req, reply) => {
    const sim = simOf(req);
    const { id: decisionId } = z.object({ id: z.uuid() }).parse(req.params);
    alpacaOnly(sim);
    const d = (await readSim(sim)).decisions.find((d) => d.id === decisionId);
    if (!d) return reply.code(404).send({ error: "No existe" });
    const o = await alpaca(
      "/v2/orders:by_client_order_id?client_order_id=" + d.id,
    );
    await changeSim(sim, (s) => {
      const target = s.decisions.find((x) => x.id === d.id)!;
      target.status = o.status;
      target.orderId = o.id;
      log(s, "order", "Orden reconciliada con Alpaca");
    });
    return { ok: true };
  });
  r.post("/orders/:id/confirm-absent", async (req, reply) => {
    const sim = simOf(req);
    const { id: decisionId } = z.object({ id: z.uuid() }).parse(req.params);
    alpacaOnly(sim);
    const d = (await readSim(sim)).decisions.find((d) => d.id === decisionId);
    if (
      !d ||
      d.status !== "unknown" ||
      !d.sentAt ||
      Date.now() - Date.parse(d.sentAt) < 120000
    )
      return reply.code(400).send({
        error: "Solo se puede resolver una orden incierta tras dos minutos",
      });
    try {
      await alpaca("/v2/orders:by_client_order_id?client_order_id=" + d.id);
      return reply
        .code(409)
        .send({ error: "La orden existe: utiliza Reconciliar" });
    } catch (e) {
      if (!(e instanceof AlpacaError) || e.status !== 404) throw e;
    }
    await changeSim(sim, (s) => {
      const target = s.decisions.find((x) => x.id === decisionId)!;
      if (target.status !== "unknown")
        throw new UserError("La orden cambió de estado: vuelve a revisarla");
      target.status = "not_submitted";
      log(
        s,
        "order",
        `Propietario confirma orden ausente tras HTTP 404: ${decisionId}. No se reenviará.`,
      );
    });
    return { ok: true };
  });
  r.post("/orders/cancel-open", async (req) => {
    const sim = simOf(req);
    // Las órdenes de la interna no están en Alpaca: se pausan y se cancelan aquí,
    // sin llamar a Alpaca. No toca la otra simulación.
    if (SIMS[sim].broker === "internal") {
      const canceladas = await changeSim(sim, (s) => {
        s.paused = true;
        log(
          s,
          "control",
          "Pausa y cancelación de órdenes simuladas solicitadas",
        );
        const n = cancelOpenInternal(s);
        log(
          s,
          "order",
          n === 0
            ? "No había órdenes simuladas abiertas"
            : n === 1
              ? "Una orden simulada cancelada"
              : `${n} órdenes simuladas canceladas`,
        );
        return n;
      });
      return { ok: true, canceled: canceladas };
    }
    alpacaOnly(sim);
    await changeSim(sim, (s) => {
      s.paused = true;
      log(s, "control", "Pausa y cancelación de órdenes abiertas solicitadas");
    });
    const results = await alpaca("/v2/orders", "DELETE");
    if (Array.isArray(results) && results.some((x) => x.status >= 300))
      throw new UserError(
        "Alpaca no pudo cancelar todas las órdenes; comprueba su estado allí",
      );
    return { ok: true };
  });
}
await app.register(simRoutes, { prefix: "/api/sims/:sim" });
await app.register(serveStatic, { root: path.resolve("dist") });
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith("/api/")
    ? reply.code(404).send({ error: "No existe" })
    : reply.sendFile("index.html"),
);
if (process.env.MERIDIAN_TEST !== "true")
  await app.listen({
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
  });
process.on("SIGTERM", async () => {
  await app.close();
  await pool.end();
});
