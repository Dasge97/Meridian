import { test } from "node:test";
import assert from "node:assert/strict";
test("HTTP security: login, signed cookies, route protection, Origin and static assets", async () => {
  process.env.MERIDIAN_TEST = "true";
  process.env.ADMIN_PASSWORD = "only-for-test-password-123456";
  process.env.SESSION_SECRET = "only-for-test-session-secret-1234567890123456";
  process.env.APP_ORIGIN = "http://localhost:3000";
  const { app } = await import("../src/server.ts");
  const { pool } = await import("../src/db.ts");
  try {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/state" })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/market" })).statusCode,
      401,
      "las velas completas piden sesión igual que el estado",
    );
    for (const url of [
      "/api/decisions",
      "/api/decisions?page=2&kind=buy",
      "/api/events",
      "/api/events?q=orden",
      "/api/usage",
      "/api/usage?kind=review&trigger=unknown",
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
          url: "/api/wake",
          headers: { ...headers, origin: "https://attacker.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/state",
          headers: { cookie: `meridian=${c.value.slice(0, -1)}x` },
        })
      ).statusCode,
      401,
    );
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
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          headers,
          payload: {
            symbols: ["SPY"],
            maxOrderUsd: 600,
            maxPositionUsd: 1200,
            maxExposureUsd: 2000,
            maxDailyOrders: 5,
            maxDailyCalls: 20,
            maxDrawdownPct: 10,
            cooldownSeconds: 300,
            riskProfile: "temerario",
          },
        })
      ).statusCode,
      400,
    );
    // Los parámetros se validan antes de leer la base de datos.
    for (const [url, message] of [
      ["/api/decisions?size=101", /tamaño de página/],
      ["/api/decisions?kind=todas", /tipo/],
      ["/api/events?from=ayer", /fecha de inicio/],
      ["/api/usage?size=0", /tamaño de página/],
      ["/api/usage?kind=wait", /El tipo tiene que ser uno de estos/],
      ["/api/usage?trigger=vigilancia", /El origen tiene que ser uno de estos/],
      [
        "/api/usage?from=2026-09-15T00:00:00Z&to=2026-09-14T00:00:00Z",
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
      url: "/api/wake",
      headers: { ...headers, "content-type": "application/json" },
      payload: "",
    });
    assert.equal(malformed.statusCode, 400);
  } finally {
    await app.close();
    await pool.end();
  }
});
