# Ensayo de la migración con la copia de producción

Pasos para probar la separación en simulaciones, con Alpaca Paper y la Interna, con una copia real antes de desplegar. Todo pasa en una base desechable en local: no se toca el servidor ni la cuenta de Alpaca. Los comandos son de bash y se ejecutan desde la raíz del repositorio, con la rama que se va a desplegar.

## 0. Qué hace falta

- Docker en local.
- La copia de producción en formato `-Fc`, por ejemplo `backups/antes-simulaciones.dump`, hecha con api y worker parados como dice [DEPLOYMENT.md](../docs/DEPLOYMENT.md). Tiene datos de la cuenta: no la subas al repositorio.
- `npm ci` hecho.
- Las consultas de los pasos 2, 3 y 4 guardadas fuera del repositorio como `antes.sql`, `filas.sql`, `despues.sql` y `interna.sql`.

## 1. Base desechable con la copia

```bash
docker run -d --rm --name meridian-ensayo-pg \
  -e POSTGRES_PASSWORD=solo_ensayo -e POSTGRES_USER=meridian -e POSTGRES_DB=meridian_rehearsal_test \
  -p 55434:5432 postgres:17
until docker exec meridian-ensayo-pg pg_isready -U meridian -d meridian_rehearsal_test; do sleep 1; done
docker exec -i meridian-ensayo-pg pg_restore -U meridian -d meridian_rehearsal_test --no-owner < backups/antes-simulaciones.dump
export DATABASE_URL=postgresql://meridian:solo_ensayo@localhost:55434/meridian_rehearsal_test
psql_ensayo() { docker exec -i meridian-ensayo-pg psql -U meridian -d meridian_rehearsal_test "$@"; }
```

## 2. Recuentos del estado antiguo

`antes.sql`:

```sql
SELECT
  jsonb_array_length(c.data->'decisions') AS decisiones,
  (SELECT count(*) FROM jsonb_array_elements(c.data->'decisions') d WHERE d->'input' IS NOT NULL AND d->'input' <> 'null'::jsonb) AS con_contexto,
  jsonb_array_length(c.data->'events') AS eventos,
  jsonb_array_length(c.data->'equity') AS patrimonio,
  jsonb_array_length(c.data->'usage') AS consumo,
  jsonb_array_length(c.data->'lessons') AS lecciones,
  jsonb_array_length(c.data->'versions') AS versiones,
  jsonb_array_length(h.data->'watches') AS vigilancias,
  (SELECT count(*) FROM jsonb_array_elements(h.data->'watches') w WHERE w->>'status' = 'active') AS vigilancias_activas,
  jsonb_array_length(h.data->'positions') AS posiciones,
  jsonb_array_length(h.data->'orders') AS ordenes,
  (SELECT count(*) FROM jsonb_array_elements(h.data->'orders') o
     WHERE o->>'status' IN ('filled','canceled','expired','replaced','done_for_day','stopped','rejected')
       AND (o->>'filled_qty')::numeric > 0 AND (o->>'filled_avg_price')::numeric > 0) AS ejecuciones,
  jsonb_array_length(h.data->'queue') AS cola,
  jsonb_array_length(c.data->'stories') AS noticias,
  (SELECT count(*) FROM jsonb_array_elements(c.data->'stories') n WHERE n->>'commented' = 'true') AS comentadas,
  (SELECT count(*) FROM jsonb_object_keys(c.data->'analysis')) AS analisis,
  h.data->'settings'->>'riskProfile' AS nivel,
  h.data->>'paused' AS pausa,
  h.data->'modelJob' AS evaluacion_en_curso
FROM meridian_state h, meridian_state c
WHERE h.id = 1 AND c.id = 2;
```

```bash
psql_ensayo -x < antes.sql
psql_ensayo -c "SELECT id, pg_column_size(data), octet_length(data::text) FROM meridian_state"
```

Si `nivel` no es `balanced`, o `evaluacion_en_curso` no es `null`, la migración añade un evento por cada una. Si hay decisiones `pending`, `submitting` o `unknown`, o alguna posición con cantidad negativa, la migración aborta con el motivo: es lo esperado, y hay que resolverlo en producción antes de desplegar.

## 3. Migrar dos veces

`filas.sql`:

```sql
SELECT key, pg_column_size(data) AS guardado, octet_length(data::text) AS texto, xmin
FROM meridian_rows ORDER BY key;
```

```bash
npm run migrate
psql_ensayo < filas.sql
npm run migrate
psql_ensayo < filas.sql
psql_ensayo -c "SELECT id, data->>'paused' AS pausa, data->>'migratedTo' AS migrada FROM meridian_state ORDER BY id"
```

- La primera escribe «Schema ready» y crea seis filas: `shared:cold`, `shared:hot`, `sim:alpaca:cold`, `sim:alpaca:hot`, `sim:internal:cold` y `sim:internal:hot`. Todas con el mismo `xmin`: se crean en una sola transacción.
- La segunda no cambia nada: el `xmin` de las seis filas es el mismo en las dos consultas.
- `shared:hot` ocupa pocos kilobytes.
- La fila 1 de `meridian_state` dice `true` y `meridian_rows`. La fila 2 no cambia.

Con el estado sintético de las pruebas (mismos recuentos que producción) salieron 1,7 KB en `shared:hot`, 26 KB en `sim:alpaca:hot`, 3,5 KB en `sim:internal:hot`, 0,7 MB en `shared:cold`, 1,3 MB en `sim:alpaca:cold` y 1,25 MB en `sim:internal:cold`, en texto. La fila caliente de la interna es más pequeña porque solo lleva las vigilancias activas y ninguna orden.

## 4. Recuentos por clave

`despues.sql`:

```sql
SELECT
  jsonb_array_length(c.data->'decisions') AS decisiones,
  (SELECT count(*) FROM jsonb_array_elements(c.data->'decisions') d WHERE d->'input' IS NOT NULL AND d->'input' <> 'null'::jsonb) AS con_contexto,
  jsonb_array_length(c.data->'events') AS eventos,
  jsonb_array_length(c.data->'equity') AS patrimonio,
  jsonb_array_length(c.data->'usage') AS consumo,
  jsonb_array_length(c.data->'lessons') AS lecciones,
  jsonb_array_length(c.data->'versions') AS versiones,
  jsonb_array_length(h.data->'watches') AS vigilancias,
  (SELECT count(*) FROM jsonb_array_elements(h.data->'watches') w WHERE w->>'status' = 'active') AS vigilancias_activas,
  jsonb_array_length(h.data->'positions') AS posiciones,
  jsonb_array_length(h.data->'orders') AS ordenes,
  jsonb_array_length(c.data->'fills') AS ejecuciones,
  jsonb_array_length(h.data->'queue') AS cola,
  jsonb_array_length(sc.data->'stories') AS noticias,
  jsonb_array_length(h.data->'commentedStories') AS comentadas,
  (SELECT count(*) FROM jsonb_object_keys(sc.data->'analysis')) AS analisis,
  h.data->>'riskProfile' AS nivel,
  h.data->>'paused' AS pausa,
  h.data->'modelJob' AS evaluacion_en_curso
FROM meridian_rows h, meridian_rows c, meridian_rows sc
WHERE h.key = 'sim:alpaca:hot' AND c.key = 'sim:alpaca:cold' AND sc.key = 'shared:cold';
```

```bash
psql_ensayo -x < despues.sql
psql_ensayo -c "SELECT data->'comparison' FROM meridian_rows WHERE key='sim:alpaca:cold'"
```

Cada columna coincide con la del paso 2, salvo:

- `eventos`: uno más por cada evento que anunció el paso 2.
- `nivel`: siempre `balanced`.
- `evaluacion_en_curso`: siempre `null`.
- `pausa`: la de la simulación, igual que en el paso 2.

`comparison` lleva la hora de la migración, el patrimonio, el efectivo y las posiciones con su precio medio.

`interna.sql`, los mismos recuentos de la Interna al lado de los de Alpaca:

```sql
SELECT
  sim,
  jsonb_array_length(c.data->'decisions') AS decisiones,
  (SELECT count(*) FROM jsonb_array_elements(c.data->'decisions') d WHERE d->'input' IS NOT NULL AND d->'input' <> 'null'::jsonb) AS con_contexto,
  jsonb_array_length(c.data->'events') AS eventos,
  jsonb_array_length(c.data->'equity') AS patrimonio,
  jsonb_array_length(c.data->'usage') AS consumo,
  jsonb_array_length(c.data->'lessons') AS lecciones,
  jsonb_array_length(c.data->'versions') AS versiones,
  h.data->>'activeVersion' AS version_activa,
  jsonb_array_length(h.data->'watches') AS vigilancias,
  (SELECT count(*) FROM jsonb_array_elements(h.data->'watches') w WHERE w->>'status' = 'active') AS vigilancias_activas,
  jsonb_array_length(h.data->'positions') AS posiciones,
  jsonb_array_length(h.data->'orders') AS ordenes,
  jsonb_array_length(c.data->'fills') AS ejecuciones,
  jsonb_array_length(h.data->'queue') AS cola,
  jsonb_array_length(h.data->'commentedStories') AS comentadas,
  h.data->'calls'->>'count' AS llamadas_hoy,
  h.data->'account'->>'cash' AS efectivo,
  h.data->'account'->>'equity' AS patrimonio_actual,
  h.data->>'baseline' AS baseline,
  h.data->>'riskProfile' AS nivel,
  h.data->>'paused' AS pausa,
  h.data->>'unresolved' AS por_reconciliar,
  c.data->'comparison'->>'startedAt' AS comparacion_desde
FROM (VALUES ('alpaca'), ('internal')) AS x(sim)
JOIN meridian_rows h ON h.key = 'sim:' || x.sim || ':hot'
JOIN meridian_rows c ON c.key = 'sim:' || x.sim || ':cold'
ORDER BY sim;
```

```bash
psql_ensayo -x < interna.sql
psql_ensayo -c "SELECT (SELECT array_agg(w->>'id') FROM jsonb_array_elements(data->'watches') w WHERE w->>'status'='active') FROM meridian_rows WHERE key LIKE 'sim:%:hot' ORDER BY key"
```

Justo después de migrar, antes de arrancar el worker, la Interna coincide con Alpaca en `decisiones`, `con_contexto`, `patrimonio`, `lecciones`, `versiones`, `version_activa`, `vigilancias_activas`, `posiciones`, `comentadas`, `efectivo`, `baseline`, `pausa` y `comparacion_desde`, salvo:

- `eventos`: uno más, «Simulación Interna creada como copia de Alpaca Paper», y otro si alguna decisión tenía su orden abierta en Alpaca.
- `vigilancias`: igual que `vigilancias_activas`, porque solo se copian las activas. Sus ids son distintos de los de Alpaca (la segunda consulta).
- `consumo`, `ordenes`, `ejecuciones`, `cola` y `llamadas_hoy`: 0.
- `nivel`: `aggressive`; Alpaca, `balanced`.
- `patrimonio_actual`: el efectivo más las posiciones al último precio que dio Alpaca, así que puede diferir en céntimos del que guarda Alpaca. Cuando el worker arranca, la Interna se valora con los precios compartidos cada 30 segundos.
- `por_reconciliar`: 0 en las dos.

## 5. Recorrer el panel

```bash
npm run build
ADMIN_PASSWORD=ensayo-solo-local-123456 \
  SESSION_SECRET=ensayo-solo-local-0123456789abcdefghijkl \
  APP_ORIGIN=http://localhost:3000 HOST=127.0.0.1 npm start
```

Sin claves de Alpaca ni del modelo. Entra en http://localhost:3000 y recorre todas las pestañas:

- Resumen: patrimonio, posiciones y eventos, también los compartidos.
- Mercado: velas y análisis.
- Decisiones: abre una antigua con contexto guardado.
- Vigilancias, Aprendizaje (lecciones y versiones) y Uso.
- Configuración: cambia el nivel de riesgo y guarda los límites; guardar los límites no cambia el nivel.
- El selector de la cabecera: cambia a Interna y repite Resumen, Decisiones (con la paginación en la página 3 y el detalle de una decisión abierto) y Configuración. La vista vuelve a la primera página, el detalle se cierra, el nivel es Agresivo y la zona peligrosa dice «Cancelar órdenes simuladas». Recarga: sigue en Interna, con `?sim=internal` en la dirección. `Ctrl K` tiene el grupo «Simulación» y las acciones dicen «Pausar Interna».
- Pausa la Interna desde el panel y comprueba que Alpaca sigue como estaba.

`curl -i http://localhost:3000/api/state` con la cookie de la sesión responde 410. `GET /api/sims/internal/state` lleva `sims` con las dos simulaciones.

## 6. Worker sin claves

Con la API parada, en otra terminal con el mismo `DATABASE_URL`:

```bash
npm run worker
```

Sin claves no llama a Alpaca ni al modelo. La Interna tampoco llama a Alpaca con claves: valora su cuenta en PostgreSQL. A los 40 segundos:

```bash
psql_ensayo < filas.sql      # cambian shared:hot (el latido) y sim:internal:hot (valora su cuenta cada 30 s)
npm run migrate:down         # aborta: «Hay un worker en marcha»
npm run worker               # se niega: «Otro worker está activo»
```

Para el primer worker con Ctrl C.

## 7. Vuelta atrás

```bash
npm run migrate:down
psql_ensayo -x < antes.sql
psql_ensayo -c "SELECT tablename FROM pg_tables WHERE tablename LIKE 'meridian_rows%'"
```

`meridian_rows` queda renombrada a `meridian_rows_<fecha>`, con las filas de la Interna dentro. Los recuentos vuelven a ser los del paso 2 salvo `pausa`, que vale `true`, y `eventos`, que suma los compartidos y uno de la vuelta atrás.

Para ensayar también la actualización desde una base ya separada con solo Alpaca: después de migrar, `psql_ensayo -c "DELETE FROM meridian_rows WHERE key LIKE 'sim:internal:%'"`, `npm run migrate` otra vez y `psql_ensayo -x < interna.sql`. La Interna vuelve a nacer como copia, y `comparacion_desde` de las dos pasa a la hora de esa migración.

Para probar la versión anterior contra ese estado, en otra carpeta con el commit anterior al despliegue y el mismo `DATABASE_URL`: `npm ci`, `npm run migrate` (no cambia nada), `npm run build` y `npm start` con las variables del paso 5. El panel antiguo abre con el agente en pausa y el historial entero. Después, `npm run migrate` con la rama nueva vuelve a migrar sin errores.

## 8. Limpiar

```bash
docker stop meridian-ensayo-pg
```

El contenedor se creó con `--rm` y se borra con sus datos al pararlo.
