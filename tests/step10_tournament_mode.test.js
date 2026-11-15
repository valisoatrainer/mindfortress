/**
 * ============================================================================
 * TESTS OBLIGATOIRES — ÉTAPE 10 :
 * Mode « Jour de Ronde » (Routine Pré-Ronde & Débriefing Post-Ronde)
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TEST_DB_PATH = path.join(__dirname, "test_step10_rounds.db");
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
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
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
    const userA = await upsertLichessUser(client, { id: "alpha_round", username: "AlphaRound", perfs: {} });
    const userB = await upsertLichessUser(client, { id: "beta_round", username: "BetaRound", perfs: {} });

    const cookieA = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(userA))}`;
    const cookieB = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(userB))}`;

    console.log("Test 1 : Échauffement pré-ronde vide si aucun puzzle maîtrisé (fsrs_state >= 2)...");
    const warmupEmpty = await httpRequest(port, "GET", "/api/rounds/warmup", null, cookieA);
    assert.strictEqual(warmupEmpty.status, 200);
    assert.strictEqual(warmupEmpty.json.warmup.length, 0);
    console.log("  -> OK");

    console.log("Test 2 : Échauffement pré-ronde ne retourne que les puzzles maîtrisés de l'utilisateur...");
    // Résoudre le puzzle 1 avec note Easy (4) -> passe en fsrs_state = 2 (Review / maîtrisé)
    const solveRes = await httpRequest(
      port,
      "POST",
      "/api/puzzles/solve",
      { id: 1, success: true, time_sec: 8, explicit_rating: 4 },
      cookieA
    );
    assert.strictEqual(solveRes.status, 200);

    const warmupA = await httpRequest(port, "GET", "/api/rounds/warmup", null, cookieA);
    assert.strictEqual(warmupA.status, 200);
    assert.strictEqual(warmupA.json.warmup.length, 1);
    assert.strictEqual(Number(warmupA.json.warmup[0].id), 1);
    assert(Number(warmupA.json.warmup[0].fsrs_state) >= 2);

    const warmupB = await httpRequest(port, "GET", "/api/rounds/warmup", null, cookieB);
    assert.strictEqual(warmupB.json.warmup.length, 0, "User B ne doit pas hériter des puzzles maîtrisés de User A");
    console.log("  -> OK");

    console.log("Test 3 : CRUD POST /api/rounds, GET /api/state, DELETE /api/rounds + isolation user_id...");
    const createRes = await httpRequest(
      port,
      "POST",
      "/api/rounds",
      {
        tournament_name: "Open FIDE Antananarivo",
        round_number: 3,
        opponent_name: "GM Rakoto",
        side: "Noirs",
        result: "1/2",
        had_zeitnot: true,
        critical_moment: "34...Td8 rate 34...Te5+",
        emotion: "Focus",
        lesson: "Garder 10 min pour les coups 30-40.",
        save_to_journal: true
      },
      cookieA
    );
    assert.strictEqual(createRes.status, 200);
    assert.strictEqual(createRes.json.rounds.length, 1);
    const createdRound = createRes.json.rounds[0];
    assert.strictEqual(createdRound.opponent_name, "GM Rakoto");
    assert.strictEqual(Number(createdRound.had_zeitnot), 1);
    assert(
      createRes.json.contextualJournal.some((j) => String(j.linked_text || "").includes("Ronde #3 vs GM Rakoto")),
      "La ronde doit être liée au Journal Contextuel"
    );

    // Isolation : User B ne voit pas la ronde de User A et ne peut pas la supprimer
    const stateB = await httpRequest(port, "GET", "/api/state", null, cookieB);
    assert.strictEqual(stateB.json.rounds.length, 0);
    await httpRequest(port, "DELETE", `/api/rounds?id=${createdRound.id}`, null, cookieB);
    const stateAAfterBDelete = await httpRequest(port, "GET", "/api/state", null, cookieA);
    assert.strictEqual(stateAAfterBDelete.json.rounds.length, 1, "User B ne doit pas pouvoir supprimer la ronde de User A");

    // Suppression par User A
    const delResA = await httpRequest(port, "DELETE", `/api/rounds?id=${createdRound.id}`, null, cookieA);
    assert.strictEqual(delResA.status, 200);
    assert.strictEqual(delResA.json.rounds.length, 0);
    console.log("  -> OK");

    console.log("\nTOUS LES TESTS ÉTAPE 10 ONT RÉUSSI !");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTestDb();
  }
}

runTests().catch((err) => {
  console.error("ECHEC TEST ÉTAPE 10:", err);
  process.exit(1);
});
