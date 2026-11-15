/**
 * ============================================================================
 * TESTS AUTOMATISÉS OBLIGATOIRES — ÉTAPE 4
 * Simulation Cadence Championnat FIDE (90m + 30s/coup), Zeitnot & Coups Candidats
 * ============================================================================
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const ValisoaChessLite = require("../vendor/ValisoaChessLite.js");
const ValisoaFideClock = require("../db/fide_clock.js");
const { initDatabase } = require("../db/init.js");
const { upsertLichessUser, createSessionToken, SESSION_COOKIE_NAME } = require("../db/auth.js");
const apiHandler = require("../api/index.js");

let testCookieHeader = "";

const TEST_DB_PATH = path.join(__dirname, "test_step4.db");
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

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

function callApi(serverPort, method, urlPath, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: serverPort,
        path: urlPath,
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
          } catch (e) {
            reject(e);
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
  console.log("🧪 EXÉCUTION DES TESTS OBLIGATOIRES — ÉTAPE 4 (CADENCE FIDE & ZEITNOT)");
  console.log("==================================================================\n");

  // -------------------------------------------------------------------------
  // TEST 1 : Validation des Scénarios FIDE sur ValisoaChessLite
  // -------------------------------------------------------------------------
  console.log("▶ Test 1 : Vérification des scénarios FIDE (A, B, C, 90'+30\") sur ValisoaChessLite...");
  const scenarioKeys = Object.keys(ValisoaFideClock.FIDE_SCENARIOS);
  assert.ok(scenarioKeys.length >= 4, "Les 4 scénarios FIDE doivent être définis");

  for (const key of scenarioKeys) {
    const sc = ValisoaFideClock.FIDE_SCENARIOS[key];
    const chess = new ValisoaChessLite();
    assert.equal(chess.load(sc.fen), true, `La FEN du scénario ${sc.id} doit être valide`);

    // Tous les coups candidats recommandés doivent être légaux dans la position initiale du scénario
    for (const cand of sc.recommendedCandidates) {
      assert.equal(
        chess.isLegalMove(cand),
        true,
        `Le coup candidat recommandé '${cand}' doit être légal dans ${sc.id}`
      );
    }

    // La séquence solution_moves doit s'exécuter légalement
    for (const mv of sc.solution_moves) {
      const res = chess.move(mv);
      assert.ok(res, `Le coup '${mv}' de solution_moves doit être légal dans ${sc.id}`);
    }
  }
  console.log("  ✅ Test 1 RÉUSSI : Tous les scénarios FIDE (FEN, candidats, variantes) sont 100% légaux sur ValisoaChessLite.\n");

  // -------------------------------------------------------------------------
  // TEST 2 : Décompte de la pendule FIDE, Incrément Fischer (+30s/coup) & Drapeau
  // -------------------------------------------------------------------------
  console.log("▶ Test 2 : Vérification de la pendule FIDE et de l'incrément Fischer (+30s/coup)...");
  let clock = ValisoaFideClock.createClockState("scenario_c"); // Zeitnot Critique : 90s + 30s/coup au 38e coup
  assert.equal(clock.remainingSec, 90);
  assert.equal(clock.incrementSec, 30);
  assert.equal(clock.moveNumber, 38);
  assert.equal(clock.flagged, false);

  // 40 secondes de réflexion sur le 38e coup -> il reste 50s
  clock = ValisoaFideClock.tickClock(clock, 40);
  assert.equal(clock.remainingSec, 50);
  assert.equal(clock.elapsedTotalSec, 40);
  assert.equal(clock.flagged, false);

  // Le joueur joue 38. Nxd4 -> +30s Fischer -> 50 + 30 = 80s !
  clock = ValisoaFideClock.applyFischerIncrement(clock, "Nxd4", 40);
  assert.equal(clock.remainingSec, 80, "Après l'incrément Fischer (+30s), la pendule doit afficher 80s");
  assert.equal(clock.movesPlayed, 1);
  assert.equal(clock.moveNumber, 39);
  assert.equal(clock.incrementsAddedSec, 30);

  // 35 secondes de réflexion sur le 39e coup -> il reste 45s
  clock = ValisoaFideClock.tickClock(clock, 35);
  assert.equal(clock.remainingSec, 45);

  // Le joueur joue 39. Rxd4 -> +30s Fischer -> 45 + 30 = 75s !
  clock = ValisoaFideClock.applyFischerIncrement(clock, "Rxd4", 35);
  assert.equal(clock.remainingSec, 75, "Après le 2e incrément Fischer (+30s), la pendule doit afficher 75s");
  assert.equal(clock.movesPlayed, 2);
  assert.equal(clock.moveNumber, 40);
  assert.equal(clock.incrementsAddedSec, 60);

  // Test de chute du drapeau (80s s'écoulent alors qu'il reste 75s)
  clock = ValisoaFideClock.tickClock(clock, 80);
  assert.equal(clock.remainingSec, 0);
  assert.equal(clock.flagged, true, "Le drapeau doit tomber lorsque remainingSec atteint 0");

  // Un coup joué après la chute du drapeau ne doit PAS redonner d'incrément
  clock = ValisoaFideClock.applyFischerIncrement(clock, "Kf1", 5);
  assert.equal(clock.remainingSec, 0, "Aucun incrément ne doit être accordé après la chute du drapeau");
  assert.equal(clock.flagged, true);

  // Vérification du formatage HH:MM:SS et MM:SS
  assert.equal(ValisoaFideClock.formatFideClock(5400), "01:30:00");
  assert.equal(ValisoaFideClock.formatFideClock(3900), "01:05:00");
  assert.equal(ValisoaFideClock.formatFideClock(90), "01:30");

  console.log("  ✅ Test 2 RÉUSSI : Décompte FIDE, Incrément Fischer (+30s) et Chute du Drapeau validés.\n");

  // -------------------------------------------------------------------------
  // TEST 3 : Verrouillage / Déverrouillage « Coups Candidats Obligatoires »
  // -------------------------------------------------------------------------
  console.log("▶ Test 3 : Vérification du protocole Kotov (3 Coups Candidats obligatoires)...");
  const scA = ValisoaFideClock.FIDE_SCENARIOS.scenario_a;

  // Cas 1 : Seulement 2 coups candidats saisis (alors que 3 sont requis)
  const checkIncomplete = ValisoaFideClock.validateCandidateMoves(
    ["O-O-O", "Bc4", ""],
    scA.fen,
    ValisoaChessLite,
    3
  );
  assert.equal(checkIncomplete.unlocked, false, "L'échiquier doit rester verrouillé avec seulement 2 candidats sur 3");
  assert.equal(checkIncomplete.validCount, 2);

  // Cas 2 : Un coup illégal ("Qh8") parmi les 3
  const checkIllegal = ValisoaFideClock.validateCandidateMoves(
    ["O-O-O", "Bc4", "Qh8"],
    scA.fen,
    ValisoaChessLite,
    3
  );
  assert.equal(checkIllegal.unlocked, false, "Un coup candidat illégal ne doit pas déverrouiller l'échiquier");
  assert.equal(checkIllegal.details[2].valid, false);
  assert.equal(checkIllegal.details[2].reason, "Coup illégal");

  // Cas 3 : Un doublon ("O-O-O" et "0-0-0")
  const checkDuplicate = ValisoaFideClock.validateCandidateMoves(
    ["O-O-O", "0-0-0", "Bc4"],
    scA.fen,
    ValisoaChessLite,
    3
  );
  assert.equal(checkDuplicate.unlocked, false, "Un doublon de coup candidat ne doit pas être compté deux fois");
  assert.equal(checkDuplicate.details[1].reason, "Doublon");

  // Cas 4 : 3 coups candidats légaux distincts (avec support de la notation française Fc4 = Bc4)
  const checkValid = ValisoaFideClock.validateCandidateMoves(
    ["O-O-O", "Fc4", "g4"],
    scA.fen,
    ValisoaChessLite,
    3
  );
  assert.equal(checkValid.unlocked, true, "3 coups candidats légaux distincts doivent déverrouiller l'échiquier");
  assert.equal(checkValid.validCount, 3);

  console.log("  ✅ Test 3 RÉUSSI : Verrouillage/déverrouillage Kotov et validation SAN (FR/EN) sur ValisoaChessLite validés.\n");

  // -------------------------------------------------------------------------
  // TEST 4 : Sauvegarde du rapport de session Endurance FIDE dans SQLite
  // -------------------------------------------------------------------------
  console.log("▶ Test 4 : Vérification de la sauvegarde SQLite via POST /api/endurance...");
  cleanupTestDb();
  const client = await initDatabase(TEST_DB_URL);
  const testUser = await upsertLichessUser(client, { id: "step4_tester", username: "Step4Tester" });
  testCookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(testUser))}`;

  const server = http.createServer((req, res) => apiHandler(req, res, TEST_DB_URL));
  const testPort = 18768;
  await new Promise((resolve) => server.listen(testPort, "127.0.0.1", resolve));

  try {
    const saveRes = await callApi(testPort, "POST", "/api/endurance", {
      scenario_id: "scenario_c",
      scenario_title: "Zeitnot Critique · Coup 38",
      initial_sec: 90,
      remaining_sec: 75,
      increment_sec: 30,
      moves_played: 2,
      increments_added_sec: 60,
      candidate_moves: ["Nxd4", "cxd4"],
      distraction_returns: 3,
      flagged: false,
      notes: "1. Candidats : Nxd4, cxd4. 2. Décision : 38. Nxd4 Nxd4 39. Rxd4 égalise."
    });

    assert.equal(saveRes.status, 200);
    assert.ok(saveRes.json.lastEnduranceSession, "lastEnduranceSession doit être retourné");
    assert.equal(saveRes.json.enduranceSessions.length, 1, "La session Endurance doit être stockée dans SQLite");
    const saved = saveRes.json.enduranceSessions[0];
    assert.equal(saved.scenario_id, "scenario_c");
    assert.equal(saved.remaining_sec, 75);
    assert.equal(saved.increments_added_sec, 60);
    assert.deepEqual(saved.candidate_moves, ["Nxd4", "cxd4"]);
    assert.equal(saved.distraction_returns, 3);

    console.log("  ✅ Test 4 RÉUSSI : Rapport complet de session Endurance FIDE sauvegardé et relu depuis SQLite.\n");
  } finally {
    server.close();
    client.close();
    cleanupTestDb();
  }

  console.log("==================================================================");
  console.log("🏆 TOUS LES TESTS DE L'ÉTAPE 4 SONT PASSÉS AVEC SUCCÈS (100%) !");
  console.log("==================================================================");
}

runTests().catch((err) => {
  console.error("\n❌ ÉCHEC D'UN TEST DE L'ÉTAPE 4 :", err);
  process.exit(1);
});
