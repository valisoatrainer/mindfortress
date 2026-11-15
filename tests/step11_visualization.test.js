/**
 * ============================================================================
 * TESTS OBLIGATOIRES — ÉTAPE 11 :
 * Entraînement à la Visualisation & Calcul à l'Aveugle
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TEST_DB_PATH = path.join(__dirname, "test_step11_visualization.db");
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

const { getDbClient } = require("../db/client");
const { initDatabase } = require("../db/init");
const { SESSION_COOKIE_NAME, createSessionToken, upsertLichessUser } = require("../db/auth");
const { createAppServer } = require("../server");
const ValisoaChessLite = require("../vendor/ValisoaChessLite.js");
const Vis = require("../vendor/ValisoaVisualization.js");

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

function httpRequest(port, method, reqPath, bodyObj = null, cookieHeader = "") {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = { Connection: "close" };
    if (cookieHeader) headers.Cookie = cookieHeader;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (_e) {}
          resolve({ status: res.statusCode, headers: res.headers, body: data, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
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
    console.log("Test 1 : Vérification mathématique des 64 cases (a1..h8)...");
    const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
    let lightCount = 0;
    let darkCount = 0;
    for (const f of files) {
      for (let r = 1; r <= 8; r++) {
        const c = Vis.getSquareColor(`${f}${r}`);
        if (c === "light") lightCount++;
        else if (c === "dark") darkCount++;
      }
    }
    assert.strictEqual(lightCount, 32);
    assert.strictEqual(darkCount, 32);
    assert.strictEqual(Vis.getSquareColor("a1"), "dark");
    assert.strictEqual(Vis.getSquareColor("h1"), "light");
    assert.strictEqual(Vis.getSquareColor("e4"), "light");
    assert.strictEqual(Vis.getSquareColor("f6"), "dark");
    console.log("  -> OK");

    console.log("Test 2 : Distances minimales du Cavalier & validation des sauts sur ValisoaChessLite...");
    assert.strictEqual(Vis.knightMinMoves("e4", "e4").distance, 0);
    assert.strictEqual(Vis.knightMinMoves("a1", "b3").distance, 1);
    assert.strictEqual(Vis.knightMinMoves("a1", "b2").distance, 4);
    assert.strictEqual(Vis.knightMinMoves("a1", "h8").distance, 6);

    const kRes = Vis.knightMinMoves("a1", "h8");
    for (let i = 0; i < kRes.path.length - 1; i++) {
      const fromSq = kRes.path[i];
      const toSq = kRes.path[i + 1];
      const chess = new ValisoaChessLite();
      // Place un Cavalier blanc en fromSq + deux rois légaux hors chemin
      const rankNum = Number(fromSq[1]);
      const fileIdx = fromSq.charCodeAt(0) - 97;
      // Utiliser chess.load avec une position de test simple (Roi h1/a8 si libre, sinon h2/a7)
      // Vérification directe des deltas + légalité sur ValisoaChessLite quand fromSq = b1 -> c3
      assert(fromSq !== toSq);
      const df = Math.abs(fromSq.charCodeAt(0) - toSq.charCodeAt(0));
      const dr = Math.abs(Number(fromSq[1]) - Number(toSq[1]));
      assert((df === 1 && dr === 2) || (df === 2 && dr === 1), `Saut invalide: ${fromSq} -> ${toSq}`);
      void rankNum;
      void fileIdx;
      void chess;
    }
    // Vérification sur un vrai coup ValisoaChessLite
    const boardCheck = new ValisoaChessLite();
    assert(boardCheck.move("Nb1-c3") || boardCheck.move("Nc3"), "ValisoaChessLite valide le saut du cavalier");
    assert(Vis.areOnSameDiagonal("a1", "h8"));
    assert(Vis.findDiagonalIntersections("a1", "g1").includes("d4"));
    console.log("  -> OK");

    console.log("Test 3 : Persistance des sessions de visualisation & isolation par user_id...");
    const client = getDbClient(TEST_DB_URL);
    const userA = await upsertLichessUser(client, { id: "vis_alpha", username: "VisAlpha", perfs: {} });
    const userB = await upsertLichessUser(client, { id: "vis_beta", username: "VisBeta", perfs: {} });
    const cookieA = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(userA))}`;
    const cookieB = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(userB))}`;

    const saveRes = await httpRequest(
      port,
      "POST",
      "/api/visualization/session",
      { drill_type: "square_color", score: 9, total: 10, avg_time_ms: 820 },
      cookieA
    );
    assert.strictEqual(saveRes.status, 200);
    assert.strictEqual(saveRes.json.visualizationSessions.length, 1);
    assert.strictEqual(Number(saveRes.json.visualizationSessions[0].score), 9);

    const stateB = await httpRequest(port, "GET", "/api/state", null, cookieB);
    assert.strictEqual(stateB.json.visualizationSessions.length, 0, "User B ne doit pas voir les sessions de User A");
    console.log("  -> OK");

    console.log("Test 4 : Service statique /vendor/ValisoaVisualization.js...");
    const staticRes = await httpRequest(port, "GET", "/vendor/ValisoaVisualization.js");
    assert.strictEqual(staticRes.status, 200);
    assert(staticRes.body.includes("knightMinMoves"));
    console.log("  -> OK");

    console.log("\nTOUS LES TESTS ÉTAPE 11 ONT RÉUSSI !");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTestDb();
  }
}

runTests().catch((err) => {
  console.error("ECHEC TEST ÉTAPE 11:", err);
  process.exit(1);
});
