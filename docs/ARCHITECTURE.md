# Arquitectura de Meridian

## Decisiones de diseño

TypeScript compartido entre API, worker y panel. React/Vite para la interfaz; Fastify para HTTP; PostgreSQL para persistencia. API y worker usan la misma imagen Docker, con comandos distintos. El endpoint de trading está fijado a `https://paper-api.alpaca.markets` en código y no admite override por configuración.

Un documento JSONB contiene el estado del laboratorio. Las mutaciones toman un bloqueo de fila y se confirman en una transacción: evita perder cambios simultáneos del panel y del worker. Se ha priorizado simplicidad operativa para un propietario. El historial crece sin purgar decisiones; exportar/copiar la base regularmente. A gran escala debe migrarse a tablas de decisiones, eventos, órdenes y snapshots paginados.

## Eventos y vigilia

El worker recibe trades IEX y conserva el más reciente por activo. Cada iteración persiste datos, caduca/invalida vigilancias y encola las condiciones cumplidas. Una vigilancia activada deja de ser activa en la misma transacción que crea el evento. No hay repetición mientras el precio siga superando el umbral. Se evalúan niveles, no cruces de precio: una condición ya satisfecha puede activarse en la primera muestra válida.

Al pausar, no se disparan condiciones de precio, aunque las vigilancias pueden caducar. La cola permanece para reanudar. Las propuestas autónomas son declarativas (≤, ≥, invalidaciones y caducidad); no hay `eval`, shell ni SQL generado por el modelo.

El WebSocket reconecta cada 10 segundos si falla. La sincronización HTTP aporta un fallback de último trade y reconcilia la cuenta. No existe una recuperación tick a tick de lo sucedido durante una desconexión: si una condición se cumplió y revirtió mientras el sistema estaba desconectado, puede no detectarse. Esto es un laboratorio de baja frecuencia.

## Modelo y memoria

Se reserva el trabajo y se incrementa el contador diario antes de llamar al modelo. La llamada se realiza fuera de las transacciones de PostgreSQL, por lo que el panel puede pausar o cambiar parámetros durante una evaluación. Al terminar se revisan configuración, versión, pausa y límites; una propuesta obsoleta no se envía.

Se acepta únicamente JSON validado. El contexto incluye cartera, precios, límites, vigilancias, lecciones de la versión activa y las últimas 8 decisiones. No hay búsqueda vectorial ni navegación web autónoma. La fuente de una lección externa es una referencia aportada por el usuario, no una página descargada ni verificada automáticamente.

Las revisiones posteriores reciben decisión, cotizaciones disponibles, posiciones y órdenes. Sus lecciones quedan propuestas hasta aprobación del propietario. Una aprobación o rechazo crea una versión de memoria/instrucciones. Recuperar una versión restaura sus lecciones activas.

Errores de evaluación se registran sin guardar claves ni respuestas crudas del proveedor. El intento consume presupuesto. Un evento fallido requiere una nueva solicitud o evento; una revisión admite 3 intentos. Un reinicio durante una llamada puede perder su resultado, pero conserva el intento reservado.

## Órdenes e idempotencia

1. Guardar la decisión y una intención `pending` sin enviar nada.
2. En otra iteración comprobar estado actual, cuenta, precios, límites y mercado.
3. Marcar `submitting` y conservar hora del intento.
4. Enviar una orden limitada Paper con el UUID de decisión como `client_order_id`.
5. Guardar estado del proveedor y reconciliar en sincronizaciones posteriores.

Si el envío o su confirmación fallan, marcar `unknown` y pausar. La recuperación consulta por `client_order_id`. Nunca se reenvía a ciegas. Una orden pendiente/ambigua bloquea otras. Se usa advisory lock de PostgreSQL para impedir workers simultáneos.

Los límites son controles previos, no garantías de precio final o de pérdida máxima. Una venta requiere acciones suficientes; una compra debe caber en efectivo, exposición y límite por posición. El umbral de pérdida compara patrimonio actual con la primera sincronización; bloquea compras nuevas, no cierra posiciones.

## Seguridad

Contraseña de propietario, verificación scrypt, cookie HttpOnly/SameSite Strict firmada con HMAC y expiración de 12 horas. HTTPS habilita Secure. Verificación exacta de Origin en mutaciones y límites de peticiones/intentos de login. Secretos fuera de Git y del frontend; el panel solo recibe indicadores de configuración. Cambiar SESSION_SECRET invalida sesiones existentes.

API ligada al loopback del host mediante Compose; acceso público por proxy TLS. Base de datos sin puerto publicado. Contenedores de aplicación sin root, sin capacidades Linux, con filesystem de solo lectura salvo /tmp. Cuenta Paper exclusiva: cancelar todas las órdenes puede afectar operaciones hechas manualmente en esa misma cuenta.

## Evoluciones posteriores

Histórico OHLCV y benchmarks; métricas de ejecución y costes; selección de recuerdos por relevancia; experimentos A/B con ventanas fuera de muestra; aprendizaje autónomo bajo evidencia; noticias con fuente/fecha; almacenamiento normalizado y paginado. Son siguientes pasos, no capacidades activas de esta versión.
