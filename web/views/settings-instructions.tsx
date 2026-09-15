import React, { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { ViewProps } from "./types";
import { date } from "../shared";
import { Confirm } from "../ui";
import { Counter, versionNumbers } from "./settings-counter";

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
        if (await act("/versions", { instructions: text, note })) {
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

export function Versions(p: ViewProps) {
  const { s, busy, act } = p;
  const [all, setAll] = useState(false);
  const numbers = versionNumbers(s.versions);
  const list = [...s.versions].reverse();
  const shown = all ? list : list.slice(0, 6);
  return (
    <section className="panel st-versions">
      <div className="group-title">
        <h2>Versiones</h2>
        <span>{s.versions.length} guardadas</span>
      </div>
      <ol className="st-timeline">
        {shown.map((x) => {
          const n = numbers.get(x.id)!,
            active = x.id === s.activeVersion,
            prev = s.versions[n - 2];
          return (
            <li key={x.id} className={active ? "on" : undefined}>
              <span className="st-dot" aria-hidden="true" />
              <div className="st-ver-head">
                <strong>Versión {n}</strong>
                {active && <span className="st-active">Activa</span>}
                <time dateTime={x.createdAt}>{date(x.createdAt)}</time>
              </div>
              <p>{x.note}</p>
              <div className="st-ver-foot">
                <small>
                  <span className="num">{x.lessonIds.length}</span>{" "}
                  {x.lessonIds.length === 1 ? "lección" : "lecciones"}
                  {prev && prev.instructions !== x.instructions
                    ? " · instrucciones nuevas"
                    : ""}
                </small>
                {!active && (
                  <Confirm
                    title={`¿Recuperar la versión ${n}?`}
                    description={
                      <>
                        <p>
                          Vuelven sus instrucciones y sus {x.lessonIds.length}{" "}
                          lecciones activas.
                        </p>
                        <p>
                          Las lecciones activas que no estaban en ella pasan a
                          propuestas. No se borra ninguna versión.
                        </p>
                      </>
                    }
                    action="Recuperar versión"
                    onConfirm={() => act(`/versions/${x.id}/activate`)}
                  >
                    <button
                      type="button"
                      className="st-restore"
                      disabled={busy}
                    >
                      <RotateCcw size={14} aria-hidden /> Recuperar
                    </button>
                  </Confirm>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {list.length > 6 && (
        <button
          type="button"
          className="link st-more"
          onClick={() => setAll(!all)}
          aria-expanded={all}
        >
          {all ? "Ver solo las recientes" : `Ver las ${list.length}`}
        </button>
      )}
    </section>
  );
}
