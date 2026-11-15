/**
 * ============================================================================
 * TESTS OBLIGATOIRES — ÉTAPE 14 :
 * Flux Tactique Lichess intégré (API puzzle:read / puzzle:write + Woodpecker)
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TEST_DB_PATH = path.join(__dirname, "test_step14_lichess_stream.db");
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

const { getDbClient } = require("../db/client");
const { initDatabase } = require("../db/init");
const {
  SESSION_COOKIE_NAME,
  createSessionToken,
  upsertLichessUser,
  saveUserLichessToken,
  getUserLichessToken
} = require("../db/auth");
const { convertLichessPuzzle } = require("../db/lichessPuzzles");
const ValisoaChessLite = require("../vendor/ValisoaChessLite.js");
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

const SAMPLE_LICHESS_PAYLOAD = {
  game: {
    id: "abcd1234",
    pgn: "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 Bc5 Nxf7"
  },
  puzzle: {
    id: "Tst14",
    rating: 1780,
    plays: 1200,
    initialPly: 7, // Bc5 (Noirs viennent de jouer Bc5, Blancs jouent Nxf7)
    solution: ["g5f7", "d8e7", "f7h8"],
    themes: ["fork", "short"]
  }
};

async function runTests() {
  cleanupTestDb();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.DATABASE_URL = TEST_DB_URL;

  await initDatabase(TEST_DB_URL);

  const server = http.createServer((req, res) => apiHandler(req, res, TEST_DB_URL));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const realFetch = global.fetch;

  try {
    console.log("Test 1 : Scopes OAuth puzzle:read & puzzle:write dans /api/auth/lichess/login...");
    const loginRes = await httpRequest(port, "GET", "/api/auth/lichess/login");
    assert.strictEqual(loginRes.status, 302);
    const location = String(loginRes.headers.location || "");
    const authUrl = new URL(location);
    const scopes = String(authUrl.searchParams.get("scope") || "").split(/\s+/);
    assert(scopes.includes("preference:read"), "Scope preference:read requis");
    assert(scopes.includes("puzzle:read"), "Scope puzzle:read requis");
    assert(scopes.includes("puzzle:write"), "Scope puzzle:write requis");
    console.log("  -> OK");

    console.log("Test 2 : Parsing Lichess puzzle (game.pgn + initialPly + solution UCI) & légalité ValisoaChessLite...");
    const parsed = convertLichessPuzzle(SAMPLE_LICHESS_PAYLOAD);
    assert.strictEqual(parsed.lichessId, "Tst14");
    assert.strictEqual(parsed.side, "Blancs");
    assert.strictEqual(parsed.theme, "fork");
    assert.deepStrictEqual(parsed.solution_moves, ["Nxf7", "Qe7", "Nxh8"]);
    const chess = new ValisoaChessLite();
    assert(chess.load(parsed.fen), "FEN généré doit être valide");
    for (const san of parsed.solution_moves) {
      const m = chess.move(san);
      assert(m, `Coup solution doit être légal: ${san}`);
    }
    console.log("  -> OK");

    console.log("Test 3 : Stockage chiffré du jeton Lichess par user_id...");
    const client = getDbClient(TEST_DB_URL);
    const userA = await upsertLichessUser(client, { id: "player_alpha", username: "PlayerAlpha", perfs: { puzzle: { rating: 1850 } } });
    const userB = await upsertLichessUser(client, { id: "player_beta", username: "PlayerBeta", perfs: { puzzle: { rating: 1400 } } });
    await saveUserLichessToken(client, userA.id, "lip_secret_token_alpha");
    const rawRow = await client.execute({
      sql: "SELECT value FROM user_settings WHERE user_id = ? AND key = 'lichess_oauth_token_enc'",
      args: [userA.id]
    });
    assert(!rawRow.rows[0].value.includes("lip_secret_token_alpha"), "Le jeton doit être chiffré en base");
    const decrypted = await getUserLichessToken(client, userA.id);
    assert.strictEqual(decrypted, "lip_secret_token_alpha");
    console.log("  -> OK");

    const cookieA = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(userA))}`;
    const cookieB = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(userB))}`;

    console.log("Test 4 : GET /api/lichess/puzzle/next (sans insertion automatique en base)...");
    const beforeCountRes = await client.execute({ sql: "SELECT COUNT(*) AS cnt FROM puzzles", args: [] });
    const beforeCount = Number(beforeCountRes.rows[0].cnt);

    let capturedAuthHeader = "";
    let capturedCompleteUrl = "";
    let capturedCompleteBody = null;

    global.fetch = async (url, opts = {}) => {
      const urlStr = String(url);
      if (urlStr.startsWith("https://lichess.org/api/puzzle/next")) {
        capturedAuthHeader = opts.headers?.Authorization || "";
        return {
          ok: true,
          status: 200,
          json: async () => SAMPLE_LICHESS_PAYLOAD
        };
      }
      if (urlStr.startsWith("https://lichess.org/api/puzzle/batch/")) {
        capturedCompleteUrl = urlStr;
        capturedCompleteBody = JSON.parse(opts.body || "{}");
        return {
          ok: true,
          status: 200,
          json: async () => ({ puzzles: [] })
        };
      }
      return realFetch(url, opts);
    };

    const nextRes = await httpRequest(port, "GET", "/api/lichess/puzzle/next?angle=fork&difficulty=normal", null, cookieA);
    assert.strictEqual(nextRes.status, 200, `Attendu 200, reçu ${nextRes.status}: ${JSON.stringify(nextRes.json)}`);
    assert.strictEqual(nextRes.json.ok, true);
    assert.strictEqual(nextRes.json.has_puzzle_scope, true);
    assert.strictEqual(nextRes.json.puzzle.lichessId, "Tst14");
    assert.strictEqual(capturedAuthHeader, "Bearer lip_secret_token_alpha");

    const afterCountRes = await client.execute({ sql: "SELECT COUNT(*) AS cnt FROM puzzles", args: [] });
    assert.strictEqual(Number(afterCountRes.rows[0].cnt), beforeCount, "Le flux ne doit pas insérer automatiquement dans puzzles");
    console.log("  -> OK");

    console.log("Test 5 : POST /api/lichess/puzzle/complete synchronise vers Lichess...");
    const compRes = await httpRequest(
      port,
      "POST",
      "/api/lichess/puzzle/complete",
      { lichessId: "Tst14", win: true, angle: "fork", rated: true },
      cookieA
    );
    assert.strictEqual(compRes.status, 200);
    assert.strictEqual(compRes.json.synced, true);
    assert(capturedCompleteUrl.includes("/api/puzzle/batch/fork"));
    assert.strictEqual(capturedCompleteBody.solutions[0].id, "Tst14");
    assert.strictEqual(capturedCompleteBody.solutions[0].win, true);
    console.log("  -> OK");

    console.log("Test 6 : POST /api/lichess/puzzle/save (Option Woodpecker isolée par user_id)...");
    const saveResA = await httpRequest(port, "POST", "/api/lichess/puzzle/save", parsed, cookieA);
    assert.strictEqual(saveResA.status, 200);
    assert.strictEqual(saveResA.json.saved, true);

    const stateA = await httpRequest(port, "GET", "/api/state", null, cookieA);
    const stateB = await httpRequest(port, "GET", "/api/state", null, cookieB);
    assert(stateA.json.puzzles.some((p) => p.code === `LICHESS-Tst14-U${userA.id}`), "User A doit voir son puzzle sauvegardé");
    assert(!stateB.json.puzzles.some((p) => p.code === `LICHESS-Tst14-U${userA.id}`), "User B ne doit pas voir le puzzle de User A");

    const saveResB = await httpRequest(port, "POST", "/api/lichess/puzzle/save", parsed, cookieB);
    assert.strictEqual(saveResB.status, 200);
    assert.strictEqual(saveResB.json.saved, true);
    console.log("  -> OK");

    console.log("\nTOUS LES TESTS ÉTAPE 14 ONT RÉUSSI !");
  } finally {
    global.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
    cleanupTestDb();
  }
}

runTests().catch((err) => {
  console.error("ECHEC TEST ÉTAPE 14:", err);
  process.exit(1);
});
