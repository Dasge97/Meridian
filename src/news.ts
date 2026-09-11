// Noticias de mercado. Son texto escrito por terceros: se tratan como datos no
// confiables, se recortan y nunca como instrucciones para el agente.
export type Story = {
  id: string;
  at: string;
  source: string;
  headline: string;
  summary: string;
  symbols: string[];
  url: string;
  // Una noticia se comenta una sola vez. Si la evaluación falla, sigue
  // pendiente y se comenta en la siguiente.
  commented?: boolean;
};
export const STORIES_KEPT = 30,
  HEADLINE_MAX = 300,
  SUMMARY_MAX = 600,
  STORY_AGE_HOURS = 48;
const text = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
export function usableStory(raw: unknown, allowed: string[]): Story | null {
  const n = raw as Record<string, unknown>;
  const id = n?.id === undefined || n?.id === null ? "" : String(n.id);
  const at = typeof n?.created_at === "string" ? n.created_at : "";
  const headline = text(n?.headline, HEADLINE_MAX);
  if (!id || !headline || !Number.isFinite(Date.parse(at))) return null;
  // Una noticia llega etiquetada con muchos activos; solo interesan los propios.
  const symbols = Array.isArray(n?.symbols)
    ? n.symbols.filter(
        (s): s is string => typeof s === "string" && allowed.includes(s),
      )
    : [];
  if (!symbols.length) return null;
  return {
    id,
    at,
    source: text(n?.source, 40),
    headline,
    summary: text(n?.summary, SUMMARY_MAX),
    symbols,
    url: text(n?.url, 300),
  };
}
// Devuelve las noticias vigentes y cuáles son nuevas respecto a las guardadas.
export function mergeStories(
  saved: Story[],
  raw: unknown[],
  allowed: string[],
  t = Date.now(),
) {
  const known = new Set(saved.map((s) => s.id));
  const fresh: Story[] = [];
  for (const x of raw ?? []) {
    const story = usableStory(x, allowed);
    if (story && !known.has(story.id)) {
      known.add(story.id);
      fresh.push(story);
    }
  }
  const vigente = (s: Story) =>
    t - Date.parse(s.at) < STORY_AGE_HOURS * 3600000 &&
    s.symbols.some((x) => allowed.includes(x));
  const all = [...saved, ...fresh]
    .filter(vigente)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-STORIES_KEPT);
  // Solo cuentan como novedad las que sobreviven al filtro de antigüedad.
  const kept = new Set(all.map((s) => s.id));
  return { stories: all, fresh: fresh.filter((s) => kept.has(s.id)) };
}
// Una línea por noticia para el evento que despierta al agente.
export function summarise(fresh: Story[], max = 4) {
  const cabeceras = fresh
    .slice(-max)
    .map((s) => `${s.symbols.join("/")}: ${s.headline.slice(0, 110)}`)
    .join(" · ");
  const resto = fresh.length > max ? ` (y ${fresh.length - max} más)` : "";
  return `${fresh.length} noticia${fresh.length === 1 ? "" : "s"} nueva${
    fresh.length === 1 ? "" : "s"
  }: ${cabeceras}${resto}`;
}
// El modelo confunde identificadores numéricos largos y acaba pegando el
// comentario a la noticia equivocada. Se le dan referencias cortas, y la misma
// función reconstruye después la correspondencia.
export const NEWS_REF_MAX = 8;
export function pendingRefs(stories: Story[], max = NEWS_REF_MAX) {
  const pendientes = stories.filter((n) => !n.commented).slice(-max);
  return new Map(pendientes.map((n, i) => [`N${i + 1}`, n]));
}
