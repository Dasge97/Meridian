# Arquitectura de Meridian

## Decisiones de diseño

TypeScript compartido entre API, worker y panel. React/Vite para la interfaz; Fastify para HTTP; PostgreSQL para persistencia. API y worker usan la misma imagen Docker, con comandos distintos. El endpoint de trading está fijado a `https://paper-api.alpaca.markets` en código y no admite override por configuración.

El estado del laboratorio vive en dos filas JSONB de la tabla `meridian_state`. La fila 1 guarda lo que cambia constantemente: pausa, límites, cotizaciones, vigilancias, cuenta, posiciones, órdenes, cola y latido. La fila 2 guarda el historial: versiones, lecciones, decisiones, eventos, patrimonio y consumo. Cada mutación lee ambas filas con bloqueo, aplica el cambio y reescribe solo la fila cuyo contenido ha cambiado. El worker escribe la fila 1 cada dos segundos; la fila 2 solo se escribe cuando ocurre algo. Así el tamaño del historial no encarece las escrituras de mantenimiento.

El historial está acotado. Se conservan 2.000 decisiones, 1.000 eventos, 500 vigilancias cerradas, 500 lecciones descartadas y 2.000 registros de consumo. El contexto guardado de una decisión es su campo más pesado y solo se conserva en las 500 más recientes. La curva de patrimonio mantiene todas las muestras de los últimos 3 días y una por hora en lo anterior, hasta 3.000 puntos. Las lecciones aceptadas y las vigilancias activas nunca se descartan, porque las versiones las referencian. A gran escala debe migrarse a tablas de decisiones, eventos, órdenes y snapshots paginados.

## Eventos y vigilia

El worker ejecuta cinco bucles independientes en el mismo proceso. El primero atiende el mercado cada dos segundos: recibe trades IEX, conserva el más reciente por activo, caduca o invalida vigilancias y encola las condiciones cumplidas. El segundo atiende al bróker cada dos segundos: sincroniza la cuenta cada 30 segundos, reconcilia órdenes ambiguas y envía las intenciones aprobadas. El tercero llama al modelo. El cuarto descarga velas diarias y de 5 minutos cada 5 minutos y el quinto pide noticias cada 30 minutos.

Con la sesión abierta, el bucle del bróker encola una revisión periódica del mercado si el agente lleva 30 minutos sin evaluar y no hay nada en cola. No empieza hasta 10 minutos después de la apertura, cuando ya hay velas de la sesión, y deja de hacerlo 15 minutos antes del cierre, porque no daría tiempo a gestionar una operación nueva. Al abrir y al cerrar la bolsa el análisis se recalcula al momento, sin esperar a su ciclo de 5 minutos. Antes el agente solo se despertaba por eventos y podía pasar la sesión entera sin evaluar nada. Separarlos evita que una llamada al modelo de hasta 45 segundos, o una petición lenta a Alpaca, dejen de comprobar las condiciones de precio durante ese tiempo.

Si la sincronización con Alpaca falla, se registra el motivo una sola vez por racha, y otra vez cuando vuelve a funcionar.

## Horario de la bolsa

El calendario de Alpaca dice si la bolsa está abierta y cuándo abre y cierra la próxima sesión. Se sincroniza cada 30 segundos. La sesión se da por abierta solo si el calendario responde, dice que está abierta y aún no ha llegado la hora de cierre. Sin esa última comprobación, una orden podía salir ya cerrada la bolsa y quedarse esperando a la sesión del día siguiente. Sin calendario se asume cerrada.

El modelo recibe el horario ya calculado: la hora actual en Nueva York y en España con su día de la semana, cuándo abre o cierra, y cuántos minutos faltan. Con solo una fecha en UTC no deducía bien el día: un lunes de madrugada seguía escribiendo que la bolsa abría «el lunes», copiando lo que había escrito el fin de semana.

Las fechas de las velas diarias y el contador diario de órdenes usan días distintos: las velas, el día de Nueva York; el contador de llamadas y órdenes, el día UTC.

Una vigilancia activada deja de ser activa en la misma transacción que crea el evento. No hay repetición mientras el precio siga superando el umbral. Se evalúan niveles, no cruces de precio: una condición ya satisfecha puede activarse en la primera muestra válida.

Las vigilancias solo se activan con la sesión abierta. IEX también da operaciones antes de la apertura y después del cierre, pero a esa hora el agente no puede operar, y la vigilancia, que se activa una sola vez, se perdería.

Al pausar, no se disparan condiciones de precio, aunque las vigilancias pueden caducar. La cola permanece para reanudar. Las propuestas autónomas son declarativas (≤, ≥, invalidaciones y caducidad); no hay `eval`, shell ni SQL generado por el modelo.

El WebSocket reconecta cada 10 segundos si falla. La sincronización HTTP aporta un fallback de último trade y reconcilia la cuenta. No existe una recuperación tick a tick de lo sucedido durante una desconexión: si una condición se cumplió y revirtió mientras el sistema estaba desconectado, puede no detectarse. Esto es un laboratorio de baja frecuencia.

## Datos de mercado y análisis

El worker descarga velas diarias consolidadas del feed `sip` de Alpaca, que cubre todo el mercado. El WebSocket de IEX solo ve su propio parqué: sirve para el precio del momento, no para medir tendencia ni volumen. La descarga se repite cada 5 minutos en su propio bucle y cubre unos 400 días naturales. Alpaca pagina las velas, y se siguen hasta 10 páginas para que no falten activos.

En el mismo bucle se descargan velas de 5 minutos de los últimos 4 días, también del feed `sip`. En esta cuenta ese feed llega con 15 minutos de retraso: a los 14 minutos de abrir aún no había ninguna vela de la sesión, y el agente creía estar viendo la del viernes. Los minutos que faltan se completan con velas del feed `iex`, que llegan al momento pero solo recogen parte del volumen; el resumen dice cuántas son de IEX. El precio del momento solo se compara con la sesión de hoy. Solo se usan las de la sesión normal, de 09:30 a 16:00 en Nueva York, y solo las del último día con sesión. De ellas salen apertura, máximo, mínimo, último precio, precio medio ponderado por volumen, cambio desde la apertura y en 30 y 60 minutos, y posición en el rango del día. Se guardan las 12 velas más recientes. Fuera de la sesión se usa el último cierre en lugar del precio del momento, que puede ser de antes de la apertura o de después del cierre.

De esas velas salen, por activo: medias de 20, 50 y 200 sesiones, distancia del precio a cada media, variación a 1, 5 y 20 sesiones, rango verdadero medio de 14 sesiones como medida de volatilidad, máximo y mínimo de 52 semanas, posición dentro de ese rango, y volumen de la última sesión completa frente a su media de 20. Se guardan también las 20 velas más recientes.

Se distingue la sesión de hoy de la última sesión completa. `today` solo existe con la bolsa abierta. `lastSession` es la última sesión terminada, con su fecha de Nueva York. Antes, con la bolsa cerrada, la vela del viernes llegaba al agente como «sesión en curso». Antes de la apertura, una vela con la fecha de hoy solo trae operaciones previas a la sesión y se descarta. A media sesión el volumen se compara con la última sesión completa, porque el acumulado de un día a medias siempre parece bajo.

Cada vela se valida antes de usarse. Se descarta la que no es coherente consigo misma, la que trae valores no numéricos o no positivos, y la que sitúa un extremo a más de la mitad de distancia de su propio cierre. El caso que motivó el filtro es real: Alpaca devolvió SPY el 2 de febrero de 2026 con un mínimo de 69 en lugar de 690, lo que dejaba el mínimo de 52 semanas sin sentido. El número de velas descartadas se guarda y se muestra, tanto en el panel como en el contexto del agente.

Los cálculos no hacen entrada ni salida: reciben las velas y devuelven números, así que se prueban directamente. El análisis se guarda con el historial, no con el estado que el worker reescribe cada dos segundos, porque cambia despacio.

No hay datos fundamentales. El agente recibe esa limitación por escrito en sus instrucciones.

## Noticias

El worker pide titulares al proveedor cada 30 minutos. Solo se guarda una noticia si menciona alguno de los activos configurados, y de sus activos solo se conservan los propios. Se descarta la que llega sin titular, sin fecha válida o sin identificador. El titular se recorta a 300 caracteres y el resumen a 600. Una noticia se olvida a las 96 horas, o antes si su activo sale de la lista. Ese plazo cubre un fin de semana largo, del cierre del jueves a la apertura del lunes.

Con la bolsa abierta, una tanda con novedades encola **un solo** evento, no uno por titular. Mirar por tandas evita que el agente se dispare con cada noticia y agote su presupuesto diario en una mañana.

Con la bolsa cerrada, las noticias se guardan pero no despiertan al agente: no puede operar, y cada tanda gastaba una llamada para decir que espera. En los 30 minutos previos a la apertura se encola un solo repaso de las noticias sin comentar, y el agente las comenta juntas. Si el worker no estaba en marcha en esa media hora, el repaso se encola al abrir. Se hace una vez por sesión. Si Alpaca no devuelve el calendario, no se sabe si la bolsa está cerrada, y las noticias despiertan al agente como con la bolsa abierta.

El texto de una noticia es de terceros. Entra en el contexto como indicio que puede estar equivocado, sesgado o desfasado, nunca como instrucción ni como hecho comprobado, y las instrucciones del agente se lo dicen así. Al componer un aviso de Telegram se escapa, porque si no un titular podría colar marcado propio del mensaje.

No hay datos fundamentales ni de resultados empresariales.

## Avisos al propietario

Un bot de Telegram escribe cuando pasa algo que merece interrumpir: una compra, una venta, una orden que se ejecuta o la rechazan, una propuesta que los límites bloquean, y cualquier problema que deje al agente pausado. Los estados intermedios de una orden no se cuentan.

Una propuesta bloqueada porque la bolsa está cerrada no se cuenta: no es un fallo que el propietario pueda arreglar, y el aviso anunciaría una compra que no ha ocurrido.

Seguir esperando se cuenta solo si el propio agente marca que hay algo nuevo, y como mucho una vez cada 4 horas. Sin ese freno el bot repetiría lo mismo varias veces por hora.

El agente escribe el texto del aviso en su propia respuesta, en un campo aparte del razonamiento técnico. No cuesta una llamada extra al modelo.

Si Telegram no está configurado no se envía nada y todo lo demás funciona igual. Si el envío falla, se registra el motivo y el laboratorio sigue: un aviso no puede impedir una decisión ni una orden.

El bot solo informa. No acepta órdenes, así que nadie puede tocar el agente desde Telegram.

El aviso de un problema enlaza al panel usando `APP_ORIGIN`. El repositorio es público y no lleva escrita la dirección de ningún servidor.

## Modelo y memoria

Los eventos en cola van antes que las revisiones vencidas: una vigilancia cumplida en la apertura no espera detrás de revisiones atrasadas. Solo se revisan las decisiones que llegaron a enviar una orden: el agente aprende de resultados reales. Las esperas y las propuestas bloqueadas quedan anotadas con el motivo por el que no se revisan. Revisar esperas gastaba llamadas y producía lecciones de prudencia que acababan frenando al agente. Se reserva el trabajo y se incrementa el contador diario antes de llamar al modelo. La llamada se realiza fuera de las transacciones de PostgreSQL, por lo que el panel puede pausar o cambiar parámetros durante una evaluación. Al terminar se revisan configuración, versión, pausa y límites; una propuesta obsoleta no se envía.

Se acepta únicamente JSON validado. El contexto incluye cartera, precios, el horario de la bolsa ya calculado, el análisis por activo, las noticias recientes, límites, vigilancias, lecciones de la versión activa y las últimas 8 decisiones. Una respuesta cortada por el límite de tokens se detecta al recibirla y se explica como tal, en lugar de fallar después como JSON mal formado. Su tamaño está acotado a 60.000 caracteres: si la memoria aprobada crece por encima, se recortan primero las lecciones más antiguas y el cuerpo de cada una, después el número de decisiones recientes, y por último las velas en crudo. Los indicadores calculados no se quitan nunca: ocupan poco y son lo que sustituye al histórico completo. El contexto indica cuántas lecciones se han omitido. No hay búsqueda vectorial ni navegación web autónoma. La fuente de una lección externa es una referencia aportada por el usuario, no una página descargada ni verificada automáticamente.

Las revisiones posteriores reciben decisión, cotizaciones disponibles, posiciones y las 20 órdenes más recientes, con el mismo tope de tamaño. No reciben las noticias que tenía la decisión.

Las lecciones entran solas en la memoria activa, sin aprobación del propietario. Solo salen de revisiones, nunca de una decisión: una decisión tiene delante titulares de terceros, y de ahí no debe nacer una regla permanente. Hay como mucho 15 lecciones activas; al pasar el tope, la más antigua pasa a retirada. Cada adopción crea una versión de memoria/instrucciones. El propietario puede aportar conocimiento, que también entra directamente, descartar cualquier lección o recuperar una versión anterior, que restaura sus lecciones activas.

El contexto de una decisión está acotado a 100.000 caracteres, unos 30.000 tokens.

Errores de evaluación se registran con su motivo concreto: el campo del esquema que no cuadra, que el modelo no respondió a tiempo, o el error del proveedor. El texto se recorta a 300 caracteres. No se guardan claves ni respuestas crudas del proveedor. El intento consume presupuesto. Un evento fallido vuelve a la cola una vez; si falla de nuevo se descarta y hace falta otra solicitud. Una revisión admite 3 intentos. Si el modelo omite si una noticia importa, se toma como que no importa, en lugar de perder la evaluación entera. Un reinicio durante una llamada puede perder su resultado, pero conserva el intento reservado.

Las transiciones de estado del worker viven en `src/agent.ts` y no hacen entrada/salida: reservar trabajo, reservar una intención, aplicar una sincronización, aplicar el mercado, guardar una decisión y guardar una revisión. `src/worker.ts` solo se ocupa de la conexión, los bucles y las llamadas HTTP. Las pruebas ejercitan las transiciones directamente, sin base de datos ni red.

## Órdenes e idempotencia

1. Guardar la decisión y una intención `pending` sin enviar nada.
2. En otra iteración comprobar estado actual, cuenta, precios, límites y mercado.
3. Marcar `submitting` y conservar hora del intento.
4. Enviar una orden limitada Paper con el UUID de decisión como `client_order_id`.
5. Guardar estado del proveedor y reconciliar en sincronizaciones posteriores.

El precio límite se envía con dos decimales, o con cuatro por debajo de un dólar, que es lo que acepta Alpaca.

Si el envío o su confirmación fallan, marcar `unknown` y pausar. La recuperación consulta por `client_order_id`. Nunca se reenvía a ciegas. Una intención ambigua bloquea las demás. Puede haber varias órdenes abiertas en Alpaca a la vez, pero nunca dos del mismo activo. El dinero de las compras abiertas cuenta como gastado para el efectivo y la exposición. Se usa advisory lock de PostgreSQL para impedir workers simultáneos.

Los límites son controles previos, no garantías de precio final o de pérdida máxima. Una venta requiere acciones suficientes; una compra debe caber en efectivo, exposición y límite por posición. El umbral de pérdida compara patrimonio actual con la primera sincronización; bloquea compras nuevas, no cierra posiciones.

## Panel

El panel tiene una pestaña Mercado con los mismos datos que recibe el agente. El estado del agente muestra si la bolsa de Nueva York está abierta y cuándo abre o cierra, en la hora del navegador. Una vigilancia enlaza con la decisión que la creó, y el detalle de una decisión lista las vigilancias y las lecciones que salieron de ella, con su estado. Una vigilancia que el agente propuso pero quedó fuera de límites aparece marcada como no guardada.

`GET /api/state` no devuelve el historial completo. Envía las 300 decisiones más recientes sin su contexto guardado, 200 eventos, 500 muestras de patrimonio y 200 registros de consumo, más un recuento total de cada uno. El panel pide el contexto de una decisión concreta a `GET /api/decisions/:id` al abrir su detalle. El panel consulta el estado cada 5 segundos, así que la respuesta no debe crecer con el historial.

Los errores que el propietario puede corregir se devuelven con código 400 y un mensaje concreto: faltan claves, orden sin reconciliar, vigilancia fuera de límites, elemento inexistente. El código 500 queda para fallos no previstos y su mensaje no revela detalles internos.

## Seguridad

Contraseña de propietario, verificación scrypt, cookie HttpOnly/SameSite Strict firmada con HMAC y expiración de 12 horas. HTTPS habilita Secure. Verificación exacta de Origin en mutaciones y límites de peticiones/intentos de login. Secretos fuera de Git y del frontend; el panel solo recibe indicadores de configuración. Cambiar SESSION_SECRET invalida sesiones existentes.

API ligada al loopback del host mediante Compose; acceso público por proxy TLS. Base de datos sin puerto publicado. Contenedores de aplicación sin root, sin capacidades Linux, con filesystem de solo lectura salvo /tmp. Cuenta Paper exclusiva: cancelar todas las órdenes puede afectar operaciones hechas manualmente en esa misma cuenta.

## Evoluciones posteriores

Histórico OHLCV y benchmarks; métricas de ejecución y costes; selección de recuerdos por relevancia; experimentos A/B con ventanas fuera de muestra; aprendizaje autónomo bajo evidencia; almacenamiento normalizado y paginado. Son siguientes pasos, no capacidades activas de esta versión.
