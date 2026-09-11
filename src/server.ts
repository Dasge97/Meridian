import Fastify from "fastify";
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
import { pool, read, change } from "./db.ts";
import {
  settingsSchema,
  watchSchema,
  lessonSchema,
  id,
  now,
  log,
  enqueue,
  validWatch,
  UserError,
} from "./domain.ts";
import { configured, alpaca, AlpacaError } from "./alpaca.ts";
import { modelConfigured } from "./model.ts";
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
  PANEL_USAGE = 200;
app.get("/api/state", async () => {
  const s = await read();
  return {
    ...s,
    // The saved model context is fetched per decision from /api/decisions/:id.
    decisions: s.decisions
      .slice(-PANEL_DECISIONS)
      .map((d) => ({ ...d, input: null })),
    events: s.events.slice(0, PANEL_EVENTS),
    equity: s.equity.slice(-PANEL_EQUITY),
    usage: s.usage.slice(-PANEL_USAGE),
    totals: {
      decisions: s.decisions.length,
      events: s.events.length,
      equity: s.equity.length,
    },
    connection: {
      alpaca: configured(),
      model: modelConfigured(),
      modelName: process.env.LLM_MODEL ?? null,
    },
  };
});
app.get("/api/decisions/:id", async (req, reply) => {
  const p = z.object({ id: z.uuid() }).parse(req.params);
  const d = (await read()).decisions.find((d) => d.id === p.id);
  return d ? d : reply.code(404).send({ error: "Esa decisión no existe" });
});
app.post("/api/pause", async (req) => {
  const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
  await change((s) => {
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
      enqueue(s, "Inicio de observación solicitado por el propietario");
  });
  return { ok: true };
});
app.post("/api/wake", async () => {
  await change((s) => {
    enqueue(s, "Reevaluación solicitada por el propietario");
    log(s, "control", "Reevaluación en cola");
  });
  return { ok: true };
});
app.put("/api/settings", async (req) => {
  const settings = settingsSchema.parse(req.body);
  await change((s) => {
    s.settings = settings;
    for (const w of s.watches)
      if (w.status === "active" && !settings.symbols.includes(w.symbol))
        w.status = "cancelled";
    log(s, "config", "Límites actualizados por el propietario");
  });
  return { ok: true };
});
app.post("/api/watches", async (req) => {
  const w = watchSchema.parse(req.body);
  await change((s) => {
    if (!validWatch(w, s))
      throw new UserError(
        "Vigilancia fuera de límites: revisa activo, caducidad (máximo 30 días) y número de vigilancias",
      );
    s.watches.push({ ...w, id: id(), status: "active", createdAt: now() });
    log(s, "watch", `Vigilancia manual: ${w.symbol}`);
  });
  return { ok: true };
});
app.post("/api/watches/:id/cancel", async (req) => {
  const p = z.object({ id: z.uuid() }).parse(req.params);
  await change((s) => {
    const w = s.watches.find((w) => w.id === p.id);
    if (!w) throw new UserError("Esa vigilancia no existe");
    w.status = "cancelled";
    log(s, "watch", `Vigilancia cancelada: ${w.symbol}`);
  });
  return { ok: true };
});
app.post("/api/lessons", async (req) => {
  const l = lessonSchema.parse(req.body);
  await change((s) => {
    s.lessons.push({ ...l, id: id(), status: "proposed", createdAt: now() });
    log(s, "lesson", "Conocimiento externo añadido como propuesta");
  });
  return { ok: true };
});
app.post("/api/lessons/:id/status", async (req) => {
  const p = z.object({ id: z.uuid() }).parse(req.params);
  const { status } = z
    .object({ status: z.enum(["accepted", "rejected"]) })
    .parse(req.body);
  await change((s) => {
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
app.post("/api/versions", async (req) => {
  const v = z
    .object({
      instructions: z.string().min(30).max(12000),
      note: z.string().min(3).max(300),
    })
    .parse(req.body);
  await change((s) => {
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
app.post("/api/versions/:id/activate", async (req) => {
  const { id: versionId } = z.object({ id: z.uuid() }).parse(req.params);
  await change((s) => {
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
app.post("/api/orders/:id/reconcile", async (req, reply) => {
  const { id: decisionId } = z.object({ id: z.uuid() }).parse(req.params);
  const d = (await read()).decisions.find((d) => d.id === decisionId);
  if (!d) return reply.code(404).send({ error: "No existe" });
  const o = await alpaca(
    "/v2/orders:by_client_order_id?client_order_id=" + d.id,
  );
  await change((s) => {
    const target = s.decisions.find((x) => x.id === d.id)!;
    target.status = o.status;
    target.orderId = o.id;
    log(s, "order", "Orden reconciliada con Alpaca");
  });
  return { ok: true };
});
app.post("/api/orders/:id/confirm-absent", async (req, reply) => {
  const { id: decisionId } = z.object({ id: z.uuid() }).parse(req.params);
  const d = (await read()).decisions.find((d) => d.id === decisionId);
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
  await change((s) => {
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
app.post("/api/orders/cancel-open", async () => {
  await change((s) => {
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
