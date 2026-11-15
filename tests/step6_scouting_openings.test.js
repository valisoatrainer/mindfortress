/**
 * TESTS OBLIGATOIRES — ÉTAPE 6 :
 * Module « Scouting Adversaires Madagascar 2027 » (opponents) & Répertoire d'Ouvertures Interactif FSRS (opening_repertoire)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TEST_DB_PATH = path.join(__dirname, "test_step6_scouting.db");
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

const { getDbClient } = require("../db/client");
const { initDatabase } = require("../db/init");
const {
  parseOpeningLineMoves,
  parseOpponentReferencePgn,
  reviewOpeningLineFSRS
} = require("../db/scouting");
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

async function runTests() {
  console.log("==================================================================");
  console.log("🧪 DÉMARRAGE DES TESTS — ÉTAPE 6 (SCOUTING 2027 & RÉPERTOIRE FSRS)");
  console.log("==================================================================");

  cleanupTestDb();

  try {
    const dbClient = await initDatabase(TEST_DB_URL);
    const testUser = await upsertLichessUser(dbClient, { id: "step6_tester", username: "Step6Tester" });
    testCookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(testUser))}`;

    const server = http.createServer((req, res) => {
      if (req.url === "/vendor/ValisoaScoutingOpenings.js") {
        const data = fs.readFileSync(
          path.join(__dirname, "..", "vendor", "ValisoaScoutingOpenings.js")
        );
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/javascript");
        return res.end(data);
      }
      return apiHandler(req, res, TEST_DB_URL);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      // 1. Test CRUD complet des fiches adversaires Madagascar 2027 (table SQLite `opponents`)
      console.log("👉 Test 1 : CRUD complet de la table SQLite `opponents` & PGN de référence...");
      const opp1Res = await httpRequest(port, "POST", "/api/opponents", {
        name: "MF Rakotoarisoa",
        fide_elo: 2135,
        lichess_username: "rakoto_tana",
        style: "Tactique / Agressif",
        psych_profile: "Joue très vite les 15 premiers coups mais consomme trop de temps en finale.",
        white_repertoire: "1.e4 Espagnole / Italienne",
        black_repertoire: "Sicilienne Najdorf / Est-Indienne",
        reference_pgn:
          '[Event "Championnat Tana"]\n[White "MF Rakotoarisoa"]\n[Black "Challenger"]\n[Result "1-0"]\n\n1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Bg5 e6 7. f4 Be7 1-0',
        match_plan: "Rentrer dans une structure Caro-Kann solide et l'entraîner vers une finale technique après le 30e coup."
      });

      assert.strictEqual(opp1Res.status, 200);
      assert.strictEqual(opp1Res.json.opponents.length, 1);
      const createdOpp1 = opp1Res.json.lastOpponent;
      assert.ok(createdOpp1 && createdOpp1.id > 0);
      assert.strictEqual(createdOpp1.name, "MF Rakotoarisoa");
      assert.strictEqual(createdOpp1.fide_elo, 2135);

      // Ajout d'un 2e adversaire
      const opp2Res = await httpRequest(port, "POST", "/api/opponents", {
        name: "Andrianina",
        fide_elo: 1990,
        style: "Joueur de Zeitnot",
        white_repertoire: "1.d4 Système de Londres",
        black_repertoire: "Défense Française",
        reference_pgn: "1. d4 d5 2. Bf4 Nf6 3. e3 c5 4. c3 Nc6",
        match_plan: "Garder la tension centrale et accélérer la cadence au 25e coup."
      });
      assert.strictEqual(opp2Res.status, 200);
      assert.strictEqual(opp2Res.json.opponents.length, 2);
      const opp2Id = opp2Res.json.lastOpponent.id;

      // Mise à jour de la fiche adversaire 1 (Update)
      const opp1Update = await httpRequest(port, "POST", "/api/opponents", {
        ...createdOpp1,
        fide_elo: 2150,
        match_plan: "Plan mis à jour : éviter les complications tactiques directes avant le contrôle du 40e coup."
      });
      assert.strictEqual(opp1Update.status, 200);
      const updatedRow = opp1Update.json.opponents.find((o) => o.id === createdOpp1.id);
      assert.strictEqual(updatedRow.fide_elo, 2150);

      // Analyse du PGN de référence avec ValisoaChesspgnparser & ValisoaChessLite
      const parsedPgn = parseOpponentReferencePgn(createdOpp1.reference_pgn);
      assert.strictEqual(parsedPgn.valid, true, "Le PGN de référence de l'adversaire doit être valide");
      assert.strictEqual(parsedPgn.movesCount, 14, "7 coups complets = 14 demi-coups");
      assert.ok(parsedPgn.frames[14].fen.includes("rnbqk2r"), "FEN finale de la variante correcte");

      // Suppression du 2e adversaire (Delete)
      const delOppRes = await httpRequest(port, "DELETE", `/api/opponents?id=${opp2Id}`);
      assert.strictEqual(delOppRes.status, 200);
      assert.strictEqual(delOppRes.json.opponents.length, 1);
      console.log("   ✅ CRUD `opponents` (Create, Read, Update, Delete) et relecture PGN validés à 100%.");

      // 2. Test du Répertoire d'Ouvertures Interactif (`opening_repertoire` + validation ValisoaChessLite)
      console.log("👉 Test 2 : Validation ValisoaChessLite & CRUD de `opening_repertoire`...");
      // Vérifier qu'une ligne avec un coup illégal est rejetée (HTTP 400)
      const badLineRes = await httpRequest(port, "POST", "/api/openings", {
        side: "Blancs",
        name: "Ligne Illégale Test",
        eco: "C50",
        moves: "1. e4 e5 2. Qxe8",
        plan: "Coup impossible"
      });
      assert.strictEqual(
        badLineRes.status,
        400,
        "Une ligne d'ouverture contenant un coup illégal doit être refusée par ValisoaChessLite"
      );

      // Ajout d'une ligne Blancs valide (Italienne Giuoco Piano)
      const whiteLineRes = await httpRequest(port, "POST", "/api/openings", {
        side: "Blancs",
        name: "Italienne · Giuoco Piano (c3-d4)",
        eco: "C54",
        moves: "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3",
        plan: "Construire le centre de pions e4-d4 et viser f7.",
        mastery: 60
      });
      assert.strictEqual(whiteLineRes.status, 200);
      assert.strictEqual(whiteLineRes.json.openingRepertoire.length, 1);
      const createdLine = whiteLineRes.json.lastOpeningLine;
      assert.ok(createdLine && createdLine.id > 0);
      assert.strictEqual(createdLine.san_moves.length, 13, "13 demi-coups validés par ValisoaChessLite");

      // Vérifier que les coups de `createdLine.san_moves` s'exécutent jusqu'à `createdLine.final_fen` sur ValisoaChessLite
      const replayChess = new ValisoaChessLite();
      for (const mvSan of createdLine.san_moves) {
        const resMv = replayChess.move(mvSan);
        assert.ok(resMv, `Le coup d'ouverture ${mvSan} doit s'exécuter sur ValisoaChessLite`);
      }
      assert.strictEqual(
        replayChess.fen(),
        createdLine.final_fen,
        "La FEN finale après exécution sur ValisoaChessLite doit correspondre à final_fen en base"
      );

      // Ajout d'une ligne Noirs valide (Caro-Kann Avance)
      const blackLineRes = await httpRequest(port, "POST", "/api/openings", {
        side: "Noirs",
        name: "Caro-Kann · Variante d'Avance",
        eco: "B12",
        moves: "1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nf3 e6 5. Be2 c5",
        plan: "Attaquer la base de la chaîne de pions d4 avec c5 et Qb6.",
        mastery: 55
      });
      assert.strictEqual(blackLineRes.status, 200);
      assert.strictEqual(blackLineRes.json.openingRepertoire.length, 2);
      console.log("   ✅ Lignes Blancs et Noirs validées coup par coup sur ValisoaChessLite et stockées dans SQLite.");

      // 3. Test de révision espacée FSRS sur `opening_repertoire` (`POST /api/openings/review`)
      console.log("👉 Test 3 : Révision espacée FSRS du répertoire (`POST /api/openings/review`)...");
      const rev1 = await httpRequest(port, "POST", "/api/openings/review", {
        id: createdLine.id,
        rating: 3 // Good
      });
      assert.strictEqual(rev1.status, 200);
      const afterRev1 = rev1.json.openingRepertoire.find((l) => l.id === createdLine.id);
      assert.strictEqual(afterRev1.mastery, 70, "La maîtrise doit passer de 60% à 70% après un Good (3)");
      assert.ok(afterRev1.fsrs_stability > 0, "La stabilité FSRS S doit être > 0 après révision");
      assert.strictEqual(afterRev1.fsrs_reps, 1);

      const rev2 = await httpRequest(port, "POST", "/api/openings/review", {
        id: createdLine.id,
        rating: 4 // Easy
      });
      assert.strictEqual(rev2.status, 200);
      const afterRev2 = rev2.json.openingRepertoire.find((l) => l.id === createdLine.id);
      assert.strictEqual(afterRev2.mastery, 85, "La maîtrise doit passer de 70% à 85% après un Easy (4)");
      assert.ok(
        afterRev2.fsrs_stability >= afterRev1.fsrs_stability,
        "La stabilité FSRS doit augmenter après une révision Easy"
      );
      console.log(
        `   ✅ Révision FSRS d'ouverture validée : Maîtrise = ${afterRev2.mastery}%, Stabilité S = ${afterRev2.fsrs_stability}j.`
      );

      // 4. Test de service statique HTTP de /vendor/ValisoaScoutingOpenings.js
      console.log("👉 Test 4 : Service statique HTTP de /vendor/ValisoaScoutingOpenings.js...");
      const vendorRes = await httpRequest(port, "GET", "/vendor/ValisoaScoutingOpenings.js");
      assert.strictEqual(vendorRes.status, 200);
      assert.ok(vendorRes.text.includes("parseOpeningLineMoves"));
      console.log("   ✅ /vendor/ValisoaScoutingOpenings.js servi avec succès.");
    } finally {
      server.close();
    }

    console.log("==================================================================");
    console.log("🎉 TOUS LES TESTS DE L'ÉTAPE 6 SONT PASSÉS AVEC SUCCÈS (100%) !");
    console.log("==================================================================");
  } finally {
    try {
      getDbClient(TEST_DB_URL).close();
    } catch (_e) {}
    cleanupTestDb();
  }
}

runTests().catch((err) => {
  console.error("❌ ÉCHEC DES TESTS ÉTAPE 6 :", err);
  process.exit(1);
});
