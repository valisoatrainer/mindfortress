/**
 * ============================================================================
 * TESTS OBLIGATOIRES — ÉTAPE 9 :
 * Application installable sur téléphone (PWA) tout en conservant la version web
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TEST_DB_PATH = path.join(__dirname, "test_step9_pwa.db");
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

const { initDatabase } = require("../db/init");
const { createAppServer } = require("../server");

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + suffix;
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (_e) {}
    }
  }
}

function httpGetRaw(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method: "GET",
        headers: { Connection: "close" }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buffer: buf,
            text: buf.toString("utf8")
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function runTests() {
  cleanupTestDb();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;

  await initDatabase(TEST_DB_URL);
  const server = createAppServer(TEST_DB_URL);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    console.log("Test 1 : GET /manifest.json (HTTP 200, JSON valide, display standalone)...");
    const manRes = await httpGetRaw(port, "/manifest.json");
    assert.strictEqual(manRes.status, 200);
    assert(String(manRes.headers["content-type"] || "").includes("application/json"));
    const manifest = JSON.parse(manRes.text);
    assert.strictEqual(manifest.display, "standalone");
    assert.strictEqual(manifest.start_url, "/");
    assert(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
    console.log("  -> OK");

    console.log("Test 2 : Icônes PWA (/img/icon-192.png, /img/icon-512.png, /img/icon.svg)...");
    const png192 = await httpGetRaw(port, "/img/icon-192.png");
    assert.strictEqual(png192.status, 200);
    assert(String(png192.headers["content-type"] || "").includes("image/png"));
    assert.strictEqual(png192.buffer[0], 0x89);
    assert.strictEqual(png192.buffer[1], 0x50);
    assert.strictEqual(png192.buffer[2], 0x4e);
    assert.strictEqual(png192.buffer[3], 0x47);

    const png512 = await httpGetRaw(port, "/img/icon-512.png");
    assert.strictEqual(png512.status, 200);
    assert(String(png512.headers["content-type"] || "").includes("image/png"));

    const svgIcon = await httpGetRaw(port, "/img/icon.svg");
    assert.strictEqual(svgIcon.status, 200);
    assert(String(svgIcon.headers["content-type"] || "").includes("image/svg+xml"));
    console.log("  -> OK");

    console.log("Test 3 : GET /sw.js (HTTP 200, JS, exclusion stricte de /api)...");
    const swRes = await httpGetRaw(port, "/sw.js");
    assert.strictEqual(swRes.status, 200);
    assert(String(swRes.headers["content-type"] || "").includes("javascript"));
    assert(swRes.text.includes('startsWith("/api")'), "sw.js doit exclure /api");
    assert(swRes.text.includes('req.method !== "GET"'), "sw.js doit ignorer les requêtes non-GET");
    console.log("  -> OK");

    console.log("Test 4 : index.html inclut manifest, balises Apple & enregistrement SW (version web préservée)...");
    const htmlRes = await httpGetRaw(port, "/");
    assert.strictEqual(htmlRes.status, 200);
    assert(htmlRes.text.includes('<link rel="manifest" href="/manifest.json">'));
    assert(htmlRes.text.includes('<meta name="apple-mobile-web-app-capable" content="yes">'));
    assert(htmlRes.text.includes('serviceWorker.register("/sw.js")'));
    console.log("  -> OK");

    console.log("Test 5 : Sécurité /api/state toujours verrouillée à 401 AUTH_REQUIRED...");
    const apiRes = await httpGetRaw(port, "/api/state");
    assert.strictEqual(apiRes.status, 401);
    const apiJson = JSON.parse(apiRes.text);
    assert.strictEqual(apiJson.code, "AUTH_REQUIRED");
    console.log("  -> OK");

    console.log("\nTOUS LES TESTS ÉTAPE 9 ONT RÉUSSI !");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTestDb();
  }
}

runTests().catch((err) => {
  console.error("ECHEC TEST ÉTAPE 9:", err);
  process.exit(1);
});
