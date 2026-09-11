# Validación de la entrega

## Comprobaciones ejecutadas en el entorno de desarrollo

- Compilación TypeScript estricta y generación de frontend de producción con Vite.
- Pruebas de límites de órdenes: efectivo, posiciones, exposición, pérdida, pausa, activos y datos caducados/no válidos.
- Pruebas de vigilancias: activación única, invalidación prioritaria, caducidad y tiempos inválidos/futuros.
- Pruebas de las transiciones del worker sin red ni base de datos: reserva de trabajo del modelo, prioridad de una revisión vencida, recuperación de una evaluación interrumpida, bloqueo de una propuesta cuando cambian los límites durante la evaluación, y reconciliación de una orden ejecutada.
- Pruebas de la poda del historial: se respetan los topes, se descarta el contexto guardado de las decisiones antiguas y nunca se borran lecciones aceptadas ni vigilancias activas.
- Pruebas HTTP por inyección Fastify: login, cookie firmada, acceso no autenticado, Origin/CSRF, validación y archivos estáticos.
- Pruebas de adaptadores con respuestas controladas: destino fijo Paper, errores HTTP y salida JSON del agente con memoria aprobada.
- Auditoría npm de dependencias de producción: sin vulnerabilidades detectadas en la comprobación de esta entrega.

## Comprobaciones con PostgreSQL real

Ejecutadas contra un contenedor `postgres:17-bookworm` en el entorno de desarrollo, y también por el workflow CI en cada push:

- Migración desde el esquema de la primera versión, que guardaba todo el estado en una sola fila con `CHECK (id=1)`.
- El estado queda repartido en dos filas: la fila 1 no contiene el historial y la fila 2 sí.
- Una escritura que solo cambia el latido reescribe la fila 1 y deja intacta la fila 2, comprobado con el `xmin` de cada fila.
- Persistencia, aprobación de lecciones, recuperación de versiones y escrituras concurrentes.
- Los errores que el propietario puede corregir devuelven código 400 con un mensaje concreto, no un 500 genérico.
- `GET /api/state` no incluye el contexto guardado de las decisiones y sí un recuento total.

También se arrancó el worker contra esa base de datos: toma el advisory lock, escribe el latido, un segundo worker se niega a arrancar y el primero termina con código 0 al recibir SIGTERM.

## No validado aquí

No se ha ejecutado la imagen Docker completa ni se ha hecho comprobación visual con navegador.

No se han usado claves privadas de Alpaca ni de un proveedor de modelos, por lo que no se ha enviado ninguna orden, consultado una cuenta real ni gastado tokens de esos proveedores. La aceptación con la cuenta Paper, su feed IEX y el modelo elegido debe hacerse al configurar el servidor según el README. La rentabilidad y la calidad del aprendizaje no están demostradas.
