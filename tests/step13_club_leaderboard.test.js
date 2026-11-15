/**
 * ============================================================================
 * TESTS OBLIGATOIRES — ÉTAPE 13 :
 * Défi & Régularité d'équipe (Opt-in strict & Confidentialité absolue)
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TEST_DB_PATH = path.join(__dirname, "test_step13_club.db");
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

const { getDbClient } = require("../db/client");
const { initDatabase } = require("../db/init");
const { SESSION_COOKIE_NAME, createSessionToken, upsertLichessUser } = require("../db/auth");
const apiHandler = require("../api/index");

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
  const server = http.createServer((req, res) => apiHandler(req, res, TEST_DB_URL));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const client = getDbClient(TEST_DB_URL);
    const userA = await upsertLichessUser(client, { id: "club_alpha", username: "ClubAlpha", perfs: {} });
    const userB = await upsertLichessUser(client, { id: "club_beta", username: "ClubBeta", perfs: {} });
    const cookieA = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(userA))}`;
    const cookieB = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(userB))}`;

    console.log("Test 1 : Par défaut (share_club_stats = false), aucun joueur n'apparaît dans le classement...");
    const lbEmpty = await httpRequest(port, "GET", "/api/club/leaderboard", null, cookieB);
    assert.strictEqual(lbEmpty.status, 200);
    assert.strictEqual(lbEmpty.json.leaderboard.length, 0);
    console.log("  -> OK");

    console.log("Test 2 : Données privées de ClubAlpha + activation opt-in strict...");
    // Ajouter données privées pour ClubAlpha : adversaire, ouverture, journal, puzzle résolu
    await httpRequest(
      port,
      "POST",
      "/api/opponents",
      { name: "SecretOpponent", fide_elo: 2150, match_plan: "Attaque secrète sur h7" },
      cookieA
    );
    await httpRequest(
      port,
      "POST",
      "/api/openings",
      { side: "Blancs", name: "Prépa Secrète Najdorf", moves: "1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4" },
      cookieA
    );
    await httpRequest(
      port,
      "POST",
      "/api/journal",
      { note: "Note mentale confidentielle avant championnat" },
      cookieA
    );
    await httpRequest(
      port,
      "POST",
      "/api/puzzles/solve",
      { id: 1, success: true, time_sec: 10, explicit_rating: 3 },
      cookieA
    );
    await httpRequest(port, "POST", "/api/settings", { share_club_stats: "true" }, cookieA);

    const lbAfter = await httpRequest(port, "GET", "/api/club/leaderboard", null, cookieB);
    assert.strictEqual(lbAfter.status, 200);
    assert.strictEqual(lbAfter.json.leaderboard.length, 1, "Seul ClubAlpha (opt-in) doit apparaître");
    const entry = lbAfter.json.leaderboard[0];
    assert.deepStrictEqual(Object.keys(entry).sort(), ["streak", "username", "weekly_puzzles"]);
    assert.strictEqual(entry.username, "ClubAlpha");
    assert.strictEqual(entry.weekly_puzzles, 1);

    // Vérifier qu'aucune donnée privée ne fuite dans la réponse brute JSON
    assert(!lbAfter.body.includes("SecretOpponent"));
    assert(!lbAfter.body.includes("Najdorf"));
    assert(!lbAfter.body.includes("confidentielle"));
    assert(!lbAfter.body.includes("ClubBeta"));
    console.log("  -> OK");

    console.log("Test 3 : Désactivation du partage retire immédiatement ClubAlpha...");
    await httpRequest(port, "POST", "/api/settings", { share_club_stats: "false" }, cookieA);
    const lbOff = await httpRequest(port, "GET", "/api/club/leaderboard", null, cookieB);
    assert.strictEqual(lbOff.json.leaderboard.length, 0);
    console.log("  -> OK");

    console.log("\nTOUS LES TESTS ÉTAPE 13 ONT RÉUSSI !");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTestDb();
  }
}

runTests().catch((err) => {
  console.error("ECHEC TEST ÉTAPE 13:", err);
  process.exit(1);
});
