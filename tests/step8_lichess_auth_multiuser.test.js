/**
 * ============================================================================
 * TESTS OBLIGATOIRES — ÉTAPE 8 :
 * Authentification Obligatoire Lichess (OAuth 2.0 PKCE) & Isolation Multi-Utilisateurs
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TEST_DB_PATH = path.join(__dirname, "test_step8_auth.db");
const TEST_DB_URL = `file:${TEST_DB_PATH}`;

const { getDbClient } = require("../db/client");
const { initDatabase } = require("../db/init");
const { SESSION_COOKIE_NAME, PKCE_COOKIE_NAME } = require("../db/auth");
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
    const headers = {
      Connection: "close"
    };
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
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsedJson = null;
          try {
            parsedJson = JSON.parse(data);
          } catch (_e) {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            json: parsedJson,
            text: data
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractCookieValue(setCookieHeaders, cookieName) {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
    ? [setCookieHeaders]
    : [];
  for (const entry of list) {
    const firstPart = String(entry).split(";")[0];
    const eqIdx = firstPart.indexOf("=");
    if (eqIdx !== -1) {
      const name = firstPart.slice(0, eqIdx).trim();
      const val = firstPart.slice(eqIdx + 1).trim();
      if (name === cookieName) return `${name}=${val}`;
    }
  }
  return "";
}

async function runTests() {
  console.log("==================================================================");
  console.log("🧪 DÉMARRAGE DES TESTS — ÉTAPE 8 (AUTH LICHESS OAUTH2 PKCE & MULTI-JOUEURS)");
  console.log("==================================================================");

  cleanupTestDb();
  const originalFetch = globalThis.fetch;

  try {
    await initDatabase(TEST_DB_URL);

    const server = http.createServer((req, res) => apiHandler(req, res, TEST_DB_URL));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      // 1. Vérifier que les routes protégées rejettent tout accès anonyme (401)
      console.log("👉 Test 1 : Connexion obligatoire (401 AUTH_REQUIRED sans cookie)...");
      const unauthState = await httpRequest(port, "GET", "/api/state");
      assert.strictEqual(unauthState.status, 401);
      assert.strictEqual(unauthState.json.code, "AUTH_REQUIRED");

      const unauthPost = await httpRequest(port, "POST", "/api/logs", { text: "Pirate" });
      assert.strictEqual(unauthPost.status, 401);

      const healthRes = await httpRequest(port, "GET", "/api/health");
      assert.strictEqual(healthRes.status, 200);
      assert.strictEqual(healthRes.json.auth, "lichess_oauth2_pkce_required");
      console.log("   ✅ Routes protégées verrouillées à 401, /api/health accessible.");

      // 2. Simuler le flux OAuth 2.0 PKCE complet pour Joueur A (PlayerAlpha)
      console.log("👉 Test 2 : Flux OAuth 2.0 PKCE Lichess (Login -> Callback -> Session Signée)...");
      const loginA = await httpRequest(port, "GET", "/api/auth/lichess/login");
      assert.strictEqual(loginA.status, 302);
      const locA = new URL(loginA.headers.location);
      assert.strictEqual(locA.origin, "https://lichess.org");
      assert.strictEqual(locA.pathname, "/oauth");
      assert.strictEqual(locA.searchParams.get("code_challenge_method"), "S256");
      const stateA = locA.searchParams.get("state");
      const pkceCookieA = extractCookieValue(loginA.headers["set-cookie"], PKCE_COOKIE_NAME);
      assert.ok(pkceCookieA.startsWith(`${PKCE_COOKIE_NAME}=`));

      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u === "https://lichess.org/api/token") {
          return {
            ok: true,
            json: async () => ({ access_token: "lip_mock_alpha_token" })
          };
        }
        if (u === "https://lichess.org/api/account") {
          return {
            ok: true,
            json: async () => ({
              id: "playeralpha",
              username: "PlayerAlpha",
              perfs: { rapid: { rating: 1950 } }
            })
          };
        }
        throw new Error("Unexpected fetch: " + u);
      };

      const cbA = await httpRequest(
        port,
        "GET",
        `/api/auth/lichess/callback?code=mock_code_a&state=${encodeURIComponent(stateA)}`,
        null,
        pkceCookieA
      );
      assert.strictEqual(cbA.status, 302);
      assert.strictEqual(cbA.headers.location, "/");
      const sessionCookieA = extractCookieValue(cbA.headers["set-cookie"], SESSION_COOKIE_NAME);
      assert.ok(sessionCookieA.startsWith(`${SESSION_COOKIE_NAME}=`));

      const meA = await httpRequest(port, "GET", "/api/auth/me", null, sessionCookieA);
      assert.strictEqual(meA.status, 200);
      assert.strictEqual(meA.json.authenticated, true);
      assert.strictEqual(meA.json.user.username, "PlayerAlpha");
      console.log("   ✅ PlayerAlpha authentifié via PKCE avec cookie HttpOnly signé.");

      // 3. PlayerAlpha crée sa préparation personnelle
      console.log("👉 Test 3 : Isolation stricte entre PlayerAlpha et PlayerBeta...");
      await httpRequest(
        port,
        "POST",
        "/api/puzzles/solve",
        { id: 1, success: true, rating: 4, time_sec: 12 },
        sessionCookieA
      );
      await httpRequest(
        port,
        "POST",
        "/api/logs",
        { type: "Force", text: "Séance Alpha", xp: 50, add_min: 20 },
        sessionCookieA
      );
      const oppResA = await httpRequest(
        port,
        "POST",
        "/api/opponents",
        { name: "Adversaire Secret Alpha", fide_elo: 2100 },
        sessionCookieA
      );
      const alphaOppId = oppResA.json.lastOpponent.id;
      await httpRequest(
        port,
        "POST",
        "/api/openings",
        { side: "Blancs", name: "Espagnole Alpha", moves: "1. e4 e5 2. Nf3 Nc6 3. Bb5" },
        sessionCookieA
      );

      // Connexion du Joueur B (PlayerBeta)
      const loginB = await httpRequest(port, "GET", "/api/auth/lichess/login");
      const locB = new URL(loginB.headers.location);
      const stateB = locB.searchParams.get("state");
      const pkceCookieB = extractCookieValue(loginB.headers["set-cookie"], PKCE_COOKIE_NAME);

      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u === "https://lichess.org/api/token") {
          return { ok: true, json: async () => ({ access_token: "lip_mock_beta_token" }) };
        }
        if (u === "https://lichess.org/api/account") {
          return {
            ok: true,
            json: async () => ({
              id: "playerbeta",
              username: "PlayerBeta",
              perfs: { rapid: { rating: 1720 } }
            })
          };
        }
        throw new Error("Unexpected fetch: " + u);
      };

      const cbB = await httpRequest(
        port,
        "GET",
        `/api/auth/lichess/callback?code=mock_code_b&state=${encodeURIComponent(stateB)}`,
        null,
        pkceCookieB
      );
      const sessionCookieB = extractCookieValue(cbB.headers["set-cookie"], SESSION_COOKIE_NAME);

      const stateBetaRes = await httpRequest(port, "GET", "/api/state", null, sessionCookieB);
      assert.strictEqual(stateBetaRes.status, 200);
      assert.strictEqual(stateBetaRes.json.user.username, "PlayerBeta");
      assert.strictEqual(stateBetaRes.json.settings.xp, "0");
      assert.strictEqual(stateBetaRes.json.logs.length, 0);
      assert.strictEqual(stateBetaRes.json.opponents.length, 0);
      assert.strictEqual(stateBetaRes.json.openingRepertoire.length, 0);
      assert.strictEqual(
        stateBetaRes.json.puzzles.filter((p) => p.solved === 1).length,
        0,
        "PlayerBeta démarre à 0 puzzle résolu"
      );

      // Tentative de suppression croisée par PlayerBeta sur l'adversaire de PlayerAlpha
      await httpRequest(
        port,
        "DELETE",
        `/api/opponents?id=${alphaOppId}`,
        null,
        sessionCookieB
      );

      const stateAlphaRes = await httpRequest(port, "GET", "/api/state", null, sessionCookieA);
      assert.strictEqual(stateAlphaRes.json.user.username, "PlayerAlpha");
      assert.strictEqual(stateAlphaRes.json.settings.xp, "50");
      assert.strictEqual(stateAlphaRes.json.opponents.length, 1);
      assert.strictEqual(stateAlphaRes.json.opponents[0].name, "Adversaire Secret Alpha");
      assert.strictEqual(stateAlphaRes.json.openingRepertoire.length, 1);
      assert.strictEqual(
        stateAlphaRes.json.puzzles.filter((p) => p.solved === 1).length,
        1
      );
      console.log("   ✅ Isolation multi-utilisateurs vérifiée à 100 % (données, FSRS, adversaires, ouvertures).");

      // 4. Déconnexion
      console.log("👉 Test 4 : Déconnexion (/api/auth/logout)...");
      const logoutRes = await httpRequest(port, "POST", "/api/auth/logout", {}, sessionCookieA);
      assert.strictEqual(logoutRes.status, 200);
      assert.strictEqual(logoutRes.json.authenticated, false);
      console.log("   ✅ Déconnexion propre validée.");
    } finally {
      server.close();
      globalThis.fetch = originalFetch;
    }

    console.log("==================================================================");
    console.log("🎉 TOUS LES TESTS DE L'ÉTAPE 8 ONT RÉUSSI À 100 % !");
    console.log("==================================================================");
  } finally {
    globalThis.fetch = originalFetch;
    try {
      getDbClient(TEST_DB_URL).close();
    } catch (_e) {}
    cleanupTestDb();
  }
}

runTests().catch((err) => {
  console.error("❌ ÉCHEC DES TESTS ÉTAPE 8 :", err);
  process.exit(1);
});
