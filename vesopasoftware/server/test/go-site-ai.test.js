/* Vesopa AI for go.vesopa.com: only that origin gets through CORS, and its
 * grounding gives only links and pictures the dock will show.
 *
 *     node --test server/test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import aiRoutes from "../routes/ai.js";
import { GO_ORIGIN, GO_SYSTEM } from "../lib/go_site_ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use("/api", aiRoutes);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("go.vesopa.com may call the assistant from its own origin", async () => {
  await withServer(async (base) => {
    const pre = await fetch(`${base}/api/ai`, {
      method: "OPTIONS",
      headers: { Origin: GO_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), GO_ORIGIN);
    assert.match(pre.headers.get("access-control-allow-headers"), /Content-Type/i);
    assert.equal(pre.headers.get("access-control-allow-credentials"), null, "no cookies cross-site");

    const status = await fetch(`${base}/api/ai/status`, { headers: { Origin: GO_ORIGIN } });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("access-control-allow-origin"), GO_ORIGIN);
  });
});

test("any other origin gets no CORS answer", async () => {
  await withServer(async (base) => {
    for (const origin of ["https://evil.example", "https://go.vesopa.com.evil.example", "http://go.vesopa.com"]) {
      const r = await fetch(`${base}/api/ai/status`, { headers: { Origin: origin } });
      assert.equal(r.headers.get("access-control-allow-origin"), null, origin);
    }
  });
});

test("the Go grounding gives only links and pictures the go.vesopa.com dock lets through", () => {
  const dock = fs.readFileSync(path.join(here, "../../../vesopa_go/web/site/js/ask.js"), "utf8");
  const safe = (name) => new RegExp(dock.match(new RegExp(`const ${name} = /(.+)/([a-z]*);`)).slice(1, 3)[0], dock.match(new RegExp(`const ${name} = /(.+)/([a-z]*);`))[2]);
  const SAFE_LINK = safe("SAFE_LINK"), SAFE_IMAGE = safe("SAFE_IMAGE");
  const urls = GO_SYSTEM.match(/https:\/\/[^\s,)]+[^\s,).]/g);
  assert.ok(urls.length > 10);
  for (const u of urls) assert.ok(SAFE_LINK.test(u), `link the dock would drop: ${u}`);
  const pics = GO_SYSTEM.match(/\/img\/shots\/[a-z0-9-]+\.webp/g);
  assert.ok(pics.length >= 5);
  for (const p of pics) {
    assert.ok(SAFE_IMAGE.test(p), `picture the dock would drop: ${p}`);
    assert.ok(fs.existsSync(path.join(here, "../../../vesopa_go/web/site", p)), `no such picture: ${p}`);
  }
  assert.match(GO_SYSTEM, /£29 a month/);
  assert.match(GO_SYSTEM, />> First question\? \| Second question\? \| Third question\?/);
});
