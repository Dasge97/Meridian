# Validación de la entrega

## Comprobaciones ejecutadas en el entorno de desarrollo

- Compilación TypeScript estricta y generación de frontend de producción con Vite.
- Pruebas de límites de órdenes: efectivo, posiciones, exposición, pérdida, pausa, activos y datos caducados/no válidos.
- Pruebas de vigilancias: activación única, invalidación prioritaria, caducidad y tiempos inválidos/futuros.
- Pruebas de las transiciones del worker sin red ni base de datos: reserva de trabajo del modelo, prioridad de una revisión vencida, recuperación de una evaluación interrumpida, bloqueo de una propuesta cuando cambian los límites durante la evaluación, y reconciliación de una orden ejecutada.
- Pruebas de la poda del historial: se respetan los topes, se descarta el contexto guardado de las decisiones antiguas y nunca se borran lecciones aceptadas ni vigilancias activas.
- Pruebas HTTP por inyección Fastify: login, cookie firmada, acceso no autenticado, Origin/CSRF, validación y archivos estáticos. Recorren todas las rutas `/api/sims/:sim/...` de las dos simulaciones, `/api/compare` y las rutas antiguas, que responden 410.
- Pruebas de adaptadores con respuestas controladas: destino fijo Paper, errores HTTP y salida JSON del agente con memoria aprobada.
- Auditoría npm de dependencias de producción: sin vulnerabilidades detectadas en la comprobación de esta entrega.

## Comprobaciones con PostgreSQL real

Ejecutadas contra un contenedor `postgres:17` en el entorno de desarrollo, y también por el workflow CI en cada push:

- Migración desde el esquema de la primera versión, que guardaba todo el estado en una sola fila con `CHECK (id=1)`, y desde el de dos filas de `meridian_state`.
- El estado queda repartido en las seis filas de `meridian_rows`: `shared:hot`, `shared:cold` y una fila caliente y otra fría por simulación. La migración conserva todos los recuentos, no hace nada la segunda vez, aborta sin cambiar nada con una orden pendiente o una posición corta, y `migrate:down` la deshace.
- Un latido solo reescribe `shared:hot`; pausar una simulación solo reescribe su fila caliente. Comprobado con el `xmin` de cada fila.
- Una transición de simulación que toca lo compartido falla con el nombre del campo y no guarda nada.
- Persistencia, aprobación de lecciones, recuperación de versiones y escrituras concurrentes de los tres tipos de transacción.
- Los errores que el propietario puede corregir devuelven código 400 con un mensaje concreto, no un 500 genérico.
- `GET /api/sims/:sim/state` no incluye el contexto guardado de las decisiones y sí un recuento total, y lleva los eventos compartidos marcados con `scope`.

## Validación con dos simulaciones

Pruebas automáticas, sin red ni claves:

- La Interna nace como copia de Alpaca: cuenta, posiciones, lecciones, versiones, vigilancias activas con ids nuevos, decisiones con su contexto, eventos y curva. Sin consumo, órdenes, ejecuciones ni cola, en Agresivo y con la misma pausa que Alpaca. Las dos empiezan la comparación en el mismo instante.
- Las operaciones heredadas sin revisar quedan en la Interna con «Revisada en la simulación de Alpaca: es una operación anterior a la separación», y `claimJob` solo las elige en Alpaca.
- Las dos simulaciones se pausan por separado y sus transacciones no se bloquean entre sí.
- Una orden de la Interna se acepta, se ejecuta y se caduca sin llamar a Alpaca: la prueba sustituye Alpaca por una función que falla si se la llama. Reconciliar en la Interna responde 400.
- Ejecución simulada: último precio al llegar, precio límite si espera, sin ejecutar con precios viejos, fuera de sesión o sin efectivo.
- Ninguna venta de más acciones de las que hay pasa `orderGuard` en ningún nivel.
- `GET /api/compare` pide sesión, rechaza un `from` que no es una fecha ISO con hora y zona antes de leer la base de datos, y devuelve `from`, `sims`, `series` y `bySim` con las dos simulaciones en orden. Lo que lee sin el contexto de las decisiones da el mismo resultado que leer las simulaciones enteras.
- El panel se compila sin zod en los ficheros del navegador (`grep -l ZodError dist/assets/*.js` no encuentra nada).

Después de desplegar, con las claves reales:

1. Antes de parar nada, comprueba en el panel que no hay evaluaciones en curso ni órdenes pendientes, enviándose o sin reconciliar, ni posiciones cortas en Alpaca.
2. Sigue el procedimiento de [DEPLOYMENT.md](DEPLOYMENT.md): copia, migración con api y worker parados y arranque. Si la migración aborta, corrige lo que diga y repite ese paso.
3. En el selector de la cabecera aparecen Alpaca Paper en Equilibrado e Interna en Agresivo, con el mismo patrimonio y la misma pausa que tenía Alpaca.
4. En las dos: decisiones, eventos, vigilancias y el detalle de una decisión antigua. Una operación anterior a la separación que estaba pendiente de revisión dice en la Interna que la revisa Alpaca.
5. En Eventos, los fallos del feed y los cambios de límites aparecen en las dos con la marca «Compartido».
6. Activa las dos. Con la bolsa abierta, la Interna revisa el mercado más a menudo. Sus órdenes aparecen en su panel y en ningún caso en la cuenta Paper de Alpaca.
7. Pausa una y comprueba que la otra sigue observando.
8. Abre Comparar: las dos empiezan en índice 100 en el momento de la migración, y el resultado en USD, las operaciones y los tokens cuadran con lo que se ve en cada simulación.
9. Los avisos de Telegram llevan delante la simulación, por ejemplo «[Interna · Agresivo]». Con `TELEGRAM_NEWS_SIMS` solo comentan noticias las simulaciones indicadas.
10. En Uso, cada simulación cuenta sus propias llamadas. Revisa el gasto del proveedor al final del primer día: debería rondar el doble que antes, o algo más por el nivel Agresivo.

También se arrancó el worker contra esa base de datos: toma el advisory lock, escribe el latido, un segundo worker se niega a arrancar y el primero termina con código 0 al recibir SIGTERM.

## No validado aquí

No se ha ejecutado la imagen Docker completa. La revisión visual del panel se ha hecho con Edge sin interfaz y un servidor de datos de prueba, no contra el servidor real.

No se han usado claves privadas de Alpaca ni de un proveedor de modelos, por lo que no se ha enviado ninguna orden, consultado una cuenta real ni gastado tokens de esos proveedores. La aceptación con la cuenta Paper, su feed IEX y el modelo elegido debe hacerse al configurar el servidor según el README. La rentabilidad y la calidad del aprendizaje no están demostradas.
