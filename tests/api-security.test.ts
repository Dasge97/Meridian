import { test } from "node:test";
import assert from "node:assert/strict";
test("HTTP security: login, signed cookies, route protection, Origin and static assets", async () => {
  process.env.MERIDIAN_TEST = "true";
  process.env.ADMIN_PASSWORD = "only-for-test-password-123456";
  process.env.SESSION_SECRET = "only-for-test-session-secret-1234567890123456";
  process.env.APP_ORIGIN = "http://localhost:3000";
  const { app, RETIRED_ROUTES } = await import("../src/server.ts");
  const { pool } = await import("../src/db.ts");
  // Todas las rutas de una simulación, con un id cualquiera donde haga falta.
  const u = crypto.randomUUID();
  const SIM_ROUTES = [
    ["GET", "/state"],
    ["GET", "/decisions"],
    ["GET", `/decisions/${u}`],
    ["GET", "/events"],
    ["GET", "/usage"],
    ["POST", "/pause"],
    ["POST", "/wake"],
    ["PUT", "/risk"],
    ["POST", "/watches"],
    ["POST", `/watches/${u}/cancel`],
    ["POST", "/lessons"],
    ["POST", `/lessons/${u}/status`],
    ["POST", "/versions"],
    ["POST", `/versions/${u}/activate`],
    ["POST", `/orders/${u}/reconcile`],
    ["POST", `/orders/${u}/confirm-absent`],
    ["POST", "/orders/cancel-open"],
  ] as const;
  try {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/sims/alpaca/state" }))
        .statusCode,
      401,
    );
    // Las dos simulaciones piden lo mismo.
    for (const [method, path] of ["alpaca", "internal"].flatMap((sim) =>
      SIM_ROUTES.map(([m, p]) => [m, `/${sim}${p}`] as const),
    )) {
      const url = "/api/sims" + path;
      assert.equal(
        (
          await app.inject({
            method,
            url,
            headers: { origin: process.env.APP_ORIGIN },
          })
        ).statusCode,
        401,
        `${method} ${url} pide sesión`,
      );
      if (method !== "GET")
        assert.equal(
          (
            await app.inject({
              method,
              url,
              headers: { origin: "https://attacker.example" },
            })
          ).statusCode,
          403,
          `${method} ${url} comprueba el origen`,
        );
    }
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/market" })).statusCode,
      401,
      "las velas completas piden sesión igual que el estado",
    );
    for (const url of [
      "/api/sims/alpaca/decisions",
      "/api/sims/alpaca/decisions?page=2&kind=buy",
      "/api/sims/alpaca/events",
      "/api/sims/alpaca/events?q=orden",
      "/api/sims/alpaca/usage",
      "/api/sims/alpaca/usage?kind=review&trigger=unknown",
      "/api/state",
      "/api/sims/otra/state",
      "/api/compare",
      "/api/compare?from=ayer",
    ])
      assert.equal(
        (await app.inject({ method: "GET", url })).statusCode,
        401,
        `${url} pide sesión igual que el estado`,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          payload: { password: process.env.ADMIN_PASSWORD },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          headers: { origin: process.env.APP_ORIGIN },
          payload: { password: "wrong" },
        })
      ).statusCode,
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin: process.env.APP_ORIGIN },
      payload: { password: process.env.ADMIN_PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    const c = login.cookies[0];
    assert.equal(c.httpOnly, true);
    assert.equal(c.sameSite, "Strict");
    const headers = {
      origin: process.env.APP_ORIGIN!,
      cookie: `${c.name}=${c.value}`,
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/sims/alpaca/wake",
          headers: { ...headers, origin: "https://attacker.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/sims/alpaca/state",
          headers: { cookie: `meridian=${c.value.slice(0, -1)}x` },
        })
      ).statusCode,
      401,
    );
    // Una simulación que no existe no llega a leer la base de datos.
    for (const [method, path] of SIM_ROUTES) {
      const r = await app.inject({
        method,
        url: "/api/sims/otra" + path,
        headers,
      });
      assert.equal(r.statusCode, 404, `${method} /api/sims/otra${path}`);
      assert.match(r.json().error, /simulación no existe/);
    }
    // Una pestaña abierta con el panel de antes no actúa sobre ninguna simulación.
    for (const [method, route] of RETIRED_ROUTES) {
      const url = route.replace(":id", u);
      const r = await app.inject({ method, url, headers });
      assert.equal(r.statusCode, 410, `${method} ${url}`);
      assert.equal(
        r.json().error,
        "El panel se ha actualizado: recarga la página",
      );
    }
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          headers,
          payload: { maxOrderUsd: -1 },
        })
      ).statusCode,
      400,
    );
    // Un nivel de riesgo que no existe se rechaza antes de leer la base de datos.
    for (const payload of [{ riskProfile: "temerario" }, {}])
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: "/api/sims/alpaca/risk",
            headers,
            payload,
          })
        ).statusCode,
        400,
      );
    // Los parámetros se validan antes de leer la base de datos.
    for (const [url, message] of [
      ["/api/sims/alpaca/decisions?size=101", /tamaño de página/],
      ["/api/sims/alpaca/decisions?kind=todas", /tipo/],
      ["/api/sims/alpaca/events?from=ayer", /fecha de inicio/],
      ["/api/sims/alpaca/usage?size=0", /tamaño de página/],
      ["/api/compare?from=ayer", /La fecha de inicio tiene que ser/],
      ["/api/compare?from=2026-09-15", /fecha ISO con hora y zona/],
      [
        "/api/sims/alpaca/usage?kind=wait",
        /El tipo tiene que ser uno de estos/,
      ],
      [
        "/api/sims/alpaca/usage?trigger=vigilancia",
        /El origen tiene que ser uno de estos/,
      ],
      [
        "/api/sims/alpaca/usage?from=2026-09-15T00:00:00Z&to=2026-09-14T00:00:00Z",
        /posterior/,
      ],
    ] as const) {
      const r = await app.inject({ method: "GET", url, headers });
      assert.equal(r.statusCode, 400, url);
      assert.match(r.json().error, message);
    }
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Meridian/);
    assert.ok(page.headers["content-security-policy"]);
    assert.equal(
      (await app.inject({ method: "GET", url: "/.env" })).body.includes(
        "SESSION_SECRET",
      ),
      false,
    );
    const logout = await app.inject({
      method: "POST",
      url: "/api/logout",
      headers,
    });
    assert.equal(logout.statusCode, 200);
    let limited = 0;
    for (let i = 0; i < 8 && !limited; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { origin: process.env.APP_ORIGIN! },
        payload: { password: "wrong" },
      });
      if (r.statusCode !== 401) limited = r.statusCode;
    }
    assert.equal(limited, 429, "el límite de intentos debe decir 429, no 500");
    const malformed = await app.inject({
      method: "POST",
      url: "/api/sims/alpaca/wake",
      headers: { ...headers, "content-type": "application/json" },
      payload: "",
    });
    assert.equal(malformed.statusCode, 400);
  } finally {
    await app.close();
    await pool.end();
  }
});
