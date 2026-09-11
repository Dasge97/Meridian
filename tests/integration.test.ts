import { test } from "node:test";
import assert from "node:assert/strict";
const url = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL + API: auth, CSRF, persistence, versions and concurrent updates",
  { skip: !url },
  async () => {
    if (!url || !new URL(url).pathname.endsWith("_test"))
      throw new Error("Use an isolated database ending in _test");
    process.env.DATABASE_URL = url;
    process.env.MERIDIAN_TEST = "true";
    process.env.ADMIN_PASSWORD = "test-password-only-987654321";
    process.env.SESSION_SECRET = "test-session-secret-only-987654321-123456";
    process.env.APP_ORIGIN = "http://localhost:3000";
    const { migrate, pool, change, read } = await import("../src/db.ts");
    const { initialState, enqueue } = await import("../src/domain.ts");
    await migrate();
    await pool.query("UPDATE meridian_state SET data=$1 WHERE id=1", [
      JSON.stringify(initialState()),
    ]);
    const { app } = await import("../src/server.ts");
    try {
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/state" })).statusCode,
        401,
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
            payload: { password: "bad" },
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
      const cookie = login.cookies[0];
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.sameSite, "Strict");
      const headers = {
        origin: process.env.APP_ORIGIN!,
        cookie: `${cookie.name}=${cookie.value}`,
      };
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/state", headers }))
          .statusCode,
        200,
      );
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
            method: "PUT",
            url: "/api/settings",
            headers,
            payload: { maxOrderUsd: -1 },
          })
        ).statusCode,
        400,
      );
      await app.inject({
        method: "POST",
        url: "/api/lessons",
        headers,
        payload: {
          title: "Una hipótesis de prueba",
          body: "Una ganancia aislada no valida una estrategia.",
          source: "Caso de prueba documentado",
        },
      });
      let state = await read();
      const lesson = state.lessons[0];
      const previous = state.activeVersion;
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/lessons/${lesson.id}/status`,
            headers,
            payload: { status: "accepted" },
          })
        ).statusCode,
        200,
      );
      state = await read();
      assert.notEqual(state.activeVersion, previous);
      assert.ok(state.versions.at(-1)!.lessonIds.includes(lesson.id));
      await app.inject({
        method: "POST",
        url: `/api/versions/${previous}/activate`,
        headers,
      });
      assert.equal((await read()).activeVersion, previous);
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/watches",
            headers,
            payload: {
              symbol: "AAPL",
              operator: "lte",
              price: 190,
              expiresAt,
              reason: "Prueba persistente",
            },
          })
        ).statusCode,
        200,
      );
      assert.equal((await read()).watches.length, 1);
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          change((s) => enqueue(s, `Concurrent ${i}`)),
        ),
      );
      assert.equal((await read()).queue.length, 10);
      const page = await app.inject({ method: "GET", url: "/" });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /Meridian/);
      assert.ok(page.headers["content-security-policy"]);
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
