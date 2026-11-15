/**
 * TESTS OBLIGATOIRES FINAUX — ÉTAPE 7 :
 * Analytique Avancée (Corrélations Sommeil / Fatigue / Émotions / Précision FSRS),
 * Alerte de Seuil de Risque de Gaffe & Synchronisation / Déploiement GitHub (valisoadev) + Turso + Vercel
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TEST_SOURCE_DB = path.join(__dirname, "test_step7_source.db");
const TEST_TARGET_DB = path.join(__dirname, "test_step7_target.db");
const SOURCE_URL = `file:${TEST_SOURCE_DB}`;
const TARGET_URL = `file:${TEST_TARGET_DB}`;

const { getDbClient, createNativeSqliteClient } = require("../db/client");
const { initDatabase } = require("../db/init");
const { syncDatabaseToTarget } = require("../db/push_to_turso");
const { upsertLichessUser, createSessionToken, SESSION_COOKIE_NAME } = require("../db/auth");
const apiHandler = require("../api/index");

let testCookieHeader = "";

function cleanupTestDbs() {
  for (const base of [TEST_SOURCE_DB, TEST_TARGET_DB]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = base + suffix;
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch (_e) {}
      }
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
          Connection: "close",
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
  console.log("🧪 DÉMARRAGE DES TESTS — ÉTAPE 7 (ANALYTIQUE AVANCÉE & TURSO SYNC)");
  console.log("==================================================================");

  cleanupTestDbs();

  try {
    const srcClient = await initDatabase(SOURCE_URL);
    const testUser = await upsertLichessUser(srcClient, { id: "step7_tester", username: "Step7Tester" });
    testCookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(testUser))}`;

    const server = http.createServer((req, res) => {
      if (req.url === "/vendor/ValisoaAnalytics.js") {
        const data = fs.readFileSync(path.join(__dirname, "..", "vendor", "ValisoaAnalytics.js"));
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/javascript");
        return res.end(data);
      }
      return apiHandler(req, res, SOURCE_URL);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      // 1. Créer des données réelles d'entraînement et de journal contextuel pour tester les corrélations SQL & JS
      console.log("👉 Test 1 : Requêtes SQL d'agrégation, Corrélations Fatigue/Sommeil/Émotion & Alerte Gaffe...");

      // Séance 1 : Très frais (Fatigue 1/5, Sommeil Bon, Émotion Focus) -> Réussite rapide (22s)
      await httpRequest(port, "POST", "/api/puzzles/solve", {
        id: 1,
        success: true,
        rating: 4,
        time_sec: 22,
        emotion: "Focus"
      });
      const log1Res = await httpRequest(port, "POST", "/api/logs", {
        type: "Puzzle",
        puzzle_id: 1,
        text: "Puzzle #1 résolu frais",
        theme: "fork",
        diff: 2,
        time_sec: 22,
        success: true,
        xp: 20,
        emotion: "Focus"
      });
      const log1Id = log1Res.json.logs[0].id;
      await httpRequest(port, "POST", "/api/journal", {
        logId: log1Id,
        linkedText: "Puzzle #1 résolu frais",
        note: "Calcul limpide dès le matin",
        beforeEmotion: "Focus",
        afterEmotion: "Confiant",
        fatigue: 1,
        sommeil: "Bon",
        lieu: "Maison",
        bruit: "Calme"
      });

      // Séance 2 : Épuisé (Fatigue 5/5, Sommeil Mauvais, Émotion Tilt) -> Échec lent (95s)
      await httpRequest(port, "POST", "/api/puzzles/solve", {
        id: 2,
        success: false,
        rating: 1,
        time_sec: 95,
        emotion: "Tilt"
      });
      const log2Res = await httpRequest(port, "POST", "/api/logs", {
        type: "Puzzle",
        puzzle_id: 2,
        text: "Puzzle #2 raté sous fatigue",
        theme: "pin",
        diff: 3,
        time_sec: 95,
        success: false,
        xp: 5,
        emotion: "Tilt"
      });
      const log2Id = log2Res.json.logs[0].id;
      await httpRequest(port, "POST", "/api/journal", {
        logId: log2Id,
        linkedText: "Puzzle #2 raté sous fatigue",
        note: "Vision brouillée après une mauvaise nuit",
        beforeEmotion: "Tilt",
        afterEmotion: "Fatigue",
        fatigue: 5,
        sommeil: "Mauvais",
        lieu: "Transport",
        bruit: "Bruyant"
      });

      // Interroger GET /api/analytics
      const anaRes = await httpRequest(port, "GET", "/api/analytics");
      assert.strictEqual(anaRes.status, 200, "GET /api/analytics doit retourner 200");
      const { advancedAnalytics, sqlAggregations } = anaRes.json;
      assert.ok(advancedAnalytics, "advancedAnalytics doit être présent");
      assert.ok(sqlAggregations, "sqlAggregations doit être présent");

      // Vérifier l'agrégation SQL Fatigue × Réussite
      const sqlFatigue1 = sqlAggregations.sqlFatigueBySuccess.find((r) => Number(r.fatigue) === 1);
      const sqlFatigue5 = sqlAggregations.sqlFatigueBySuccess.find((r) => Number(r.fatigue) === 5);
      assert.ok(sqlFatigue1 && Number(sqlFatigue1.success_rate_pct) === 100);
      assert.ok(sqlFatigue5 && Number(sqlFatigue5.success_rate_pct) === 0);

      // Vérifier l'agrégation JS Fatigue × Réussite
      const jsFatigue1 = advancedAnalytics.fatigueCorrelation.find((r) => r.fatigue === 1);
      const jsFatigue5 = advancedAnalytics.fatigueCorrelation.find((r) => r.fatigue === 5);
      assert.strictEqual(jsFatigue1.successRatePct, 100);
      assert.strictEqual(jsFatigue5.successRatePct, 0);

      // Vérifier l'alerte de seuil de risque de gaffe (la dernière séance est en Fatigue 5/5 + Sommeil Mauvais + Tilt)
      assert.strictEqual(
        advancedAnalytics.blunderRiskAlert.level,
        "high",
        "L'alerte de risque de gaffe doit être 'high' après Fatigue 5/5 + Sommeil Mauvais + Tilt"
      );
      assert.ok(advancedAnalytics.blunderRiskAlert.score >= 65);
      assert.ok(advancedAnalytics.blunderRiskAlert.triggers.length >= 2);
      console.log(
        `   ✅ Corrélations SQL & JS validées · Alerte Gaffe déclenchée (${advancedAnalytics.blunderRiskAlert.title} · Score ${advancedAnalytics.blunderRiskAlert.score}/100).`
      );

      // 2. Test du script de migration & synchronisation locale -> Turso (`syncDatabaseToTarget`)
      console.log("👉 Test 2 : Synchronisation complète Locale -> Cible Turso (`db/push_to_turso.js`)...");
      const syncReport = await syncDatabaseToTarget(SOURCE_URL, TARGET_URL, "");
      assert.strictEqual(syncReport.ok, true);
      assert.strictEqual(syncReport.tablesReport.puzzles, 67);
      assert.strictEqual(syncReport.tablesReport.logs, 2);
      assert.strictEqual(syncReport.tablesReport.contextual_journal, 2);
      assert.strictEqual(syncReport.tablesReport.fsrs_review_logs, 2);

      const targetCheckClient = createNativeSqliteClient(TARGET_URL, "");
      try {
        const targetPuzzles = await targetCheckClient.execute("SELECT COUNT(*) AS c FROM puzzles");
        const targetLogs = await targetCheckClient.execute("SELECT COUNT(*) AS c FROM logs");
        const targetJournal = await targetCheckClient.execute(
          "SELECT COUNT(*) AS c FROM contextual_journal"
        );
        assert.strictEqual(Number(targetPuzzles.rows[0].c), 67);
        assert.strictEqual(Number(targetLogs.rows[0].c), 2);
        assert.strictEqual(Number(targetJournal.rows[0].c), 2);
      } finally {
        targetCheckClient.close();
      }
      console.log("   ✅ Réplication intégrale vers la base cible Turso/libSQL vérifiée sans aucune perte.");

      // 3. Test des fichiers de déploiement GitHub (`valisoadev`) + Vercel + Turso
      console.log("👉 Test 3 : Vérification de la configuration GitHub (valisoadev) + Vercel + Turso...");
      const baseDir = path.join(__dirname, "..");
      assert.ok(fs.existsSync(path.join(baseDir, "vercel.json")), "vercel.json doit exister");
      assert.ok(fs.existsSync(path.join(baseDir, ".gitignore")), ".gitignore doit exister");
      assert.ok(
        fs.existsSync(path.join(baseDir, "DEPLOY_GITHUB_VERCEL_TURSO.md")),
        "DEPLOY_GITHUB_VERCEL_TURSO.md doit exister"
      );
      const deployGuide = fs.readFileSync(
        path.join(baseDir, "DEPLOY_GITHUB_VERCEL_TURSO.md"),
        "utf8"
      );
      assert.ok(
        deployGuide.includes("valisoadev"),
        "Le guide de déploiement doit être configuré pour le compte GitHub valisoadev"
      );

      const vendorRes = await httpRequest(port, "GET", "/vendor/ValisoaAnalytics.js");
      assert.strictEqual(vendorRes.status, 200);
      assert.ok(vendorRes.text.includes("computeAdvancedAnalytics"));
      console.log("   ✅ Configuration GitHub (valisoadev) + Vercel + Turso et /vendor/ValisoaAnalytics.js validés.");
    } finally {
      server.close();
    }

    console.log("==================================================================");
    console.log("🎉 TOUS LES TESTS DE L'ÉTAPE 7 SONT PASSÉS AVEC SUCCÈS (100%) !");
    console.log("==================================================================");
  } finally {
    try {
      getDbClient(SOURCE_URL).close();
    } catch (_e) {}
    try {
      getDbClient(TARGET_URL).close();
    } catch (_e) {}
    cleanupTestDbs();
  }
}

runTests().catch((err) => {
  console.error("❌ ÉCHEC DES TESTS ÉTAPE 7 :", err);
  process.exit(1);
});
