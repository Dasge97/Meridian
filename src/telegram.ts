// Avisos al propietario. Si no está configurado, no se envía nada y el resto del
// laboratorio funciona igual: nunca debe ser motivo de que falle una decisión.
export const telegramConfigured = () =>
  Boolean(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID);
export const MESSAGE_MAX = 3800;
const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
// El mensaje lleva texto del modelo y titulares de terceros. Se escapa para que
// no pueda romper el formato ni colar marcado propio de Telegram.
export const escapeHtml = (s: string) =>
  String(s).replace(/[&<>]/g, (c) => escapes[c]);
export async function sendTelegram(text: string) {
  if (!telegramConfigured()) return false;
  const r = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: text.slice(0, MESSAGE_MAX),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}`);
  return true;
}
