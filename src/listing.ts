// Filtrado y paginación de decisiones y eventos para el panel. No hace entrada
// ni salida: recibe el historial y los parámetros ya validados, así que se
// prueba directamente.
import {
  UserError,
  type Decision,
  type Event as StoredEvent,
} from "./domain.ts";

export const PAGE_SIZE = 25,
  PAGE_SIZE_MAX = 100;
export const DECISION_KINDS = [
  "all",
  "buy",
  "sell",
  "wait",
  "blocked",
  "unresolved",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];
// Los eventos de una simulación llevan scope "sim" y los compartidos "shared",
// para que el panel sepa cuáles valen para todas.
export type EventScope = "sim" | "shared";
export type Event = StoredEvent & { scope?: EventScope };

export type Page<T> = { items: T[]; total: number; page: number; size: number };
export type DecisionPage = Page<Decision> & {
  counts: Record<DecisionKind, number>;
};
export type EventPage = Page<Event> & {
  types: { type: string; count: number }[];
};

export type Paging = {
  page: number;
  size: number;
  from: number | null;
  to: number | null;
};
type Common = Paging & { q: string };
export type DecisionFilter = Common & {
  kind: DecisionKind;
  symbol: string | null;
};
export type EventFilter = Common & { type: string | null };

// Texto comparable sin mayúsculas ni acentos: «revision» encuentra «Revisión».
export const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const kindTest: Record<DecisionKind, (d: Decision) => boolean> = {
  all: () => true,
  buy: (d) => d.proposal.action === "buy",
  sell: (d) => d.proposal.action === "sell",
  wait: (d) => d.proposal.action === "wait",
  blocked: (d) => d.status === "blocked",
  unresolved: (d) => ["unknown", "submitting"].includes(d.status),
};

// Una página pasada de la última devuelve la última, no una lista vacía.
export function paginate<T>(list: T[], page: number, size: number): Page<T> {
  const pages = Math.max(1, Math.ceil(list.length / size)),
    current = Math.min(Math.max(1, page), pages);
  return {
    items: list.slice((current - 1) * size, current * size),
    total: list.length,
    page: current,
    size,
  };
}

// Lo más reciente primero por su fecha, sin fiarse del orden en que se guardó.
// El orden es estable: con la misma fecha se respeta el guardado.
export const newestFirst = <T extends { at: string }>(list: T[]) =>
  list
    .map((x, i) => ({ x, i, t: Date.parse(x.at) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((e) => e.x);

export const within = (at: string, f: Paging) => {
  const t = Date.parse(at);
  return (f.from === null || t >= f.from) && (f.to === null || t <= f.to);
};

export function listDecisions(
  decisions: Decision[],
  f: DecisionFilter,
): DecisionPage {
  const q = fold(f.q);
  const base = newestFirst(
    decisions.filter(
      (d) =>
        within(d.at, f) &&
        (!f.symbol || d.proposal.symbol === f.symbol) &&
        (!q ||
          fold(
            [
              d.proposal.symbol ?? "",
              d.proposal.note,
              d.proposal.reason,
              d.proposal.hypothesis,
              d.event,
            ].join("\n"),
          ).includes(q)),
    ),
  );
  const counts = Object.fromEntries(
    DECISION_KINDS.map((k) => [k, base.filter(kindTest[k]).length]),
  ) as Record<DecisionKind, number>;
  const page = paginate(base.filter(kindTest[f.kind]), f.page, f.size);
  // El contexto guardado es el campo más pesado; se pide aparte al abrir el detalle.
  return {
    ...page,
    items: page.items.map((d) => ({ ...d, input: null })),
    counts,
  };
}

// Los eventos de una simulación junto a los compartidos, lo más reciente primero.
export const mergeEvents = (
  own: StoredEvent[],
  shared: StoredEvent[],
): Event[] =>
  newestFirst<Event>([
    ...own.map((e) => ({ ...e, scope: "sim" as const })),
    ...shared.map((e) => ({ ...e, scope: "shared" as const })),
  ]);

export function listEvents(events: Event[], f: EventFilter): EventPage {
  const q = fold(f.q);
  const base = newestFirst(
    events.filter(
      (e) =>
        within(e.at, f) && (!q || fold(e.type + "\n" + e.message).includes(q)),
    ),
  );
  const byType = new Map<string, number>();
  for (const e of base) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  const types = [...byType]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  return {
    ...paginate(
      f.type ? base.filter((e) => e.type === f.type) : base,
      f.page,
      f.size,
    ),
    types,
  };
}

// Validación de la cadena de consulta. Cada fallo dice qué parámetro no vale.
type Raw = Record<string, unknown>;
export function text(raw: Raw, key: string, label: string): string | null {
  const v = raw[key];
  if (v === undefined || v === "") return null;
  if (typeof v !== "string")
    throw new UserError(`${label} solo se puede indicar una vez`);
  return v;
}
function whole(raw: Raw, key: string, label: string, min: number, max: number) {
  const v = text(raw, key, label);
  if (v === null) return null;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < min || n > max)
    throw new UserError(
      max === Infinity
        ? `${label} tiene que ser un número entero desde ${min}`
        : `${label} tiene que ser un número entero entre ${min} y ${max}`,
    );
  return n;
}
const ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
function instant(raw: Raw, key: string, label: string) {
  const v = text(raw, key, label);
  if (v === null) return null;
  const t = Date.parse(v);
  if (!ISO.test(v) || !Number.isFinite(t))
    throw new UserError(
      `${label} tiene que ser una fecha ISO con hora y zona, como 2026-09-15T00:00:00Z`,
    );
  return t;
}
// Página, tamaño y fechas: lo que comparten todas las listas.
export function paging(query: unknown): Paging & { raw: Raw } {
  const raw = (query && typeof query === "object" ? query : {}) as Raw;
  const from = instant(raw, "from", "La fecha de inicio"),
    to = instant(raw, "to", "La fecha de fin");
  if (from !== null && to !== null && from > to)
    throw new UserError("La fecha de inicio es posterior a la de fin");
  return {
    raw,
    page: whole(raw, "page", "La página", 1, Infinity) ?? 1,
    size:
      whole(raw, "size", "El tamaño de página", 1, PAGE_SIZE_MAX) ?? PAGE_SIZE,
    from,
    to,
  };
}
function common(query: unknown): Common & { raw: Raw } {
  const w = paging(query);
  const q = (text(w.raw, "q", "La búsqueda") ?? "").trim();
  if (q.length > 200)
    throw new UserError("La búsqueda no puede pasar de 200 caracteres");
  return { ...w, q };
}
export function decisionFilter(query: unknown): DecisionFilter {
  const { raw, ...c } = common(query);
  const kind = text(raw, "kind", "El tipo") ?? "all";
  if (!(DECISION_KINDS as readonly string[]).includes(kind))
    throw new UserError(
      `El tipo tiene que ser uno de estos: ${DECISION_KINDS.join(", ")}`,
    );
  const symbol = text(raw, "symbol", "El activo");
  if (symbol !== null && !/^[A-Z]{1,5}$/.test(symbol))
    throw new UserError(
      "El activo tiene que ser un símbolo de 1 a 5 letras mayúsculas",
    );
  return { ...c, kind: kind as DecisionKind, symbol };
}
// GET /api/compare solo admite from: el periodo termina siempre ahora.
export function compareFrom(query: unknown): number | null {
  const raw = (query && typeof query === "object" ? query : {}) as Raw;
  return instant(raw, "from", "La fecha de inicio");
}
export function eventFilter(query: unknown): EventFilter {
  const { raw, ...c } = common(query);
  const type = text(raw, "type", "El tipo de evento");
  if (type !== null && type.length > 50)
    throw new UserError("El tipo de evento no puede pasar de 50 caracteres");
  return { ...c, type };
}
