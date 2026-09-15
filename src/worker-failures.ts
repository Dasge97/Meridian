import { z } from "zod";
// Los mensajes del proveedor y de Zod describen la petición, no llevan claves.
// Aun así se recortan, porque acaban guardados en el registro del laboratorio.
export function describeFailure(e: unknown) {
  if (e instanceof z.ZodError)
    return (
      "la respuesta no cumple el esquema (" +
      e.issues
        .slice(0, 3)
        .map((x) => `${x.path.join(".") || "raíz"}: ${x.message}`)
        .join("; ") +
      ")"
    );
  // Alpaca y el modelo ya lanzan su propio mensaje con quién tardó. Este es el
  // caso genérico: antes decía «el modelo» también cuando era Alpaca.
  if (e instanceof Error && e.name === "TimeoutError")
    return "una petición externa no respondió a tiempo";
  const texto = e instanceof Error ? e.message : String(e);
  return texto.slice(0, 300) || "error desconocido";
}
