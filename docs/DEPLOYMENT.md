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

Pausa el agente, comprueba órdenes pendientes y crea una copia. Después:

```bash
git pull --ff-only origin main
docker compose up -d --build
```

Si vienes de la primera versión, su migración reparte el estado en dos filas de `meridian_state`: la fila 1 con lo que cambia cada dos segundos y la fila 2 con el historial. No se pierde nada y no hay que hacer nada a mano. A partir de esa actualización el historial se poda: consulta sus topes en [ARCHITECTURE.md](ARCHITECTURE.md) y guarda una copia si quieres conservarlo entero.

Revisa logs y estado antes de reanudar. No actualices la major de PostgreSQL sin un procedimiento de migración de datos.

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

Una pausa impide nuevas intenciones; una petición ya en vuelo puede completarse. Usa «Pausar y cancelar órdenes» y confirma luego los estados en Alpaca. No borres decisiones inciertas para desbloquear el agente.

Si una orden queda incierta pero no aparece en Alpaca, espera al menos dos minutos y usa «Verificar que no se envió». El servidor exige una respuesta 404 del proveedor antes de cerrar la intención como no enviada. No reenvía esa orden. Si la orden existe, usa Reconciliar.
