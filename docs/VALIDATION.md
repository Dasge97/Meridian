# Validación de la entrega inicial

## Comprobaciones ejecutadas en el entorno de desarrollo

- Compilación TypeScript estricta y generación de frontend de producción con Vite.
- Pruebas de límites de órdenes: efectivo, posiciones, exposición, pérdida, pausa, activos y datos caducados/no válidos.
- Pruebas de vigilancias: activación única, invalidación prioritaria, caducidad y tiempos inválidos/futuros.
- Pruebas HTTP por inyección Fastify: login, cookie firmada, acceso no autenticado, Origin/CSRF, validación y archivos estáticos.
- Pruebas de adaptadores con respuestas controladas: destino fijo Paper, errores HTTP y salida JSON del agente con memoria aprobada.
- Auditoría npm de dependencias de producción: sin vulnerabilidades detectadas en la comprobación de esta entrega.

## Comprobaciones automatizadas en GitHub

El workflow CI ejecuta las pruebas anteriores y añade PostgreSQL real para verificar migración, persistencia, aprobaciones, recuperación de versiones y escrituras concurrentes. También construye la imagen Docker. El resultado de la ejecución aparece en la pestaña Actions; no confundir que una comprobación esté definida con que haya pasado.

## No validado aquí

Este entorno no dispone de Docker ni de un navegador Chromium instalado. La prueba PostgreSQL se omite localmente sin TEST_DATABASE_URL y queda cubierta por el servicio PostgreSQL del workflow. No se afirma validación visual con navegador ni ejecución local de la imagen Docker.

No se han usado claves privadas de Alpaca ni de un proveedor de modelos, por lo que no se ha enviado ninguna orden, consultado una cuenta real ni gastado tokens de esos proveedores. La aceptación con la cuenta Paper, su feed IEX y el modelo elegido debe hacerse al configurar el servidor según el README. La rentabilidad y la calidad del aprendizaje no están demostradas.
