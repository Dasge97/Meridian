import React from "react";
import {
  CircleCheck,
  CircleDashed,
  TriangleAlert,
  OctagonAlert,
} from "lucide-react";
import type { ViewProps } from "./types";
import { date } from "../shared";
import { Confirm } from "../ui";
import { Limits } from "./settings-limits";
import { Instructions, Versions } from "./settings-instructions";
import "./settings.css";

type Level = "ok" | "partial" | "off";
const LEVEL_TEXT: Record<Level, string> = {
  ok: "Configurada",
  partial: "Responde a medias",
  off: "Sin configurar",
};
const LEVEL_ICON = {
  ok: CircleCheck,
  partial: TriangleAlert,
  off: CircleDashed,
};

function Connection(p: {
  name: string;
  level: Level;
  children: React.ReactNode;
  meta: React.ReactNode;
}) {
  const Icon = LEVEL_ICON[p.level];
  return (
    <li className={"st-conn " + p.level}>
      <div className="st-conn-head">
        <h3>{p.name}</h3>
        <span className="st-level">
          <Icon size={15} aria-hidden /> {LEVEL_TEXT[p.level]}
        </span>
      </div>
      <p>{p.children}</p>
      <small>{p.meta}</small>
    </li>
  );
}

export function SettingsView(p: ViewProps) {
  const { s, busy, act } = p;
  const c = s.connection;
  const feedsDown = Boolean(s.feeds && (!s.feeds.trades || !s.feeds.clock));
  return (
    <>
      <section className="panel st-connections">
        <div className="group-title">
          <h2>Conexiones</h2>
          <span>
            Las claves viven en el servidor. El panel solo ve si existen.
          </span>
        </div>
        <ul>
          <Connection
            name="Alpaca Paper"
            level={!c.alpaca ? "off" : feedsDown ? "partial" : "ok"}
            meta={<>Última sincronización: {date(s.lastSync)}</>}
          >
            {!c.alpaca
              ? "Configura ALPACA_KEY_ID y ALPACA_SECRET_KEY con claves de simulación."
              : feedsDown
                ? "La cuenta sincroniza, pero faltan precios o el calendario de mercado."
                : "Claves de simulación configuradas. Se comprueban en cada sincronización."}
          </Connection>
          <Connection
            name="Avisos por Telegram"
            level={c.telegram ? "ok" : "off"}
            meta="El bot solo informa. No acepta órdenes."
          >
            {c.telegram
              ? "Avisa cuando opera, cuando se ejecuta una orden y cuando algo falla."
              : "Configura TELEGRAM_TOKEN y TELEGRAM_CHAT_ID para recibir avisos."}
          </Connection>
          <Connection
            name="Modelo"
            level={c.model ? "ok" : "off"}
            meta="Compatible con Chat Completions y respuesta JSON."
          >
            {c.model ? (
              <span className="num">{c.modelName ?? "Modelo configurado"}</span>
            ) : (
              "Configura LLM_API_KEY y LLM_MODEL en el servidor."
            )}
          </Connection>
        </ul>
      </section>
      <div className="st-layout">
        <div className="st-main">
          <Limits key={JSON.stringify(s.settings)} {...p} />
          <Instructions {...p} />
        </div>
        <div className="st-side">
          <Versions {...p} />
          <section
            className="panel st-danger"
            aria-labelledby="st-danger-title"
          >
            <div className="st-danger-head">
              <OctagonAlert size={18} aria-hidden />
              <h2 id="st-danger-title">Zona peligrosa</h2>
            </div>
            <h3>Detener operaciones pendientes</h3>
            <p>
              Pausa el agente y pide a Alpaca que cancele todas las órdenes
              abiertas de esta cuenta. También las que hayas puesto a mano.
            </p>
            <p className="muted">
              No vende posiciones. Usa una cuenta Paper exclusiva para Meridian.
            </p>
            <Confirm
              title="¿Pausar y cancelar todas las órdenes abiertas?"
              description={
                <>
                  <p>El agente se pausa.</p>
                  <p>
                    Se pide a Alpaca que cancele todas las órdenes abiertas de
                    esta cuenta Paper, incluidas las manuales. Las posiciones no
                    se venden.
                  </p>
                </>
              }
              action="Pausar y cancelar órdenes"
              danger
              onConfirm={() => act("/orders/cancel-open")}
            >
              <button
                type="button"
                className="danger solid"
                disabled={busy || !c.alpaca}
              >
                Pausar y cancelar órdenes
              </button>
            </Confirm>
            {!c.alpaca && (
              <small>Necesita la conexión con Alpaca configurada.</small>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
