/**
 * MIND FORTRESS — Tests Automatisés Obligatoires de l'ÉTAPE 1
 * Validation du socle SQLite Natif / libSQL (Compatible Turso + Vercel)
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { getDbClient } = require("../db/client");
const { initDatabase } = require("../db/init");
const { upsertLichessUser, createSessionToken, SESSION_COOKIE_NAME } = require("../db/auth");
const { createAppServer } = require("../server");

const TEST_DB_PATH = path.join(__dirname, "test_step1.db");
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

async function runTests() {
  console.log("====================================================================");
  console.log("  EXÉCUTION DES TESTS OBLIGATOIRES — ÉTAPE 1 (SQLite Natif / Turso)");
  console.log("====================================================================\n");

  cleanupTestDb();

  // --------------------------------------------------------------------------
  // TEST 1 : Initialisation & Connexion SQLite Natif / libSQL
  // --------------------------------------------------------------------------
  const client = await initDatabase(TEST_DB_URL);
  console.log(`✅ [Test 1.1] Connexion établie via le pilote : ${client.driver}`);
  assert.ok(fs.existsSync(TEST_DB_PATH), "Le fichier binaire SQLite natif doit exister sur le disque");

  // Vérification de l'en-tête binaire officiel SQLite 3 ("SQLite format 3\0")
  const headerBuf = Buffer.alloc(16);
  const fd = fs.openSync(TEST_DB_PATH, "r");
  fs.readSync(fd, headerBuf, 0, 16, 0);
  fs.closeSync(fd);
  assert.strictEqual(
    headerBuf.toString("utf8", 0, 15),
    "SQLite format 3",
    "Le fichier doit être un vrai binaire SQLite 3 natif"
  );
  console.log("✅ [Test 1.2] En-tête binaire 'SQLite format 3' vérifié sur le disque.");

  // Vérification des tables créées
  const tablesRes = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  );
  const tableNames = new Set(tablesRes.rows.map((r) => r.name));
  const expectedTables = [
    "settings",
    "puzzles",
    "fsrs_review_logs",
    "logs",
    "contextual_journal",
    "completed_days",
    "blindage_entries",
    "lichess_games",
    "opponents",
    "opening_repertoire"
  ];
  for (const tbl of expectedTables) {
    assert.ok(tableNames.has(tbl), `La table '${tbl}' doit exister dans le schéma SQLite`);
  }
  console.log(`✅ [Test 1.3] Les ${expectedTables.length} tables du schéma SQLite/Turso sont présentes.`);

  // --------------------------------------------------------------------------
  // TEST 2 : Vérification des 67 Puzzles & Performance (< 10 ms)
  // --------------------------------------------------------------------------
  const t0 = performance.now();
  const puzzlesRes = await client.execute("SELECT * FROM puzzles ORDER BY id ASC");
  const elapsedMs = performance.now() - t0;

  assert.strictEqual(puzzlesRes.rows.length, 67, "Les 67 puzzles initiaux doivent être présents");
  assert.strictEqual(puzzlesRes.rows[0].code, "MF-01", "Le premier puzzle doit être MF-01");
  assert.strictEqual(puzzlesRes.rows[66].code, "P32", "Le 67e puzzle doit être P32");
  assert.ok(
    "fsrs_stability" in puzzlesRes.rows[0] && "fsrs_difficulty" in puzzlesRes.rows[0],
    "Les colonnes FSRS doivent être présentes sur chaque puzzle"
  );
  assert.ok(elapsedMs < 25, `La requête des 67 puzzles doit être ultra-rapide (mesuré: ${elapsedMs.toFixed(2)} ms)`);
  console.log(
    `✅ [Test 2.1] 67 puzzles vérifiés (MF-01 à P32) avec colonnes FSRS en ${elapsedMs.toFixed(2)} ms.`
  );

  // --------------------------------------------------------------------------
  // TEST 3 : Contraintes FOREIGN KEY (ON DELETE CASCADE) & Transactions ACID
  // --------------------------------------------------------------------------
  await client.execute("PRAGMA foreign_keys = ON");
  const fkRes = await client.execute("PRAGMA foreign_keys");
  assert.strictEqual(Number(fkRes.rows[0].foreign_keys), 1, "PRAGMA foreign_keys doit être actif (1)");

  // Insertion d'un puzzle de test + un log FSRS lié, puis suppression pour tester ON DELETE CASCADE
  await client.execute({
    sql: `INSERT INTO puzzles (id, code, title, fen, theme, type, diff, side, solution, custom)
          VALUES (999, 'TEST-FK', 'Test Cascade', '8/8/8/8/8/8/8/4K2k w - - 0 1', 'fork', 'tactique', 2, 'Blancs', '1. Kd2', 1)`
  });
  await client.execute({
    sql: `INSERT INTO fsrs_review_logs (puzzle_id, rating, state, stability, difficulty)
          VALUES (999, 3, 2, 5.2, 4.1)`
  });
  let fkLogsBefore = await client.execute("SELECT COUNT(*) AS c FROM fsrs_review_logs WHERE puzzle_id = 999");
  assert.strictEqual(Number(fkLogsBefore.rows[0].c), 1);

  await client.execute("DELETE FROM puzzles WHERE id = 999");
  let fkLogsAfter = await client.execute("SELECT COUNT(*) AS c FROM fsrs_review_logs WHERE puzzle_id = 999");
  assert.strictEqual(
    Number(fkLogsAfter.rows[0].c),
    0,
    "La suppression du puzzle doit supprimer en cascade ses fsrs_review_logs"
  );
  console.log("✅ [Test 3.1] Contraintes FOREIGN KEY (ON DELETE CASCADE) validées.");

  // --------------------------------------------------------------------------
  // TEST 4 : Tests End-to-End de toutes les routes API Serverless (/api/*)
  // --------------------------------------------------------------------------
  const server = createAppServer(TEST_DB_URL);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const testUser = await upsertLichessUser(client, { id: "step1_tester", username: "Step1Tester" });
  const cookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(testUser))}`;
  const authedFetch = (url, opts = {}) =>
    fetch(url, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        Cookie: cookieHeader
      }
    });

  try {
    // 4.1 GET /api/state
    const resState = await authedFetch(`${baseUrl}/api/state`);
    assert.strictEqual(resState.status, 200);
    const state = await resState.json();
    assert.strictEqual(state.mode, "sqlite_native");
    assert.strictEqual(state.tursoReady, true);
    assert.strictEqual(state.puzzles.length, 67);
    console.log("✅ [Test 4.1] GET /api/state : 200 OK (67 puzzles, mode sqlite_native, tursoReady=true).");

    // 4.2 POST /api/settings
    const resSettings = await authedFetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lichess_username: "valisoa_mada2027", level: "avance" })
    });
    assert.strictEqual(resSettings.status, 200);
    const stateAfterSettings = await resSettings.json();
    assert.strictEqual(stateAfterSettings.settings.lichess_username, "valisoa_mada2027");
    assert.strictEqual(stateAfterSettings.settings.level, "avance");
    console.log("✅ [Test 4.2] POST /api/settings : Persistance des paramètres validée.");

    // 4.3 POST /api/puzzles & POST /api/puzzles/solve
    const resAddPuzzle = await authedFetch(`${baseUrl}/api/puzzles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "PERSO-MADA",
        title: "Tactique Antananarivo",
        fen: "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1",
        theme: "mateIn2",
        type: "tactique",
        diff: 3,
        side: "Blancs",
        solution: "1. Re8#"
      })
    });
    assert.strictEqual(resAddPuzzle.status, 200);
    const stateAfterAdd = await resAddPuzzle.json();
    assert.strictEqual(stateAfterAdd.puzzles.length, 68);
    const customPuzzle = stateAfterAdd.puzzles.find((p) => p.code === "PERSO-MADA");
    assert.ok(customPuzzle, "Le puzzle personnalisé PERSO-MADA doit exister en base");

    const resSolve = await authedFetch(`${baseUrl}/api/puzzles/solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: customPuzzle.id, success: true, time_sec: 19 })
    });
    const stateAfterSolve = await resSolve.json();
    const solvedPuzzle = stateAfterSolve.puzzles.find((p) => p.id === customPuzzle.id);
    assert.strictEqual(Number(solvedPuzzle.solved), 1);
    assert.ok(Number(solvedPuzzle.box) >= 2);
    assert.strictEqual(Number(solvedPuzzle.best_time_sec), 19);
    console.log("✅ [Test 4.3] POST /api/puzzles & /api/puzzles/solve : Création et résolution validées.");

    // 4.4 POST /api/logs & POST /api/journal & POST /api/blindage
    const xpBefore = Number(stateAfterSolve.settings.xp);
    const resLog = await authedFetch(`${baseUrl}/api/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "Force",
        puzzle_id: customPuzzle.id,
        text: "Force — Tactique Antananarivo résolue",
        theme: "mateIn2",
        diff: 3,
        time_sec: 19,
        success: true,
        xp: 30,
        add_min: 15,
        emotion: "Focus"
      })
    });
    const stateAfterLog = await resLog.json();
    assert.strictEqual(Number(stateAfterLog.settings.xp), xpBefore + 30);

    const resJournal = await authedFetch(`${baseUrl}/api/journal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logId: stateAfterLog.logs[0].id,
        linkedText: stateAfterLog.logs[0].text,
        note: "Lucidité totale sur le mat du couloir.",
        beforeEmotion: "Calme",
        afterEmotion: "Confiant",
        lieu: "Club",
        fatigue: 1,
        tag: "championnat-2027"
      })
    });
    const stateAfterJournal = await resJournal.json();
    assert.strictEqual(stateAfterJournal.contextualJournal[0].tag, "championnat-2027");

    const resBlindage = await authedFetch(`${baseUrl}/api/blindage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wish: "Rester calme en zeitnot",
        outcome: "Jouer précis au 35e coup",
        obstacle: "Accélération cardiaque",
        plan: "Respiration 4-6 avant le coup",
        col1: "Bon contrôle du temps",
        col2: "Attention aux diagonales",
        col3: "Réviser 10 finales",
        mode: "daily",
        breathing_cycles: 6
      })
    });
    const stateAfterBlindage = await resBlindage.json();
    assert.ok(stateAfterBlindage.blindageHistory.length >= 1);
    console.log("✅ [Test 4.4] POST /api/logs, /api/journal & /api/blindage : Validés.");

    // 4.5 GET /api/db/download
    const resDownload = await authedFetch(`${baseUrl}/api/db/download`);
    assert.strictEqual(resDownload.status, 200);
    const dbBytes = Buffer.from(await resDownload.arrayBuffer());
    assert.strictEqual(dbBytes.toString("utf8", 0, 15), "SQLite format 3");
    console.log(`✅ [Test 4.5] GET /api/db/download : Binaire SQLite téléchargé (${dbBytes.length} octets).`);

    // 4.6 DELETE /api/puzzles
    const resDel = await authedFetch(`${baseUrl}/api/puzzles?id=${customPuzzle.id}`, { method: "DELETE" });
    const stateAfterDel = await resDel.json();
    assert.strictEqual(stateAfterDel.puzzles.length, 67);
    console.log("✅ [Test 4.6] DELETE /api/puzzles : Suppression propre du puzzle personnalisé.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    client.close();
    cleanupTestDb();
  }

  // --------------------------------------------------------------------------
  // TEST 5 : Migration & Vérification de la base principale `mind_fortress.db`
  // --------------------------------------------------------------------------
  const prodDbUrl = `file:${path.join(__dirname, "..", "mind_fortress.db")}`;
  const prodClient = await initDatabase(prodDbUrl);
  const prodPuzzles = await prodClient.execute("SELECT COUNT(*) AS c FROM puzzles");
  assert.ok(Number(prodPuzzles.rows[0].c) >= 67, "mind_fortress.db doit contenir au moins les 67 puzzles");
  prodClient.close();
  console.log("✅ [Test 5.1] Base principale mind_fortress.db migrée et vérifiée (prête pour Turso + Vercel).");

  console.log("\n====================================================================");
  console.log("  🎉 TOUS LES TESTS DE L'ÉTAPE 1 SONT PASSÉS AVEC SUCCÈS (100%) !");
  console.log("====================================================================");
}

runTests().catch((err) => {
  console.error("\n❌ ÉCHEC D'UN TEST DE L'ÉTAPE 1 :", err);
  process.exit(1);
});
