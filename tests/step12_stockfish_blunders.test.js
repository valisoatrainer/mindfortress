/**
 * ============================================================================
 * TESTS OBLIGATOIRES — ÉTAPE 12 :
 * Détection automatique des vraies gaffes Lichess via Stockfish (WASM)
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TEST_DB_PATH = path.join(__dirname, "test_step12_stockfish.db");
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

const { getDbClient } = require("../db/client");
const { initDatabase } = require("../db/init");
const { SESSION_COOKIE_NAME, createSessionToken, upsertLichessUser } = require("../db/auth");
const { createAppServer } = require("../server");
const ValisoaChessLite = require("../vendor/ValisoaChessLite.js");
const SF = require("../vendor/ValisoaStockfishAnalyzer.js");

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
    console.log("Test 1 : Extraction des positions PGN & normalisation d'évaluation UCI...");
    const samplePgn = "1. e4 e5 2. Nf3 f6 3. Nxe5";
    const plies = SF.extractPositionsFromPgn(samplePgn);
    assert.strictEqual(plies.length, 5);
    assert.strictEqual(plies[3].san, "f6");
    assert.strictEqual(plies[3].turnBefore, "b");
    assert.strictEqual(SF.normalizeEvalToWhiteCp("cp", -250, "b"), 250);
    assert.strictEqual(SF.normalizeEvalToWhiteCp("cp", 180, "w"), 180);
    console.log("  -> OK");

    console.log("Test 2 : Détection du seuil de gaffe (> 150 cp) & légalité ValisoaChessLite...");
    const evals = [
      { ...plies[0], evalBeforeWhiteCp: 20, evalAfterWhiteCp: 30, bestMoveUci: "e2e4" }, // pas de gaffe
      { ...plies[1], evalBeforeWhiteCp: 30, evalAfterWhiteCp: 25, bestMoveUci: "e7e5" }, // pas de gaffe
      { ...plies[2], evalBeforeWhiteCp: 25, evalAfterWhiteCp: 35, bestMoveUci: "g1f3" }, // pas de gaffe
      { ...plies[3], evalBeforeWhiteCp: 35, evalAfterWhiteCp: 240, bestMoveUci: "b8c6" } // f6?? chute de 205 cp pour les Noirs !
    ];
    const blunders = SF.detectBlundersFromEvaluations(evals, 150);
    assert.strictEqual(blunders.length, 1);
    const bl = blunders[0];
    assert.strictEqual(bl.playedSan, "f6");
    assert.strictEqual(bl.bestMoveSan, "Nc6");
    assert.strictEqual(bl.evalDropCp, 205);
    assert.strictEqual(bl.side, "Noirs");

    const chess = new ValisoaChessLite();
    assert(chess.load(bl.fen), "FEN avant gaffe doit être valide");
    const legalBest = chess.move(bl.solution_moves[0]);
    assert(legalBest, "Le meilleur coup Stockfish doit être légal sur ValisoaChessLite");
    console.log("  -> OK");

    console.log("Test 3 : Enregistrement de la gaffe en puzzle FSRS isolé par user_id...");
    const client = getDbClient(TEST_DB_URL);
    const userA = await upsertLichessUser(client, { id: "sf_alpha", username: "SfAlpha", perfs: {} });
    const userB = await upsertLichessUser(client, { id: "sf_beta", username: "SfBeta", perfs: {} });
    const cookieA = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(userA))}`;
    const cookieB = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(userB))}`;

    // Importer d'abord une partie Lichess pour userA
    const syncRes = await httpRequest(
      port,
      "POST",
      "/api/lichess/sync",
      {
        username: "SfAlpha",
        raw_pgn: '[Site "https://lichess.org/sfgame01"]\n[White "Opponent"]\n[Black "SfAlpha"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 f6 3. Nxe5 1-0'
      },
      cookieA
    );
    assert.strictEqual(syncRes.status, 200);
    const gameId = syncRes.json.lichessGames[0].id;

    const toPuzzleRes = await httpRequest(
      port,
      "POST",
      "/api/lichess/to-puzzle",
      {
        game_id: gameId,
        blunder_ply: bl.ply,
        fen: bl.fen,
        solution_moves: bl.solution_moves,
        moveNumber: bl.moveNumber,
        diff: bl.diff,
        theme: "middlegame",
        title: `Gaffe Stockfish (${bl.evalDropCp} cp)`
      },
      cookieA
    );
    assert.strictEqual(toPuzzleRes.status, 200);
    assert(
      toPuzzleRes.json.puzzles.some((p) => String(p.title).includes("Gaffe Stockfish (205 cp)")),
      "Le puzzle Stockfish doit être créé pour User A"
    );

    const stateB = await httpRequest(port, "GET", "/api/state", null, cookieB);
    assert(
      !stateB.json.puzzles.some((p) => String(p.title).includes("Gaffe Stockfish (205 cp)")),
      "User B ne doit pas voir le puzzle Stockfish de User A"
    );
    console.log("  -> OK");

    console.log("Test 4 : Service statique /vendor/ValisoaStockfishAnalyzer.js...");
    const staticRes = await httpRequest(port, "GET", "/vendor/ValisoaStockfishAnalyzer.js");
    assert.strictEqual(staticRes.status, 200);
    assert(staticRes.body.includes("detectBlundersFromEvaluations"));
    console.log("  -> OK");

    console.log("\nTOUS LES TESTS ÉTAPE 12 ONT RÉUSSI !");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTestDb();
  }
}

runTests().catch((err) => {
  console.error("ECHEC TEST ÉTAPE 12:", err);
  process.exit(1);
});
