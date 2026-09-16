# Despliegue personal

## Preparación

Servidor Linux con Docker Engine y Compose v2. Punto de partida orientativo: 2 vCPU, 2 GB RAM y 10 GB de disco; el consumo real depende del historial. El modelo se consume por API, no requiere GPU. No está desplegado automáticamente en ningún servicio de hosting.

Clona el repositorio, copia `.env.example` a `.env`, genera secretos diferentes y configura APP_ORIGIN con el dominio exacto sin barra final. La contraseña PostgreSQL se interpola en una URL: usa `openssl rand -hex 24` para evitar caracteres reservados. Las imágenes PostgreSQL se fijan a major 17 y la aplicación a Node 22; `package-lock.json` fija las dependencias JavaScript.

```bash
chmod 600 .env
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 api worker
```

Compose espera a PostgreSQL, ejecuta la migración idempotente y arranca API/worker. El puerto público de base de datos no se expone.

## Proxy HTTPS con Nginx

Ejemplo de bloque dentro de un `server` HTTPS existente con certificado válido:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 90s;
}
```

Conserva la configuración TLS de tu servidor y redirige HTTP a HTTPS. No publiques 3000 en `0.0.0.0`. El WebSocket de mercado sale desde el worker a Alpaca, no desde el navegador.

En Plesk: crea el subdominio, habilita su certificado y configura proxy inverso hacia el puerto local 3000, evitando duplicar un `location /` existente. No apuntes el document root a la raíz del repositorio ni sirvas `.env`. Mantén el checkout fuera del directorio público. La configuración exacta de Nginx depende del dominio y de si Plesk usa Apache como backend.

`TRUST_PROXY=false` limita peticiones por IP del proxy, suficiente para un propietario. Solo cambia a `true` si el único acceso al puerto 3000 es un proxy de confianza que sobrescribe las cabeceras reenviadas.

## Conectar proveedores

- Alpaca: una cuenta Paper Only dedicada, claves Paper. No aportes claves Live.
- Modelo: endpoint compatible con Chat Completions, `response_format=json_object` y `max_completion_tokens`. Algunos proveedores requieren adaptación. `LLM_MODEL` es explícito; no se selecciona un modelo de pago automáticamente.
- Para proveedor local por HTTP: `ALLOW_LOCAL_LLM=true`, `LLM_BASE_URL` accesible desde Docker, y un valor de LLM_API_KEY que acepte ese proveedor. La primera versión exige un campo de clave no vacío.

Tras modificar `.env`, recrea servicios:

```bash
docker compose up -d --force-recreate api worker
```

Sincronización y primera evaluación deben verificarse con tus cuentas antes de dejarlo activo. Activa alertas/cotas de gasto en el proveedor del modelo además del límite de llamadas de Meridian.

Hay dos simulaciones, Alpaca Paper e Interna, y cada una hace sus propias llamadas al modelo: cuenta con el doble de tokens y hasta el doble de `maxDailyCalls` al día. La interna no envía órdenes a Alpaca, pero necesita sus claves para los precios y el calendario. Dos variables opcionales:

- `MODEL_CONCURRENCY`: cuántas llamadas al modelo a la vez. Por defecto 2, una por simulación; un valor mayor da lo mismo. Pon `1` si el proveedor no aguanta dos a la vez: el worker las atiende por turnos, primero lo más urgente. Un valor que no es un entero positivo se toma como 2.
- `TELEGRAM_NEWS_SIMS`: qué simulaciones mandan sus comentarios de noticias por Telegram, separadas por comas (`alpaca`, `internal`). Por defecto las dos, así que llegan dos mensajes por tanda. Un nombre que no existe se ignora y el worker lo avisa al arrancar; si no queda ninguno válido, las dos. Los demás avisos llegan siempre.

## Copias y restauración

El volumen PostgreSQL conserva historial, instrucciones y vigilancias. `.env` necesita una copia privada separada. Crea backups fuera de Git, con permisos restringidos:

```bash
mkdir -p backups
chmod 700 backups
docker compose exec -T db pg_dump -U meridian -d meridian -Fc > backups/meridian.dump
chmod 600 backups/meridian.dump
```

Para restaurar una copia **sustituyendo el contenido existente** en un entorno preparado:

```bash
docker compose stop api worker
docker compose exec -T db pg_restore -U meridian -d meridian --clean --if-exists < backups/meridian.dump
docker compose run --rm migrate
docker compose up -d api worker
```

Comprueba la copia en un entorno de prueba antes de depender de ella. No ejecutes `docker compose down -v` salvo que quieras borrar el laboratorio.

## Actualización

Pausa las dos simulaciones, comprueba órdenes pendientes y crea una copia. Después:

```bash
git pull --ff-only origin main
docker compose up -d --build
```

La migración es idempotente: si no hay nada que migrar no cambia nada y no hace falta parar el worker. Si hay que migrar y el worker sigue en marcha, aborta con «Hay un worker en marcha: detén api y worker antes de migrar» y no toca nada; en ese caso sigue el procedimiento de abajo.

Si vienes de la primera versión, que guardaba todo el estado en una sola fila, la migración lo pasa en el mismo paso al formato de dos filas de `meridian_state` y de ahí a `meridian_rows`. No se pierde nada, pero es una migración con filas nuevas: sigue el procedimiento de «Actualización a las simulaciones separadas». A partir de esa actualización el historial se poda: consulta sus topes en [ARCHITECTURE.md](ARCHITECTURE.md) y guarda una copia si quieres conservarlo entero.

Revisa logs y estado antes de reanudar. No actualices la major de PostgreSQL sin un procedimiento de migración de datos.

### Actualización a las simulaciones separadas

La versión que separa lo compartido de cada simulación pasa el estado de `meridian_state` a la tabla `meridian_rows` (ver [ARCHITECTURE.md](ARCHITECTURE.md)). Hay que parar api y worker **antes** de la copia y de la migración: si no, el worker viejo sigue escribiendo en `meridian_state` mientras se copia, y lo que escriba se pierde. La migración lo comprueba con el bloqueo del worker y aborta si lo encuentra tomado.

La misma migración crea la simulación Interna como copia de la de Alpaca: la cuenta con sus posiciones, las lecciones, las versiones, las vigilancias activas, las decisiones, los eventos y la curva de patrimonio, sin consumo ni órdenes. Nace en Agresivo y con la misma pausa que Alpaca: si Alpaca está activa al migrar, la Interna empieza activa.

Antes de empezar, en el panel: pausa el agente, espera a que no haya ninguna evaluación en curso y comprueba que no queda ninguna orden pendiente, enviándose o sin reconciliar. En Alpaca, que no hay posiciones cortas ni efectivo negativo. La migración aborta con un mensaje concreto si encuentra alguna de esas cosas.

```bash
git pull --ff-only origin main
docker compose build
docker compose stop api worker
mkdir -p backups && chmod 700 backups
docker compose exec -T db pg_dump -U meridian -d meridian -Fc > backups/antes-simulaciones.dump
chmod 600 backups/antes-simulaciones.dump
docker compose exec -T db psql -U meridian -d meridian -c \
  "SELECT id, pg_column_size(data), octet_length(data::text) FROM meridian_state"
docker compose run --rm migrate
docker compose up -d
docker compose logs --tail=100 api worker
```

`docker compose build` va antes de parar nada, para que el laboratorio esté parado solo lo que tarda la copia. `docker compose run --rm migrate` muestra el motivo si la migración aborta; api y worker siguen parados y no se ha cambiado nada, así que se corrige lo que diga y se repite ese paso. `docker compose up -d` vuelve a pasar por la migración, que ya no hace nada. En el servidor, añade a cada orden de Compose el `-f` del fichero de producción si lo usas.

La migración deja las filas antiguas de `meridian_state` en pausa y marcadas con `migratedTo`. No las borres: son la red de seguridad para volver atrás.

Después, en el panel: Alpaca Paper sigue en pausa o activa como estaba, con su nivel en Equilibrado, y aparece Interna en el selector de la cabecera, con su nivel en Agresivo y la misma cuenta. Comprueba en las dos decisiones, eventos, vigilancias y el detalle de una decisión antigua antes de reanudar, y en Comparar que las dos empiezan en el mismo punto. Las operaciones antiguas pendientes de revisión solo las revisa Alpaca; en la Interna aparecen como revisadas en la simulación de Alpaca. La lista completa de comprobaciones está en [VALIDATION.md](VALIDATION.md). Los avisos de Telegram llevan delante la simulación, por ejemplo «[Interna · Agresivo]».

Si ya migraste a `meridian_rows` con una versión que solo tenía Alpaca, `docker compose run --rm migrate` añade la Interna con el mismo procedimiento: api y worker parados y sin órdenes pendientes en Alpaca.

### Volver atrás

Con cualquiera de las dos formas, primero para api y worker:

```bash
docker compose stop api worker
```

**Conservando lo ocurrido desde la migración** (recomendado). Con la imagen nueva aún construida, `migrate:down` devuelve a `meridian_state` el estado de la simulación de Alpaca con lo compartido, en pausa, y renombra `meridian_rows` a `meridian_rows_<fecha>`. La Interna no existía en la versión anterior: no vuelve, pero queda entera en esa tabla. Después se vuelve a la versión anterior:

```bash
docker compose run --rm migrate npm run migrate:down
git checkout <commit-anterior>
docker compose up -d --build
```

**Restaurando la copia.** Se pierde todo lo ocurrido desde la copia. `pg_restore --clean` solo sustituye lo que hay en la copia, y la copia no tiene `meridian_rows`: hay que borrarla a mano, porque si se queda, una migración posterior la daría por buena y arrancaría con el estado viejo.

```bash
docker compose exec -T db pg_restore -U meridian -d meridian --clean --if-exists < backups/antes-simulaciones.dump
docker compose exec -T db psql -U meridian -d meridian -c "DROP TABLE IF EXISTS meridian_rows"
git checkout <commit-anterior>
docker compose up -d --build
```

Arrancar la imagen anterior sin hacer ninguna de las dos cosas lee las filas congeladas de `meridian_state`: en pausa y sin lo ocurrido desde la migración. No envía nada, pero no sirve para seguir.

## Incidencias

| Síntoma                 | Comprobación                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------- |
| 403 en login/mutaciones | APP_ORIGIN debe ser el origen exacto del navegador                                  |
| No se activa            | Claves/modelo ausentes o intención con estado incierto                              |
| Precios antiguos        | Mercado cerrado, activo sin trades IEX recientes o conexión fallida                 |
| No vuelve a evaluar     | Pausa, cola vacía, espera mínima o límite diario alcanzado                          |
| Orden bloqueada         | Consulta error de la decisión; no reduzcas límites a ciegas                         |
| Orden `unknown`         | Verifica en Alpaca y pulsa Reconciliar; nunca la reenvíes manualmente sin comprobar |
| Worker sin señal        | Consulta logs y conexión PostgreSQL; solo puede existir un worker activo            |
| Revisión sin completar  | Requiere agente activo, presupuesto de llamadas y máximo 3 intentos                 |

Una pausa impide nuevas intenciones; una petición ya en vuelo puede completarse. Usa «Pausar y cancelar órdenes» y confirma luego los estados en Alpaca. No borres decisiones inciertas para desbloquear el agente. Pausar o cancelar actúa solo sobre la simulación elegida en el panel. En la Interna, «Cancelar órdenes simuladas» pausa esa simulación y cancela sus órdenes sin llamar a Alpaca; nunca tiene órdenes inciertas.

Si una orden queda incierta pero no aparece en Alpaca, espera al menos dos minutos y usa «Verificar que no se envió». El servidor exige una respuesta 404 del proveedor antes de cerrar la intención como no enviada. No reenvía esa orden. Si la orden existe, usa Reconciliar.
