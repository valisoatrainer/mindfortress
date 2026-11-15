/**
 * ============================================================================
 * TESTS AUTOMATISÉS OBLIGATOIRES — ÉTAPE 3
 * Algorithme FSRS v4.5 / v5 (Modèle DSR) + Mode Hybride Woodpecker (Tikkanen)
 * ============================================================================
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const ValisoaFSRS = require("../db/fsrs.js");
const { initDatabase } = require("../db/init.js");
const { upsertLichessUser, createSessionToken, SESSION_COOKIE_NAME } = require("../db/auth.js");
const apiHandler = require("../api/index.js");

let testCookieHeader = "";

const TEST_DB_PATH = path.join(__dirname, "test_step3.db");
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
  console.log("🧪 EXÉCUTION DES TESTS OBLIGATOIRES — ÉTAPE 3 (FSRS + WOODPECKER)");
  console.log("==================================================================\n");

  // -------------------------------------------------------------------------
  // TEST 1 : Formules Mathématiques FSRS v4.5 (DSR : Difficulty, Stability, Retrievability)
  // -------------------------------------------------------------------------
  console.log("▶ Test 1 : Vérification mathématique du modèle DSR (R(t,S), I(r,S), S0, D0)...");

  // Propriété fondamentale FSRS v4.5 : R(0, S) = 1.0 et R(S, S) = 0.90 exactement
  const rAtZero = ValisoaFSRS.calculateRetrievability(0, 10);
  assert.equal(rAtZero, 1, "À t=0, la probabilité de rappel R(0, S) doit être 1.0 (100%)");

  const rAtStability = ValisoaFSRS.calculateRetrievability(10, 10);
  assert.ok(
    Math.abs(rAtStability - 0.9) < 1e-9,
    `À t=S, R(S, S) doit valoir exactement 0.90 (obtenu: ${rAtStability})`
  );

  const rAfter2S = ValisoaFSRS.calculateRetrievability(20, 10);
  assert.ok(rAfter2S < 0.9 && rAfter2S > 0.8, "À t=2S, R(2S, S) doit décroître sous 0.90");

  // Intervalle pour request_retention = 0.90 doit être égal à round(S)
  assert.equal(ValisoaFSRS.calculateNextInterval(10, 0.9), 10, "I(0.90, 10) doit valoir 10 jours");
  assert.equal(ValisoaFSRS.calculateNextInterval(3.12, 0.9), 3, "I(0.90, 3.12) doit valoir 3 jours");

  // Stabilité initiale croissante S0(1) < S0(2) < S0(3) < S0(4)
  const s1 = ValisoaFSRS.initStability(1);
  const s2 = ValisoaFSRS.initStability(2);
  const s3 = ValisoaFSRS.initStability(3);
  const s4 = ValisoaFSRS.initStability(4);
  assert.ok(s1 < s2 && s2 < s3 && s3 < s4, `S0 doit croître avec la note (${s1} < ${s2} < ${s3} < ${s4})`);

  // Difficulté initiale décroissante D0(1) > D0(2) > D0(3) > D0(4)
  const d1 = ValisoaFSRS.initDifficulty(1, 3);
  const d2 = ValisoaFSRS.initDifficulty(2, 3);
  const d3 = ValisoaFSRS.initDifficulty(3, 3);
  const d4 = ValisoaFSRS.initDifficulty(4, 3);
  assert.ok(d1 > d2 && d2 > d3 && d3 > d4, `D0 doit décroître avec la note (${d1} > ${d2} > ${d3} > ${d4})`);

  console.log("  ✅ Test 1 RÉUSSI : Équations DSR (R(S,S)=0.90, I(0.90,S)=S, S0, D0) validées.\n");

  // -------------------------------------------------------------------------
  // TEST 2 : Transitions d'état FSRS (Review, Oubli/Lapse Again, Croissance Stabilité)
  // -------------------------------------------------------------------------
  console.log("▶ Test 2 : Vérification des transitions Review et Oubli (1 — Again)...");
  const now = new Date("2026-11-07T08:00:00.000Z");
  const tenDaysAgo = new Date(now.getTime() - 10 * 86400000).toISOString();

  const knownCard = {
    id: 1,
    diff: 3,
    box: 3,
    fsrs_state: ValisoaFSRS.FSRS_STATES.REVIEW,
    fsrs_stability: 10.0,
    fsrs_difficulty: 5.0,
    fsrs_reps: 3,
    fsrs_lapses: 0,
    fsrs_last_review: tenDaysAgo
  };

  const revAgain = ValisoaFSRS.reviewPuzzle(knownCard, 1, now);
  const revHard = ValisoaFSRS.reviewPuzzle(knownCard, 2, now);
  const revGood = ValisoaFSRS.reviewPuzzle(knownCard, 3, now);
  const revEasy = ValisoaFSRS.reviewPuzzle(knownCard, 4, now);

  // Vérification de l'échec (1 — Again)
  assert.equal(revAgain.fsrs_state, ValisoaFSRS.FSRS_STATES.RELEARNING, "Un oubli doit passer l'état en Relearning (3)");
  assert.equal(revAgain.fsrs_lapses, 1, "Un oubli doit incrémenter fsrs_lapses (+1)");
  assert.ok(revAgain.fsrs_difficulty > knownCard.fsrs_difficulty, "Un oubli doit augmenter la difficulté D");
  assert.ok(revAgain.fsrs_stability < knownCard.fsrs_stability, "Un oubli doit réduire la stabilité S");
  assert.equal(revAgain.fsrs_scheduled_days, 0, "Un oubli doit reprogrammer le puzzle immédiatement (0 jour)");
  assert.equal(revAgain.box, 1, "Un oubli doit renvoyer le puzzle en Boîte Woodpecker 1");

  // Vérification des succès (Hard < Good < Easy)
  assert.ok(
    revHard.fsrs_stability > knownCard.fsrs_stability &&
      revGood.fsrs_stability > revHard.fsrs_stability &&
      revEasy.fsrs_stability > revGood.fsrs_stability,
    `La stabilité post-rappel doit vérifier 10 < Hard(${revHard.fsrs_stability}) < Good(${revGood.fsrs_stability}) < Easy(${revEasy.fsrs_stability})`
  );
  assert.ok(revEasy.fsrs_difficulty < knownCard.fsrs_difficulty, "Une note Easy doit réduire la difficulté D");

  console.log("  ✅ Test 2 RÉUSSI : Transitions d'oubli (Again -> Relearning, Lapses+1) et de rappel (Hard < Good < Easy) validées.\n");

  // -------------------------------------------------------------------------
  // TEST 3 : Auto-Notation Échecs & Prévisualisation des 4 boutons
  // -------------------------------------------------------------------------
  console.log("▶ Test 3 : Vérification de l'auto-notation Échecs (autoRateChessPuzzle) & previewRatings...");
  assert.equal(
    ValisoaFSRS.autoRateChessPuzzle({ success: false, hadMistake: true, timeSec: 15, diff: 2 }),
    1,
    "Une erreur sur l'échiquier doit donner 1 (Again)"
  );
  assert.equal(
    ValisoaFSRS.autoRateChessPuzzle({ success: true, hadMistake: false, timeSec: 20, diff: 2, hintUsed: true }),
    2,
    "L'utilisation d'un indice doit plafonner la note à 2 (Hard)"
  );
  assert.equal(
    ValisoaFSRS.autoRateChessPuzzle({ success: true, hadMistake: false, timeSec: 30, diff: 2, hintUsed: false }),
    3,
    "Une résolution dans le temps cible sans erreur doit donner 3 (Good)"
  );
  assert.equal(
    ValisoaFSRS.autoRateChessPuzzle({ success: true, hadMistake: false, timeSec: 7, diff: 3, hintUsed: false }),
    4,
    "Une résolution réflexe en 7s sans erreur doit donner 4 (Easy)"
  );

  const previews = ValisoaFSRS.previewRatings(knownCard, now);
  assert.equal(previews[1].intervalText, "< 10m");
  assert.ok(previews[4].scheduledDays > previews[3].scheduledDays);
  console.log("  ✅ Test 3 RÉUSSI : Auto-notation Échecs et prévisualisation des 4 boutons validées.\n");

  // -------------------------------------------------------------------------
  // TEST 4 : Persistance SQLite (fsrs_review_logs) & File d'attente /api/puzzles/due
  // -------------------------------------------------------------------------
  console.log("▶ Test 4 : Vérification de l'API SQLite (/api/puzzles/solve, /api/puzzles/due, /api/woodpecker/cycle)...");
  cleanupTestDb();
  const client = await initDatabase(TEST_DB_URL);
  const testUser = await upsertLichessUser(client, { id: "step3_tester", username: "Step3Tester" });
  testCookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(testUser))}`;

  const server = http.createServer((req, res) => apiHandler(req, res, TEST_DB_URL));
  const testPort = 18767;
  await new Promise((resolve) => server.listen(testPort, "127.0.0.1", resolve));

  try {
    // 1. Résoudre le Puzzle #1 avec la note 4 (Easy -> programmé à ~15 jours)
    const resEasy = await callApi(testPort, "POST", "/api/puzzles/solve", {
      id: 1,
      success: true,
      rating: 4,
      time_sec: 8,
      emotion: "Confiant"
    });
    assert.equal(resEasy.status, 200);
    assert.equal(resEasy.json.lastFsrsReview.rating, 4);
    assert.ok(resEasy.json.lastFsrsReview.fsrs_scheduled_days >= 10);

    // 2. Rater le Puzzle #2 avec la note 1 (Again -> Relearning, échéance immédiate)
    const resAgain = await callApi(testPort, "POST", "/api/puzzles/solve", {
      id: 2,
      success: false,
      rating: 1,
      had_mistake: true,
      time_sec: 45,
      emotion: "Stress"
    });
    assert.equal(resAgain.status, 200);
    assert.equal(resAgain.json.lastFsrsReview.rating, 1);
    assert.equal(resAgain.json.lastFsrsReview.fsrs_state, ValisoaFSRS.FSRS_STATES.LEARNING);
    assert.equal(resAgain.json.lastFsrsReview.fsrs_lapses, 1);

    // 3. Simuler dans SQLite que le Puzzle #2 a son fsrs_due_date arrivé à échéance (maintenant - 1 min)
    const pastIso = new Date(Date.now() - 60 * 1000).toISOString();
    await client.execute({
      sql: "UPDATE user_puzzle_progress SET fsrs_due_date = ? WHERE puzzle_id = 2 AND user_id = ?",
      args: [pastIso, testUser.id]
    });

    // 4. Vérifier que la table fsrs_review_logs contient bien les 2 révisions enregistrées
    const logsCount = await client.execute("SELECT COUNT(*) AS cnt FROM fsrs_review_logs");
    assert.equal(Number(logsCount.rows[0].cnt), 2, "fsrs_review_logs doit contenir 2 entrées");

    // 5. Interroger GET /api/puzzles/due?mode=fsrs
    const dueRes = await callApi(testPort, "GET", "/api/puzzles/due?mode=fsrs&limit=67");
    assert.equal(dueRes.status, 200);
    const queue = dueRes.json.queue;
    assert.equal(queue.length, 67);
    assert.equal(
      queue[0].id,
      2,
      "Le puzzle #2 (en Relearning échu) doit sortir en n°1 absolu de la file FSRS"
    );
    assert.equal(
      queue[queue.length - 1].id,
      1,
      "Le puzzle #1 (Easy, programmé dans ~15 jours) doit être placé en fin de file FSRS"
    );

    // 6. Tester le changement de Cycle Woodpecker (Hans Tikkanen)
    const wpRes = await callApi(testPort, "POST", "/api/woodpecker/cycle", {
      cycle: 2,
      reset_cycle_solved: false
    });
    assert.equal(wpRes.status, 200);
    assert.equal(wpRes.json.settings.woodpecker_cycle, "2");

    console.log("  ✅ Test 4 RÉUSSI : File SQLite /api/puzzles/due, table fsrs_review_logs et Cycles Woodpecker 100% validés.\n");
  } finally {
    server.close();
    client.close();
    cleanupTestDb();
  }

  console.log("==================================================================");
  console.log("🏆 TOUS LES TESTS DE L'ÉTAPE 3 SONT PASSÉS AVEC SUCCÈS (100%) !");
  console.log("==================================================================");
}

runTests().catch((err) => {
  console.error("\n❌ ÉCHEC D'UN TEST DE L'ÉTAPE 3 :", err);
  process.exit(1);
});
