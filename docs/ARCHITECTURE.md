# Arquitectura de Meridian

## Decisiones de diseño

TypeScript compartido entre API, worker y panel. React/Vite para la interfaz; Fastify para HTTP; PostgreSQL para persistencia. API y worker usan la misma imagen Docker, con comandos distintos. El endpoint de trading está fijado a `https://paper-api.alpaca.markets` en código y no admite override por configuración.

El estado del laboratorio vive en dos filas JSONB de la tabla `meridian_state`. La fila 1 guarda lo que cambia constantemente: pausa, límites, cotizaciones, vigilancias, cuenta, posiciones, órdenes, cola y latido. La fila 2 guarda el historial: versiones, lecciones, decisiones, eventos, patrimonio y consumo. Cada mutación lee ambas filas con bloqueo, aplica el cambio y reescribe solo la fila cuyo contenido ha cambiado. El worker escribe la fila 1 cada dos segundos; la fila 2 solo se escribe cuando ocurre algo. Así el tamaño del historial no encarece las escrituras de mantenimiento.

El historial está acotado. Se conservan 2.000 decisiones, 1.000 eventos, 500 vigilancias cerradas, 500 lecciones descartadas y 2.000 registros de consumo. El contexto guardado de una decisión es su campo más pesado y solo se conserva en las 500 más recientes. La curva de patrimonio mantiene todas las muestras de los últimos 3 días y una por hora en lo anterior, hasta 3.000 puntos. Las lecciones aceptadas y las vigilancias activas nunca se descartan, porque las versiones las referencian. A gran escala debe migrarse a tablas de decisiones, eventos, órdenes y snapshots paginados.

## Eventos y vigilia

El worker ejecuta tres bucles independientes en el mismo proceso, cada uno con su propia espera de dos segundos. El primero atiende el mercado: recibe trades IEX, conserva el más reciente por activo, caduca o invalida vigilancias y encola las condiciones cumplidas. El segundo atiende al bróker: sincroniza la cuenta cada 30 segundos, reconcilia órdenes ambiguas y envía las intenciones aprobadas. El tercero llama al modelo. Separarlos evita que una llamada al modelo de hasta 45 segundos, o una petición lenta a Alpaca, dejen de comprobar las condiciones de precio durante ese tiempo.

Una vigilancia activada deja de ser activa en la misma transacción que crea el evento. No hay repetición mientras el precio siga superando el umbral. Se evalúan niveles, no cruces de precio: una condición ya satisfecha puede activarse en la primera muestra válida.

Al pausar, no se disparan condiciones de precio, aunque las vigilancias pueden caducar. La cola permanece para reanudar. Las propuestas autónomas son declarativas (≤, ≥, invalidaciones y caducidad); no hay `eval`, shell ni SQL generado por el modelo.

El WebSocket reconecta cada 10 segundos si falla. La sincronización HTTP aporta un fallback de último trade y reconcilia la cuenta. No existe una recuperación tick a tick de lo sucedido durante una desconexión: si una condición se cumplió y revirtió mientras el sistema estaba desconectado, puede no detectarse. Esto es un laboratorio de baja frecuencia.

## Modelo y memoria

Se reserva el trabajo y se incrementa el contador diario antes de llamar al modelo. La llamada se realiza fuera de las transacciones de PostgreSQL, por lo que el panel puede pausar o cambiar parámetros durante una evaluación. Al terminar se revisan configuración, versión, pausa y límites; una propuesta obsoleta no se envía.

Se acepta únicamente JSON validado. El contexto incluye cartera, precios, límites, vigilancias, lecciones de la versión activa y las últimas 8 decisiones. Su tamaño está acotado a 60.000 caracteres: si la memoria aprobada crece por encima, se recortan primero las lecciones más antiguas y el cuerpo de cada una, después el número de decisiones recientes. El contexto indica cuántas lecciones se han omitido. No hay búsqueda vectorial ni navegación web autónoma. La fuente de una lección externa es una referencia aportada por el usuario, no una página descargada ni verificada automáticamente.

Las revisiones posteriores reciben decisión, cotizaciones disponibles, posiciones y las 20 órdenes más recientes, con el mismo tope de tamaño. Sus lecciones quedan propuestas hasta aprobación del propietario. Una aprobación o rechazo crea una versión de memoria/instrucciones. Recuperar una versión restaura sus lecciones activas.

Errores de evaluación se registran sin guardar claves ni respuestas crudas del proveedor. El intento consume presupuesto. Un evento fallido requiere una nueva solicitud o evento; una revisión admite 3 intentos. Un reinicio durante una llamada puede perder su resultado, pero conserva el intento reservado.

Las transiciones de estado del worker viven en `src/agent.ts` y no hacen entrada/salida: reservar trabajo, reservar una intención, aplicar una sincronización, aplicar el mercado, guardar una decisión y guardar una revisión. `src/worker.ts` solo se ocupa de la conexión, los bucles y las llamadas HTTP. Las pruebas ejercitan las transiciones directamente, sin base de datos ni red.

## Órdenes e idempotencia

1. Guardar la decisión y una intención `pending` sin enviar nada.
2. En otra iteración comprobar estado actual, cuenta, precios, límites y mercado.
3. Marcar `submitting` y conservar hora del intento.
4. Enviar una orden limitada Paper con el UUID de decisión como `client_order_id`.
5. Guardar estado del proveedor y reconciliar en sincronizaciones posteriores.

El precio límite se envía con dos decimales, o con cuatro por debajo de un dólar, que es lo que acepta Alpaca.

Si el envío o su confirmación fallan, marcar `unknown` y pausar. La recuperación consulta por `client_order_id`. Nunca se reenvía a ciegas. Una orden pendiente/ambigua bloquea otras. Se usa advisory lock de PostgreSQL para impedir workers simultáneos.

Los límites son controles previos, no garantías de precio final o de pérdida máxima. Una venta requiere acciones suficientes; una compra debe caber en efectivo, exposición y límite por posición. El umbral de pérdida compara patrimonio actual con la primera sincronización; bloquea compras nuevas, no cierra posiciones.

## Panel

`GET /api/state` no devuelve el historial completo. Envía las 300 decisiones más recientes sin su contexto guardado, 200 eventos, 500 muestras de patrimonio y 200 registros de consumo, más un recuento total de cada uno. El panel pide el contexto de una decisión concreta a `GET /api/decisions/:id` al abrir su detalle. El panel consulta el estado cada 5 segundos, así que la respuesta no debe crecer con el historial.

Los errores que el propietario puede corregir se devuelven con código 400 y un mensaje concreto: faltan claves, orden sin reconciliar, vigilancia fuera de límites, elemento inexistente. El código 500 queda para fallos no previstos y su mensaje no revela detalles internos.

## Seguridad

Contraseña de propietario, verificación scrypt, cookie HttpOnly/SameSite Strict firmada con HMAC y expiración de 12 horas. HTTPS habilita Secure. Verificación exacta de Origin en mutaciones y límites de peticiones/intentos de login. Secretos fuera de Git y del frontend; el panel solo recibe indicadores de configuración. Cambiar SESSION_SECRET invalida sesiones existentes.

API ligada al loopback del host mediante Compose; acceso público por proxy TLS. Base de datos sin puerto publicado. Contenedores de aplicación sin root, sin capacidades Linux, con filesystem de solo lectura salvo /tmp. Cuenta Paper exclusiva: cancelar todas las órdenes puede afectar operaciones hechas manualmente en esa misma cuenta.

## Evoluciones posteriores

Histórico OHLCV y benchmarks; métricas de ejecución y costes; selección de recuerdos por relevancia; experimentos A/B con ventanas fuera de muestra; aprendizaje autónomo bajo evidencia; noticias con fuente/fecha; almacenamiento normalizado y paginado. Son siguientes pasos, no capacidades activas de esta versión.
