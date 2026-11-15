/**
 * TESTS OBLIGATOIRES — ÉTAPE 5 :
 * Synchronisation Automatique API Lichess, Conversion des Gaffes en Puzzles FSRS & Diagnostic Chronobiologique
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TEST_DB_PATH = path.join(__dirname, "test_step5_lichess.db");
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

const { getDbClient } = require("../db/client");
const { initDatabase } = require("../db/init");
const {
  parsePgnGamesBatch,
  convertPositionToFsrsPuzzle,
  computeChronobiologyReport
} = require("../db/lichess");
const ValisoaChessLite = require("../vendor/ValisoaChessLite");
const { upsertLichessUser, createSessionToken, SESSION_COOKIE_NAME } = require("../db/auth");
const apiHandler = require("../api/index");

let testCookieHeader = "";

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

function httpRequest(port, method, reqPath, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          ...(testCookieHeader ? { Cookie: testCookieHeader } : {}),
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload)
              }
            : {})
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) });
          } catch (_e) {
            resolve({ status: res.statusCode, text: data });
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const SAMPLE_MULTI_PGN = `
[Event "Rated Classical game"]
[Site "https://lichess.org/abcd1001"]
[UTCDate "2026.11.05"]
[UTCTime "08:30:00"]
[White "Valisoa2027"]
[Black "RivalTana"]
[Result "1-0"]
[TimeControl "5400+30"]
[Opening "Italian Game: Giuoco Piano"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3 Nxe4 8. O-O Bxc3 9. d5 Bf6 1-0

[Event "Rated Classical game"]
[Site "https://lichess.org/abcd1002"]
[UTCDate "2026.11.06"]
[UTCTime "09:45:00"]
[White "ChallengerMada"]
[Black "Valisoa2027"]
[Result "0-1"]
[TimeControl "5400+30"]
[Opening "Caro-Kann Defense: Advance Variation"]

1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nf3 e6 5. Be2 c5 6. Be3 Nc6 7. O-O cxd4 8. Nxd4 Nge7 0-1

[Event "Rated Rapid game"]
[Site "https://lichess.org/abcd1003"]
[UTCDate "2026.11.06"]
[UTCTime "14:20:00"]
[White "Valisoa2027"]
[Black "MaMada"]
[Result "1-0"]
[TimeControl "900+10"]
[Opening "Queen's Gambit Declined"]

1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 Nbd7 7. Rc1 c6 8. Bd3 dxc4 9. Bxc4 Nd5 1-0

[Event "Rated Blitz game"]
[Site "https://lichess.org/abcd1004"]
[UTCDate "2026.11.06"]
[UTCTime "23:45:00"]
[White "Valisoa2027"]
[Black "NightTactician"]
[Result "0-1"]
[TimeControl "180+2"]
[Opening "Sicilian Defense: Najdorf"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3 e5 7. Nb3 Be6 {?? Gaffe critique de fatigue nocturne} 8. f3 Be7 9. Qd2 O-O 0-1
`;

const EXTRA_FIFTH_PGN = `
[Event "Rated Blitz game"]
[Site "https://lichess.org/abcd1005"]
[UTCDate "2026.11.07"]
[UTCTime "01:15:00"]
[White "NightOwl"]
[Black "Valisoa2027"]
[Result "1-0"]
[TimeControl "180+0"]
[Opening "French Defense"]

1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5 Be7 5. e5 Nfd7 6. Bxe7 Qxe7 1-0
`;

async function runTests() {
  console.log("==================================================================");
  console.log("🧪 DÉMARRAGE DES TESTS — ÉTAPE 5 (LICHESS SYNC, FSRS & CHRONOBIOLOGIE)");
  console.log("==================================================================");

  cleanupTestDb();

  try {
    // 1. Test du parseur multi-parties PGN + extraction de position critique
    console.log("👉 Test 1 : Parsing PGN multi-parties avec ValisoaChesspgnparser & ValisoaChessLite...");
    const parsedBatch = parsePgnGamesBatch(SAMPLE_MULTI_PGN, "Valisoa2027");
    assert.strictEqual(parsedBatch.length, 4, "Le lot PGN doit retourner exactement 4 parties");

    assert.strictEqual(parsedBatch[0].id, "abcd1001");
    assert.strictEqual(parsedBatch[0].speed, "classical");
    assert.strictEqual(parsedBatch[0].hour_of_day, 8);
    assert.strictEqual(parsedBatch[1].id, "abcd1002");
    assert.strictEqual(parsedBatch[1].hour_of_day, 9);
    assert.strictEqual(parsedBatch[2].id, "abcd1003");
    assert.strictEqual(parsedBatch[2].speed, "rapid");
    assert.strictEqual(parsedBatch[2].hour_of_day, 14);
    assert.strictEqual(parsedBatch[3].id, "abcd1004");
    assert.strictEqual(parsedBatch[3].speed, "blitz");
    assert.strictEqual(parsedBatch[3].hour_of_day, 23);

    for (const g of parsedBatch) {
      const chess = new ValisoaChessLite();
      assert.strictEqual(chess.load(g.critical_fen), true, `FEN critique valide pour ${g.id}`);
      assert.ok(g.critical_solution_moves.length >= 1, `Au moins 1 coup solution extrait pour ${g.id}`);
      for (const mvSan of g.critical_solution_moves) {
        const mvObj = chess.move(mvSan);
        assert.ok(mvObj, `Le coup critique ${mvSan} de ${g.id} doit être légal sur ValisoaChessLite`);
      }
    }
    console.log("   ✅ 4 parties PGN analysées, heures UTC extraites et coups critiques validés sur ValisoaChessLite.");

    // 2. Test API HTTP : Synchronisation & Déduplication SQLite (INSERT OR IGNORE)
    console.log("👉 Test 2 : POST /api/lichess/sync & Déduplication SQLite (INSERT OR IGNORE)...");
    const dbClient = await initDatabase(TEST_DB_URL);
    const testUser = await upsertLichessUser(dbClient, { id: "step5_tester", username: "Step5Tester" });
    testCookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(testUser))}`;

    const server = http.createServer((req, res) => {
      if (req.url === "/vendor/ValisoaLichess.js") {
        const data = fs.readFileSync(path.join(__dirname, "..", "vendor", "ValisoaLichess.js"));
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/javascript");
        return res.end(data);
      }
      return apiHandler(req, res, TEST_DB_URL);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const sync1 = await httpRequest(port, "POST", "/api/lichess/sync", {
        username: "Valisoa2027",
        raw_pgn: SAMPLE_MULTI_PGN,
        profile: {
          username: "Valisoa2027",
          classical: 1980,
          rapid: 1920,
          blitz: 1810,
          puzzle: 2100,
          countAll: 420
        }
      });

      assert.strictEqual(sync1.status, 200, "POST /api/lichess/sync doit répondre 200");
      assert.strictEqual(sync1.json.syncReport.parsedCount, 4);
      assert.strictEqual(sync1.json.syncReport.insertedCount, 4);
      assert.strictEqual(sync1.json.syncReport.duplicatesSkipped, 0);
      assert.strictEqual(sync1.json.lichessGames.length, 4);
      assert.strictEqual(sync1.json.lichessProfile.classical, 1980);

      // Deuxième synchronisation avec les 4 mêmes parties + 1 nouvelle partie (abcd1005)
      const sync2 = await httpRequest(port, "POST", "/api/lichess/sync", {
        username: "Valisoa2027",
        raw_pgn: SAMPLE_MULTI_PGN + "\n\n" + EXTRA_FIFTH_PGN
      });

      assert.strictEqual(sync2.status, 200);
      assert.strictEqual(sync2.json.syncReport.parsedCount, 5);
      assert.strictEqual(
        sync2.json.syncReport.insertedCount,
        1,
        "Seule la 5e partie inédite doit être insérée"
      );
      assert.strictEqual(
        sync2.json.syncReport.duplicatesSkipped,
        4,
        "Les 4 parties déjà présentes doivent être ignorées par INSERT OR IGNORE"
      );
      assert.strictEqual(sync2.json.lichessGames.length, 5);
      console.log("   ✅ Déduplication SQLite vérifiée : 4 doublons ignorés, 1 nouvelle partie ajoutée (total = 5).");

      // 3. Test de conversion d'une partie Lichess en Puzzle FSRS dans SQLite
      console.log("👉 Test 3 : POST /api/lichess/to-puzzle (Conversion Gaffe -> Puzzle FSRS)...");
      const beforePuzzlesCount = sync2.json.puzzles.length;
      const toPzRes = await httpRequest(port, "POST", "/api/lichess/to-puzzle", {
        game_id: "abcd1004"
      });
      assert.strictEqual(toPzRes.status, 200, "POST /api/lichess/to-puzzle doit répondre 200");
      assert.strictEqual(
        toPzRes.json.puzzles.length,
        beforePuzzlesCount + 1,
        "Un nouveau puzzle personnalisé FSRS doit être ajouté à la table puzzles"
      );
      const createdPz = toPzRes.json.createdPuzzle;
      assert.ok(createdPz, "createdPuzzle doit être retourné");
      assert.strictEqual(createdPz.custom, 1);
      assert.strictEqual(createdPz.fsrs_state, 0);
      assert.ok(Array.isArray(createdPz.solution_moves) && createdPz.solution_moves.length > 0);

      // Vérifier que le puzzle créé est jouable dans ValisoaChessLite
      const checkChess = new ValisoaChessLite();
      assert.strictEqual(checkChess.load(createdPz.fen), true);
      for (const san of createdPz.solution_moves) {
        assert.ok(checkChess.move(san), `Le coup ${san} du puzzle généré doit être légal`);
      }
      console.log(`   ✅ Partie abcd1004 convertie en Puzzle FSRS #${createdPz.id} (${createdPz.code}) jouable sur ValisoaChessLite.`);

      // 4. Test du Diagnostic Chronobiologique sur 4 créneaux horaires
      console.log("👉 Test 4 : Diagnostic Chronobiologique (4 créneaux horaires : Matin, Midi, Soir, Nuit)...");
      const chrono = toPzRes.json.chronobiologyReport;
      assert.ok(chrono, "chronobiologyReport doit être présent dans /api/state");
      assert.strictEqual(chrono.slots.length, 4, "Il doit y avoir 4 créneaux chronobiologiques");

      const matinSlot = chrono.slots.find((s) => s.id === "matin");
      const midiSlot = chrono.slots.find((s) => s.id === "midi");
      const nuitSlot = chrono.slots.find((s) => s.id === "nuit");

      assert.strictEqual(matinSlot.gamesCount, 2, "2 parties jouées le matin (08h30 et 09h45)");
      assert.strictEqual(matinSlot.successRatePct, 100, "100% de victoires le matin pour Valisoa2027");
      assert.strictEqual(midiSlot.gamesCount, 1, "1 partie jouée à 14h20 (Midi)");
      assert.strictEqual(midiSlot.successRatePct, 100, "100% de victoire à 14h20");
      assert.strictEqual(nuitSlot.gamesCount, 2, "2 parties jouées la nuit (23h45 et 01h15)");
      assert.strictEqual(nuitSlot.successRatePct, 0, "0% de réussite la nuit (2 défaites)");

      assert.strictEqual(
        chrono.peakSlot.id,
        "matin",
        "Le créneau de lucidité maximale doit être le Matin (100% sur 2 parties)"
      );
      assert.strictEqual(
        chrono.riskSlot.id,
        "nuit",
        "Le créneau à risque de gaffe doit être la Nuit (0% sur 2 parties)"
      );
      console.log(
        `   ✅ Chronobiologie validée : Pic = ${chrono.peakSlot.label} (${chrono.peakSlot.successRatePct}%), Risque = ${chrono.riskSlot.label} (${chrono.riskSlot.successRatePct}%).`
      );

      // 5. Test de téléchargement du script /vendor/ValisoaLichess.js
      console.log("👉 Test 5 : Service statique HTTP de /vendor/ValisoaLichess.js...");
      const vendorRes = await httpRequest(port, "GET", "/vendor/ValisoaLichess.js");
      assert.strictEqual(vendorRes.status, 200);
      assert.ok(vendorRes.text.includes("computeChronobiologyReport"));
      console.log("   ✅ /vendor/ValisoaLichess.js servi avec succès.");
    } finally {
      server.close();
    }

    console.log("==================================================================");
    console.log("🎉 TOUS LES TESTS DE L'ÉTAPE 5 SONT PASSÉS AVEC SUCCÈS (100%) !");
    console.log("==================================================================");
  } finally {
    try {
      getDbClient(TEST_DB_URL).close();
    } catch (_e) {}
    cleanupTestDb();
  }
}

runTests().catch((err) => {
  console.error("❌ ÉCHEC DES TESTS ÉTAPE 5 :", err);
  process.exit(1);
});
