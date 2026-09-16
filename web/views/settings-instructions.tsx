import React, { useEffect, useState } from "react";
import type { ViewProps } from "./types";
import { Counter } from "./settings-counter";

export function Instructions(p: ViewProps) {
  const { s, busy, act } = p;
  const v = s.versions.find((x) => x.id === s.activeVersion)!;
  // base es el texto desde el que se empezó a editar. Si llega una versión
  // nueva sin cambios pendientes, el editor la adopta; si hay cambios, se avisa.
  const [base, setBase] = useState(v.instructions),
    [text, setText] = useState(v.instructions),
    [note, setNote] = useState("");
  const dirty = text !== base;
  useEffect(() => {
    if (v.instructions === base) return;
    if (!dirty) {
      setBase(v.instructions);
      setText(v.instructions);
    }
  }, [v.instructions]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const changed = dirty && text !== v.instructions;
  const valid =
    changed &&
    text.length >= 30 &&
    text.length <= 12000 &&
    note.length >= 3 &&
    note.length <= 300;
  return (
    <form
      className="panel st-instructions"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await act(p.api("/versions"), { instructions: text, note })) {
          setBase(text);
          setNote("");
        }
      }}
    >
      <div className="section-title">
        <div>
          <h2>Instrucciones del agente</h2>
          <span className="muted">
            Guardar crea una versión nueva con las lecciones activas de ahora.
          </span>
        </div>
        {dirty && (
          <span className="st-dirty" role="status">
            <i aria-hidden="true" /> Cambios sin guardar
          </span>
        )}
      </div>
      {dirty && v.instructions !== base && (
        <p className="st-warn">
          La versión activa ha cambiado mientras editabas. Si guardas, tus
          instrucciones sustituyen a las suyas.
        </p>
      )}
      <div className="st-label">
        <label htmlFor="st-instructions">Instrucciones activas</label>
        <Counter
          id="st-instructions-count"
          length={text.length}
          min={30}
          max={12000}
        />
      </div>
      <textarea
        id="st-instructions"
        className="st-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        minLength={30}
        maxLength={12000}
        rows={14}
        required
        spellCheck
        aria-describedby="st-instructions-count"
      />
      <div className="st-label">
        <label htmlFor="st-note">Motivo del cambio</label>
        <Counter id="st-note-count" length={note.length} min={3} max={300} />
      </div>
      <input
        id="st-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        minLength={3}
        maxLength={300}
        required
        placeholder="Qué esperas mejorar con esta versión"
        aria-describedby="st-note-count"
      />
      <div className="st-savebar">
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setText(v.instructions);
              setBase(v.instructions);
            }}
          >
            Descartar cambios
          </button>
        )}
        <button className="primary" disabled={busy || !valid}>
          Crear y activar versión
        </button>
      </div>
    </form>
  );
}
