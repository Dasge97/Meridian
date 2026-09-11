# Meridian

Laboratorio personal de trading simulado contra Alpaca Paper. Un agente propone
acciones tipadas, un worker las valida contra límites que el modelo no puede
editar, y un panel web permite revisar cada decisión, aprobar lecciones y
versionar las instrucciones del agente.

El detalle funcional está en `README.md` y el técnico en `docs/ARCHITECTURE.md`.

## Piezas

- `api`: servidor Fastify que sirve la API y el panel React compilado.
- `worker`: proceso independiente que escucha el mercado, comprueba las
  vigilancias, llama al modelo y envía las órdenes a Alpaca Paper.
- `migrate`: prepara el esquema y termina.
- `db`: PostgreSQL 17 con el estado del laboratorio.

Solo hay un worker activo a la vez, garantizado por un advisory lock de
PostgreSQL. La API y el worker usan la misma imagen con comandos distintos.

## Deployment

```
mode: compose
public_service: api
internal_port: 3000
healthcheck_path: /api/health
```

El worker y la base de datos no se publican. `GET /api/health` responde
`{"ok":true}` y no pide sesión.

## Variables de entorno

| Variable            | Para qué sirve                                                     |
| ------------------- | ------------------------------------------------------------------ |
| `POSTGRES_DB`       | Nombre de la base de datos. Valor esperado: `meridian`.            |
| `POSTGRES_USER`     | Usuario de la base de datos. Valor esperado: `meridian`.           |
| `POSTGRES_PASSWORD` | Contraseña de la base de datos.                                    |
| `DATABASE_URL`      | Cadena de conexión completa que usan la API, el worker y migrate.  |
| `ADMIN_PASSWORD`    | Contraseña de acceso al panel. Mínimo 16 caracteres.               |
| `SESSION_SECRET`    | Secreto que firma la cookie de sesión. Mínimo 32 caracteres.       |
| `APP_ORIGIN`        | Origen exacto del navegador, sin barra final.                      |
| `ALPACA_KEY_ID`     | Clave de una cuenta Alpaca **Paper Only**.                         |
| `ALPACA_SECRET_KEY` | Secreto de esa misma cuenta Paper.                                 |
| `LLM_API_KEY`       | Clave del proveedor del modelo.                                    |
| `LLM_MODEL`         | Identificador del modelo a usar.                                   |
| `LLM_BASE_URL`      | Dirección base compatible con Chat Completions.                    |
| `ALLOW_LOCAL_LLM`   | `true` solo si el proveedor del modelo se sirve por HTTP sin TLS.  |
| `TRUST_PROXY`       | `true` solo si el único acceso al puerto local es un proxy fiable. |

La API se niega a arrancar si `SESSION_SECRET` no llega a 32 caracteres o
`ADMIN_PASSWORD` no llega a 16. El panel arranca sin las claves de Alpaca ni del
modelo, pero el agente no se puede activar sin ellas.

## Seguridad

El destino de trading está fijado en el código a `https://paper-api.alpaca.markets`
y no admite cambiarse por configuración. No existe ruta a trading real.

Acceso con contraseña única de propietario, cookie HttpOnly con SameSite Strict
firmada con HMAC, comprobación exacta del Origin en cada mutación y límite de
intentos de login. Los contenedores corren sin root, sin capacidades Linux y con
el sistema de ficheros en solo lectura salvo `/tmp`.
