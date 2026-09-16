// Consumo del modelo para el panel: filtra y pagina los registros, reparte los
// tokens de entrada entre las partes enviadas y resume. No hace entrada ni
// salida, así que se prueba directamente.
import {
  UserError,
  USAGE_SECTIONS,
  USAGE_TRIGGERS,
  type Usage,
  type UsageSection,
} from "./domain.ts";
import {
  newestFirst,
  paginate,
  paging,
  text,
  within,
  type Page,
  type Paging,
} from "./listing.ts";

export const USAGE_KINDS = ["decision", "review"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];
// Los registros anteriores a guardar el origen no lo traen: cuentan como unknown.
export const TRIGGER_KEYS = [...USAGE_TRIGGERS, "unknown"] as const;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];
export type UsageFilter = Paging & {
  kind: UsageKind | null;
  trigger: TriggerKey | null;
};
type BySection = Partial<Record<UsageSection, number>>;
export type UsageItem = Usage & { estimated?: BySection };
export type UsageSummary = {
  calls: number;
  failed: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  avgTokens: number;
  withBreakdown: number;
  byTrigger: { trigger: TriggerKey; calls: number; tokens: number }[];
  bySection: { section: UsageSection; tokens: number; avgTokens: number }[];
  byDay: {
    day: string;
    tokens: number;
    calls: number;
    byTrigger: Partial<Record<TriggerKey, number>>;
  }[];
};
export type UsagePage = Page<UsageItem> & { summary: UsageSummary };

const amount = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
const triggerOf = (u: Usage): TriggerKey => u.trigger ?? "unknown";

// El proveedor solo da el total de tokens de entrada. Se reparte en proporción a
// los caracteres de cada parte: es una estimación, no una medida.
export function estimate(u: Usage): BySection | null {
  if (!u.sections || typeof u.promptTokens !== "number") return null;
  const parts = USAGE_SECTIONS.flatMap((k) => {
    const chars = u.sections![k];
    return typeof chars === "number" && Number.isFinite(chars) && chars >= 0
      ? [[k, chars] as const]
      : [];
  });
  const total = parts.reduce((a, [, chars]) => a + chars, 0);
  if (!total) return null;
  return Object.fromEntries(
    parts.map(([k, chars]) => [
      k,
      Math.round((u.promptTokens! * chars) / total),
    ]),
  );
}

export function summariseUsage(list: Usage[]): UsageSummary {
  let failed = 0,
    tokens = 0,
    promptTokens = 0,
    completionTokens = 0,
    withBreakdown = 0;
  const triggers = new Map<TriggerKey, { calls: number; tokens: number }>();
  const sections = new Map<UsageSection, { calls: number; tokens: number }>();
  const days = new Map<string, UsageSummary["byDay"][number]>();
  for (const u of list) {
    const t = amount(u.tokens),
      trigger = triggerOf(u);
    if (u.ok === false) failed++;
    tokens += t;
    promptTokens += amount(u.promptTokens);
    completionTokens += amount(u.completionTokens);
    const g = triggers.get(trigger) ?? { calls: 0, tokens: 0 };
    g.calls++;
    g.tokens += t;
    triggers.set(trigger, g);
    const e = estimate(u);
    if (e) {
      withBreakdown++;
      for (const [k, v] of Object.entries(e) as [UsageSection, number][]) {
        const x = sections.get(k) ?? { calls: 0, tokens: 0 };
        x.calls++;
        x.tokens += v;
        sections.set(k, x);
      }
    }
    const at = Date.parse(u.at);
    if (!Number.isFinite(at)) continue;
    const day = new Date(at).toISOString().slice(0, 10);
    const d = days.get(day) ?? { day, tokens: 0, calls: 0, byTrigger: {} };
    d.tokens += t;
    d.calls++;
    d.byTrigger[trigger] = (d.byTrigger[trigger] ?? 0) + t;
    days.set(day, d);
  }
  // Un día sin llamadas también cuenta: la gráfica no debe juntar días lejanos.
  const byDay: UsageSummary["byDay"] = [];
  const known = [...days.keys()].sort();
  if (known.length)
    for (
      let t = Date.parse(known[0] + "T00:00:00Z");
      t <= Date.parse(known.at(-1)! + "T00:00:00Z");
      t += 86400000
    ) {
      const day = new Date(t).toISOString().slice(0, 10);
      byDay.push(days.get(day) ?? { day, tokens: 0, calls: 0, byTrigger: {} });
    }
  return {
    calls: list.length,
    failed,
    tokens,
    promptTokens,
    completionTokens,
    avgTokens: list.length ? Math.round(tokens / list.length) : 0,
    withBreakdown,
    byTrigger: [...triggers]
      .map(([trigger, g]) => ({ trigger, ...g }))
      .sort(
        (a, b) =>
          b.tokens - a.tokens ||
          b.calls - a.calls ||
          a.trigger.localeCompare(b.trigger),
      ),
    // La media de cada parte es sobre las llamadas que la enviaron: una
    // revisión no lleva análisis y no debe rebajar su media.
    bySection: [...sections]
      .map(([section, x]) => ({
        section,
        tokens: x.tokens,
        avgTokens: Math.round(x.tokens / x.calls),
      }))
      .sort(
        (a, b) => b.tokens - a.tokens || a.section.localeCompare(b.section),
      ),
    byDay,
  };
}

export function listUsage(usage: Usage[], f: UsageFilter): UsagePage {
  const base = newestFirst(
    usage.filter(
      (u) =>
        within(u.at, f) &&
        (!f.kind || u.kind === f.kind) &&
        (!f.trigger || triggerOf(u) === f.trigger),
    ),
  );
  const page = paginate(base, f.page, f.size);
  return {
    ...page,
    items: page.items.map((u) => {
      const estimated = estimate(u);
      return estimated ? { ...u, estimated } : u;
    }),
    summary: summariseUsage(base),
  };
}

export function usageFilter(query: unknown): UsageFilter {
  const { raw, ...p } = paging(query);
  const kind = text(raw, "kind", "El tipo");
  if (kind !== null && !(USAGE_KINDS as readonly string[]).includes(kind))
    throw new UserError(
      `El tipo tiene que ser uno de estos: ${USAGE_KINDS.join(", ")}`,
    );
  const trigger = text(raw, "trigger", "El origen");
  if (
    trigger !== null &&
    !(TRIGGER_KEYS as readonly string[]).includes(trigger)
  )
    throw new UserError(
      `El origen tiene que ser uno de estos: ${TRIGGER_KEYS.join(", ")}`,
    );
  return {
    ...p,
    kind: kind as UsageKind | null,
    trigger: trigger as TriggerKey | null,
  };
}
