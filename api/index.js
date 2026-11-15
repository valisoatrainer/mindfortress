/**
 * MIND FORTRESS — API Serverless Unifiée (Compatible Vercel Functions & Node.js HTTP)
 * Propulsée par SQLite Natif / libSQL (@libsql/client / Turso)
 */

const fs = require("fs");
const { URL } = require("url");
const { getDbClient, resolveLocalDbFilePath } = require("../db/client");
const { initDatabase, createBackup, recalculateStreak, getFullState } = require("../db/init");
const {
  reviewPuzzle,
  autoRateChessPuzzle,
  previewRatings,
  buildTrainingQueue,
  computeFSRSStats,
  WOODPECKER_CYCLES
} = require("../db/fsrs");
const {
  parsePgnGamesBatch,
  convertPositionToFsrsPuzzle,
  fetchLichessRemoteData
} = require("../db/lichess");
const { convertLichessPuzzle } = require("../db/lichessPuzzles");
const {
  parseOpeningLineMoves,
  parseOpponentReferencePgn,
  reviewOpeningLineFSRS
} = require("../db/scouting");
const { querySqlAnalytics } = require("../db/analytics");
const {
  SESSION_COOKIE_NAME,
  PKCE_COOKIE_NAME,
  LICHESS_CLIENT_ID,
  LICHESS_OAUTH_SCOPES,
  SESSION_MAX_AGE_SEC,
  PKCE_MAX_AGE_SEC,
  signToken,
  verifyToken,
  parseCookies,
  isHttpsRequest,
  buildCookieString,
  appendSetCookie,
  generatePkcePair,
  createSessionToken,
  getSessionFromRequest,
  resolveRequestOrigin,
  upsertLichessUser,
  saveUserLichessToken,
  getUserLichessToken
} = require("../db/auth");

let initializedForUrl = null;

async function ensureDbReady(customUrl) {
  const client = getDbClient(customUrl);
  if (initializedForUrl !== client.url) {
    await initDatabase(customUrl);
    createBackup(false, customUrl);
    initializedForUrl = client.url;
  }
  return client;
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(body);
}

function readJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === "string" && req.body.trim()) {
    return Promise.resolve(JSON.parse(req.body));
  }
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!raw || !raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function formatNowLabel() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `${dd}/${mm} · ${hh}:${min}`;
}

async function setUserSetting(client, userId, key, value) {
  await client.execute({
    sql: `INSERT INTO user_settings (user_id, key, value, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    args: [Number(userId), key, String(value)]
  });
}

async function getUserSetting(client, userId, key, fallback = null) {
  const res = await client.execute({
    sql: "SELECT value FROM user_settings WHERE user_id = ? AND key = ?",
    args: [Number(userId), key]
  });
  return res.rows && res.rows[0] ? res.rows[0].value : fallback;
}

async function apiHandler(req, res, customUrl = null) {
  if (req.method === "OPTIONS") {
    return sendJson(res, { ok: true }, 200);
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const rawPath = parsedUrl.searchParams.get("__path") || parsedUrl.pathname;
  const pathname = rawPath.replace(/\/+$/, "") || "/";

  try {
    const client = await ensureDbReady(customUrl);
    const secureCookie = isHttpsRequest(req);

    // ========================================================================
    // ROUTES PUBLIQUES D'AUTHENTIFICATION LICHESS (OAuth 2.0 PKCE)
    // ========================================================================
    if (req.method === "GET" && pathname === "/api/health") {
      return sendJson(res, { ok: true, auth: "lichess_oauth2_pkce_required" }, 200);
    }

    if (req.method === "GET" && pathname === "/api/auth/lichess/login") {
      const { codeVerifier, codeChallenge, state } = generatePkcePair();
      const pkceToken = signToken({
        state,
        codeVerifier,
        exp: Date.now() + PKCE_MAX_AGE_SEC * 1000
      });
      appendSetCookie(
        res,
        buildCookieString(PKCE_COOKIE_NAME, pkceToken, {
          maxAge: PKCE_MAX_AGE_SEC,
          secure: secureCookie
        })
      );

      const origin = resolveRequestOrigin(req);
      const redirectUri = `${origin}/api/auth/lichess/callback`;
      const lichessAuthUrl =
        `https://lichess.org/oauth?response_type=code` +
        `&client_id=${encodeURIComponent(LICHESS_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent(LICHESS_OAUTH_SCOPES)}` +
        `&code_challenge_method=S256` +
        `&code_challenge=${encodeURIComponent(codeChallenge)}` +
        `&state=${encodeURIComponent(state)}`;

      res.statusCode = 302;
      res.setHeader("Location", lichessAuthUrl);
      return res.end();
    }

    if (req.method === "GET" && pathname === "/api/auth/lichess/callback") {
      const errParam = parsedUrl.searchParams.get("error");
      if (errParam) {
        res.statusCode = 302;
        res.setHeader("Location", `/?auth_error=${encodeURIComponent(errParam)}`);
        return res.end();
      }

      const code = parsedUrl.searchParams.get("code");
      const state = parsedUrl.searchParams.get("state");
      const cookies = parseCookies(req);
      const pkcePayload = verifyToken(cookies[PKCE_COOKIE_NAME]);

      if (!code || !state || !pkcePayload || pkcePayload.state !== state || !pkcePayload.codeVerifier) {
        res.statusCode = 302;
        res.setHeader("Location", "/?auth_error=invalid_pkce_state");
        return res.end();
      }

      const origin = resolveRequestOrigin(req);
      const redirectUri = `${origin}/api/auth/lichess/callback`;

      const tokenRes = await fetch("https://lichess.org/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: pkcePayload.codeVerifier,
          redirect_uri: redirectUri,
          client_id: LICHESS_CLIENT_ID
        }).toString()
      });

      if (!tokenRes.ok) {
        res.statusCode = 302;
        res.setHeader("Location", "/?auth_error=lichess_token_failed");
        return res.end();
      }

      const tokenJson = await tokenRes.json();
      if (!tokenJson || !tokenJson.access_token) {
        res.statusCode = 302;
        res.setHeader("Location", "/?auth_error=lichess_missing_token");
        return res.end();
      }

      const accountRes = await fetch("https://lichess.org/api/account", {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` }
      });
      if (!accountRes.ok) {
        res.statusCode = 302;
        res.setHeader("Location", "/?auth_error=lichess_account_failed");
        return res.end();
      }

      const accountData = await accountRes.json();
      const user = await upsertLichessUser(client, accountData);
      await saveUserLichessToken(client, user.id, tokenJson.access_token);
      const sessionToken = createSessionToken(user);

      appendSetCookie(
        res,
        buildCookieString(PKCE_COOKIE_NAME, "", { maxAge: 0, secure: secureCookie })
      );
      appendSetCookie(
        res,
        buildCookieString(SESSION_COOKIE_NAME, sessionToken, {
          maxAge: SESSION_MAX_AGE_SEC,
          secure: secureCookie
        })
      );

      res.statusCode = 302;
      res.setHeader("Location", "/");
      return res.end();
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      appendSetCookie(
        res,
        buildCookieString(SESSION_COOKIE_NAME, "", { maxAge: 0, secure: secureCookie })
      );
      return sendJson(res, { ok: true, authenticated: false }, 200);
    }

    if (req.method === "GET" && pathname === "/api/auth/me") {
      const session = getSessionFromRequest(req);
      if (!session) {
        return sendJson(
          res,
          { ok: false, authenticated: false, code: "AUTH_REQUIRED", error: "Connexion Lichess obligatoire." },
          401
        );
      }
      const userRes = await client.execute({
        sql: "SELECT id, lichess_id, username, perfs_json FROM users WHERE id = ?",
        args: [session.userId]
      });
      const userRow = userRes.rows && userRes.rows[0];
      if (!userRow) {
        return sendJson(
          res,
          { ok: false, authenticated: false, code: "AUTH_REQUIRED", error: "Session invalide ou expirée." },
          401
        );
      }
      let perfs = {};
      try {
        if (userRow.perfs_json) perfs = JSON.parse(userRow.perfs_json);
      } catch (_e) {}
      const lichessToken = await getUserLichessToken(client, session.userId);
      return sendJson(
        res,
        {
          ok: true,
          authenticated: true,
          has_puzzle_scope: Boolean(lichessToken),
          user: {
            id: Number(userRow.id),
            lichess_id: userRow.lichess_id,
            username: userRow.username,
            perfs
          }
        },
        200
      );
    }

    // ========================================================================
    // GARDE D'AUTHENTIFICATION OBLIGATOIRE POUR TOUTES LES AUTRES ROUTES /api/*
    // ========================================================================
    const session = getSessionFromRequest(req);
    if (!session) {
      return sendJson(
        res,
        {
          ok: false,
          authenticated: false,
          code: "AUTH_REQUIRED",
          error: "Connexion Lichess obligatoire pour accéder à votre préparation."
        },
        401
      );
    }
    const userCheck = await client.execute({
      sql: "SELECT id, lichess_id, username FROM users WHERE id = ?",
      args: [session.userId]
    });
    if (!userCheck.rows || userCheck.rows.length === 0) {
      return sendJson(
        res,
        {
          ok: false,
          authenticated: false,
          code: "AUTH_REQUIRED",
          error: "Compte utilisateur introuvable, veuillez vous reconnecter avec Lichess."
        },
        401
      );
    }
    const userId = Number(session.userId);

    // ========================================================================
    // GET ROUTES
    // ========================================================================
    if (req.method === "GET") {
      if (pathname === "/api/state" || pathname === "/api") {
        const state = await getFullState(customUrl, userId);
        return sendJson(res, state, 200);
      }

      if (pathname === "/api/analytics") {
        const state = await getFullState(customUrl, userId);
        const sqlAggregations = await querySqlAnalytics(client, userId);
        return sendJson(
          res,
          {
            ok: true,
            advancedAnalytics: state.advancedAnalytics,
            sqlAggregations,
            chronobiologyReport: state.chronobiologyReport
          },
          200
        );
      }

      if (pathname === "/api/lichess/puzzle/next") {
        const angleParam = String(parsedUrl.searchParams.get("angle") || "mix").trim();
        const diffParam = String(parsedUrl.searchParams.get("difficulty") || "normal").trim();
        const lichessToken = await getUserLichessToken(client, userId);

        let targetUrl = "https://lichess.org/api/puzzle/next";
        if (angleParam === "daily") {
          targetUrl = "https://lichess.org/api/puzzle/daily";
        } else {
          const qs = new URLSearchParams();
          if (angleParam && angleParam !== "all" && angleParam !== "mix") {
            qs.set("angle", angleParam);
          }
          if (diffParam && ["easiest", "easier", "normal", "harder", "hardest"].includes(diffParam)) {
            qs.set("difficulty", diffParam);
          }
          const qsStr = qs.toString();
          if (qsStr) targetUrl += `?${qsStr}`;
        }

        const headers = { Accept: "application/json" };
        if (lichessToken) {
          headers.Authorization = `Bearer ${lichessToken}`;
        }

        let lRes = await fetch(targetUrl, { headers });
        let requiresReauth = !lichessToken;

        if ((lRes.status === 401 || lRes.status === 403) && lichessToken) {
          requiresReauth = true;
          lRes = await fetch("https://lichess.org/api/puzzle/daily", {
            headers: { Accept: "application/json" }
          });
        }

        if (!lRes.ok) {
          return sendJson(
            res,
            { ok: false, error: `Erreur API Lichess Puzzles (${lRes.status})`, requires_reauth: requiresReauth },
            502
          );
        }

        const rawPuzzle = await lRes.json();
        const converted = convertLichessPuzzle(rawPuzzle);
        return sendJson(
          res,
          {
            ok: true,
            puzzle: converted,
            has_puzzle_scope: Boolean(lichessToken) && !requiresReauth,
            requires_reauth: requiresReauth
          },
          200
        );
      }

      if (pathname === "/api/puzzles/due") {
        const state = await getFullState(customUrl, userId);
        const modeParam = parsedUrl.searchParams.get("mode") || state.settings.training_mode || "fsrs";
        const limitParam = Number(parsedUrl.searchParams.get("limit") || 67);
        const queue = buildTrainingQueue(state.puzzles, modeParam, new Date()).slice(0, limitParam);
        const stats = computeFSRSStats(state.puzzles, new Date());
        return sendJson(
          res,
          {
            mode: modeParam,
            woodpeckerCycle: Number(state.settings.woodpecker_cycle || 1),
            woodpeckerCyclesInfo: WOODPECKER_CYCLES,
            stats,
            queue
          },
          200
        );
      }

      if (pathname === "/api/db/download") {
        const localPath = resolveLocalDbFilePath(customUrl);
        if (localPath && fs.existsSync(localPath)) {
          const data = fs.readFileSync(localPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/x-sqlite3");
          res.setHeader("Content-Disposition", 'attachment; filename="mind_fortress.db"');
          res.setHeader("Content-Length", String(data.length));
          return res.end(data);
        }
        return sendJson(
          res,
          { error: "Base hébergée sur Turso Cloud ou fichier local introuvable." },
          404
        );
      }

      return sendJson(res, { error: `Route GET inconnue: ${pathname}` }, 404);
    }

    // ========================================================================
    // POST ROUTES
    // ========================================================================
    if (req.method === "POST") {
      const payload = await readJsonBody(req);

      if (pathname === "/api/settings") {
        for (const [k, v] of Object.entries(payload)) {
          const valStr = typeof v === "string" ? v : JSON.stringify(v);
          await setUserSetting(client, userId, k, valStr);
        }
        return sendJson(res, await getFullState(customUrl, userId), 200);
      }

      if (pathname === "/api/puzzles") {
        const code = payload.code || `PERSO-${Date.now() % 100000}`;
        const diff = Number(payload.diff || 3);
        const fsrsDifficulty = Math.min(10, Math.max(1, diff * 1.8));
        await client.execute({
          sql: `INSERT INTO puzzles (
                  code, title, fen, theme, type, diff, side, solution, solution_moves, hint,
                  custom, solved, attempts, box, fsrs_difficulty, user_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 1, ?, ?)`,
          args: [
            code,
            payload.title || "Puzzle perso",
            payload.fen || "",
            payload.theme || "fork",
            payload.type || "tactique",
            diff,
            payload.side || "Blancs",
            payload.solution || "Solution à compléter après résolution.",
            JSON.stringify(payload.solution_moves || []),
            payload.hint || "",
            fsrsDifficulty,
            userId
          ]
        });
        return sendJson(res, await getFullState(customUrl, userId), 200);
      }

      if (pathname === "/api/lichess/puzzle/complete") {
        const lichessId = String(payload.lichessId || payload.id || "").trim();
        const win = Boolean(payload.win);
        const rated = payload.rated !== false;
        const angle = String(payload.angle || "mix").trim() || "mix";
        if (!lichessId) {
          return sendJson(res, { error: "lichessId requis" }, 400);
        }
        const lichessToken = await getUserLichessToken(client, userId);
        if (!lichessToken) {
          return sendJson(res, { ok: true, synced: false, requires_reauth: true }, 200);
        }
        const batchUrl = `https://lichess.org/api/puzzle/batch/${encodeURIComponent(angle === "daily" || angle === "all" ? "mix" : angle)}`;
        const lRes = await fetch(batchUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${lichessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify({
            solutions: [{ id: lichessId, win, rated }]
          })
        });
        let lBody = null;
        try {
          lBody = await lRes.json();
        } catch (_e) {}
        return sendJson(
          res,
          {
            ok: true,
            synced: lRes.ok,
            status: lRes.status,
            requires_reauth: lRes.status === 401 || lRes.status === 403,
            lichessResponse: lBody
          },
          200
        );
      }

      if (pathname === "/api/lichess/puzzle/save") {
        const lichessId = String(payload.lichessId || "").trim();
        if (!lichessId || !payload.fen) {
          return sendJson(res, { error: "lichessId et fen requis pour sauvegarder ce puzzle." }, 400);
        }
        const code = `LICHESS-${lichessId}-U${userId}`;
        const diff = Math.min(5, Math.max(1, Number(payload.diff || 3)));
        const fsrsDifficulty = Math.min(10, Math.max(1, diff * 1.8));
        await client.execute({
          sql: `INSERT OR IGNORE INTO puzzles (
                  code, title, fen, theme, type, diff, side, solution, solution_moves, hint,
                  custom, solved, attempts, box, fsrs_difficulty, user_id
                ) VALUES (?, ?, ?, ?, 'tactique', ?, ?, ?, ?, ?, 1, 0, 0, 1, ?, ?)`,
          args: [
            code,
            payload.title || `Lichess #${lichessId}`,
            payload.fen,
            payload.theme || "fork",
            diff,
            payload.side || "Blancs",
            payload.solution || "",
            JSON.stringify(Array.isArray(payload.solution_moves) ? payload.solution_moves : []),
            payload.hint || "",
            fsrsDifficulty,
            userId
          ]
        });
        const insertedRes = await client.execute({
          sql: "SELECT id FROM puzzles WHERE code = ? AND user_id = ?",
          args: [code, userId]
        });
        const savedId = insertedRes.rows[0]?.id ? Number(insertedRes.rows[0].id) : null;
        if (savedId) {
          await client.execute({
            sql: `INSERT OR IGNORE INTO user_puzzle_progress (user_id, puzzle_id, box, fsrs_difficulty)
                  VALUES (?, ?, 1, ?)`,
            args: [userId, savedId, fsrsDifficulty]
          });
        }
        const fullState = await getFullState(customUrl, userId);
        return sendJson(res, { ...fullState, saved: true, savedPuzzleId: savedId }, 200);
      }

      if (pathname === "/api/puzzles/solve") {
        const pid = Number(payload.id);
        const success = payload.success !== false ? 1 : 0;
        const timeSec = Number(payload.time_sec || 0);
        const hadMistake = Boolean(payload.had_mistake);
        const hintUsed = Boolean(payload.hint_used);

        const rowRes = await client.execute({
          sql: `SELECT
                  p.id, p.diff, p.user_id,
                  COALESCE(upp.solved, 0) AS solved,
                  COALESCE(upp.attempts, 0) AS attempts,
                  COALESCE(upp.best_time_sec, 0) AS best_time_sec,
                  COALESCE(upp.box, 1) AS box,
                  COALESCE(upp.fsrs_state, 0) AS fsrs_state,
                  COALESCE(upp.fsrs_stability, 0.0) AS fsrs_stability,
                  COALESCE(upp.fsrs_difficulty, MIN(10.0, MAX(1.0, p.diff * 1.8))) AS fsrs_difficulty,
                  COALESCE(upp.fsrs_elapsed_days, 0) AS fsrs_elapsed_days,
                  COALESCE(upp.fsrs_scheduled_days, 0) AS fsrs_scheduled_days,
                  COALESCE(upp.fsrs_reps, 0) AS fsrs_reps,
                  COALESCE(upp.fsrs_lapses, 0) AS fsrs_lapses,
                  upp.fsrs_last_review AS fsrs_last_review,
                  upp.fsrs_due_date AS fsrs_due_date,
                  COALESCE(upp.woodpecker_cycle, 1) AS woodpecker_cycle
                FROM puzzles p
                LEFT JOIN user_puzzle_progress upp ON upp.puzzle_id = p.id AND upp.user_id = ?
                WHERE p.id = ? AND (p.custom = 0 OR p.user_id = ?)`,
          args: [userId, pid, userId]
        });
        const row = rowRes.rows && rowRes.rows[0];
        let fsrsUpdate = null;

        if (row) {
          const retVal = await getUserSetting(client, userId, "fsrs_request_retention", "0.9");
          const requestRetention = Number(retVal || 0.9);

          const rating = payload.rating
            ? Number(payload.rating)
            : autoRateChessPuzzle({
                success: Boolean(success),
                hadMistake,
                timeSec,
                diff: Number(row.diff || 2),
                hintUsed
              });

          fsrsUpdate = reviewPuzzle(row, rating, new Date(), requestRetention);

          const newAttempts = Number(row.attempts || 0) + 1;
          const newSolved = row.solved || fsrsUpdate.solved ? 1 : 0;
          let bestTime = Number(row.best_time_sec || 0);
          if (fsrsUpdate.solved && timeSec > 0 && (bestTime === 0 || timeSec < bestTime)) {
            bestTime = timeSec;
          }

          await client.execute({
            sql: `INSERT INTO user_puzzle_progress (
                    user_id, puzzle_id, solved, attempts, best_time_sec, box,
                    fsrs_state, fsrs_stability, fsrs_difficulty, fsrs_elapsed_days,
                    fsrs_scheduled_days, fsrs_reps, fsrs_lapses, fsrs_last_review, fsrs_due_date, woodpecker_cycle
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(user_id, puzzle_id) DO UPDATE SET
                    solved = excluded.solved,
                    attempts = excluded.attempts,
                    best_time_sec = excluded.best_time_sec,
                    box = excluded.box,
                    fsrs_state = excluded.fsrs_state,
                    fsrs_stability = excluded.fsrs_stability,
                    fsrs_difficulty = excluded.fsrs_difficulty,
                    fsrs_elapsed_days = excluded.fsrs_elapsed_days,
                    fsrs_scheduled_days = excluded.fsrs_scheduled_days,
                    fsrs_reps = excluded.fsrs_reps,
                    fsrs_lapses = excluded.fsrs_lapses,
                    fsrs_last_review = excluded.fsrs_last_review,
                    fsrs_due_date = excluded.fsrs_due_date`,
            args: [
              userId,
              pid,
              newSolved,
              newAttempts,
              bestTime,
              fsrsUpdate.box,
              fsrsUpdate.fsrs_state,
              fsrsUpdate.fsrs_stability,
              fsrsUpdate.fsrs_difficulty,
              fsrsUpdate.fsrs_elapsed_days,
              fsrsUpdate.fsrs_scheduled_days,
              fsrsUpdate.fsrs_reps,
              fsrsUpdate.fsrs_lapses,
              fsrsUpdate.fsrs_last_review,
              fsrsUpdate.fsrs_due_date,
              Number(row.woodpecker_cycle || 1)
            ]
          });

          // Enregistrement dans le journal mathématique FSRS (fsrs_review_logs)
          await client.execute({
            sql: `INSERT INTO fsrs_review_logs (
                    user_id, puzzle_id, rating, state, elapsed_days, scheduled_days,
                    solve_time_sec, stability, difficulty, reviewed_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              userId,
              pid,
              fsrsUpdate.rating,
              fsrsUpdate.fsrs_state,
              Math.round(fsrsUpdate.fsrs_elapsed_days),
              fsrsUpdate.fsrs_scheduled_days,
              timeSec,
              fsrsUpdate.fsrs_stability,
              fsrsUpdate.fsrs_difficulty,
              fsrsUpdate.fsrs_last_review
            ]
          });
        }

        const updatedState = await getFullState(customUrl, userId);
        updatedState.lastFsrsReview = fsrsUpdate;
        return sendJson(res, updatedState, 200);
      }

      if (pathname === "/api/woodpecker/cycle") {
        const nextCycle = Math.min(5, Math.max(1, Number(payload.cycle || 1)));
        await setUserSetting(client, userId, "woodpecker_cycle", String(nextCycle));
        await client.execute({
          sql: `INSERT INTO user_puzzle_progress (user_id, puzzle_id, woodpecker_cycle, solved)
                SELECT ?, id, ?, 0 FROM puzzles WHERE custom = 0 OR user_id = ?
                ON CONFLICT(user_id, puzzle_id) DO UPDATE SET
                  woodpecker_cycle = excluded.woodpecker_cycle${payload.reset_cycle_solved ? ", solved = 0" : ""}`,
          args: [userId, nextCycle, userId]
        });
        return sendJson(res, await getFullState(customUrl, userId), 200);
      }

      if (pathname === "/api/endurance") {
        const nowIso = new Date().toISOString();
        const atLabel = formatNowLabel();
        const existingJson = await getUserSetting(client, userId, "endurance_sessions_json", "[]");
        let sessions = [];
        try {
          if (existingJson) {
            sessions = JSON.parse(existingJson);
          }
        } catch (_e) {}

        const newSession = {
          id: Date.now(),
          created_at: nowIso,
          at_label: atLabel,
          scenario_id: payload.scenario_id || "scenario_a",
          scenario_title: payload.scenario_title || "Endurance FIDE",
          initial_sec: Number(payload.initial_sec || 3900),
          remaining_sec: Number(payload.remaining_sec || 0),
          increment_sec: Number(payload.increment_sec || 30),
          moves_played: Number(payload.moves_played || 0),
          increments_added_sec: Number(payload.increments_added_sec || 0),
          candidate_moves: Array.isArray(payload.candidate_moves) ? payload.candidate_moves : [],
          distraction_returns: Number(payload.distraction_returns || 0),
          flagged: Boolean(payload.flagged),
          notes: payload.notes || ""
        };

        sessions.unshift(newSession);
        sessions = sessions.slice(0, 100);

        await setUserSetting(client, userId, "endurance_sessions_json", JSON.stringify(sessions));
        await setUserSetting(client, userId, "endurance_notes", String(payload.notes || ""));
        await setUserSetting(client, userId, "distraction_returns", String(newSession.distraction_returns));

        const updatedState = await getFullState(customUrl, userId);
        updatedState.lastEnduranceSession = newSession;
        return sendJson(res, updatedState, 200);
      }

      if (pathname === "/api/logs") {
        const nowIso = new Date().toISOString();
        const atLabel = payload.at_label || formatNowLabel();
        const createdAt = payload.created_at || nowIso;
        const xpGain = Number(payload.xp || 0);
        const addMin = Number(payload.add_min || 0);
        const markToday = payload.mark_today !== false;

        await client.execute({
          sql: `INSERT INTO logs (
                  user_id, at_label, created_at, type, puzzle_id, text, theme, diff,
                  time_sec, success, xp, emotion, intensity, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            userId,
            atLabel,
            createdAt,
            payload.type || "Force",
            payload.puzzle_id || null,
            payload.text || "Séance validée",
            payload.theme || "fork",
            Number(payload.diff || 2),
            Number(payload.time_sec || 0),
            payload.success !== false ? 1 : 0,
            xpGain,
            payload.emotion || "calme",
            Number(payload.intensity || 3),
            payload.notes || ""
          ]
        });

        // Mise à jour XP
        const curXp = Number(await getUserSetting(client, userId, "xp", "0"));
        await setUserSetting(client, userId, "xp", String(curXp + xpGain));

        // Mise à jour minutes totales
        if (addMin > 0) {
          const curMin = Number(await getUserSetting(client, userId, "total_min", "0"));
          await setUserSetting(client, userId, "total_min", String(curMin + addMin));
        }

        // Mise à jour compteur d'essais / réussites
        if (payload.increment_attempts) {
          const curAtt = Number(await getUserSetting(client, userId, "attempts", "0"));
          await setUserSetting(client, userId, "attempts", String(curAtt + 1));
          if (payload.success !== false) {
            const curSol = Number(await getUserSetting(client, userId, "solved_count", "0"));
            await setUserSetting(client, userId, "solved_count", String(curSol + 1));
          }
        }

        if (markToday) {
          const todayKey = new Date().toISOString().slice(0, 10);
          await client.execute({
            sql: "INSERT OR IGNORE INTO user_completed_days (user_id, day_key, status, sessions_count) VALUES (?, ?, 'done', 1)",
            args: [userId, todayKey]
          });
        }

        await recalculateStreak(client, userId);
        return sendJson(res, await getFullState(customUrl, userId), 200);
      }

      if (pathname === "/api/journal") {
        const nowIso = new Date().toISOString();
        await client.execute({
          sql: `INSERT INTO contextual_journal (
                  user_id, log_id, linked_text, created_at, at_label, note,
                  before_emotion, after_emotion, before_intensity, after_intensity,
                  lieu, bruit, sommeil, fatigue, pression, tag
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            userId,
            payload.logId || null,
            payload.linkedText || "Séance libre — hors log",
            payload.createdAt || nowIso,
            payload.atLabel || formatNowLabel(),
            payload.note || "",
            payload.beforeEmotion || "stress",
            payload.afterEmotion || "calme",
            Number(payload.beforeIntensity || 3),
            Number(payload.afterIntensity || 2),
            payload.lieu || "Maison",
            payload.bruit || "Calme",
            payload.sommeil || "Bon",
            Number(payload.fatigue || 2),
            payload.pression || "Entraînement",
            payload.tag || ""
          ]
        });
        return sendJson(res, await getFullState(customUrl, userId), 200);
      }

      if (pathname === "/api/days/toggle") {
        const dayKey = payload.day_key;
        if (dayKey) {
          const checkRes = await client.execute({
            sql: "SELECT day_key FROM user_completed_days WHERE user_id = ? AND day_key = ?",
            args: [userId, dayKey]
          });
          if (checkRes.rows && checkRes.rows.length > 0) {
            await client.execute({
              sql: "DELETE FROM user_completed_days WHERE user_id = ? AND day_key = ?",
              args: [userId, dayKey]
            });
          } else {
            await client.execute({
              sql: "INSERT INTO user_completed_days (user_id, day_key, status, sessions_count) VALUES (?, ?, 'done', 1)",
              args: [userId, dayKey]
            });
          }
          await recalculateStreak(client, userId);
        }
        return sendJson(res, await getFullState(customUrl, userId), 200);
      }

      if (pathname === "/api/blindage") {
        await client.execute({
          sql: `INSERT INTO blindage_entries (
                  user_id, created_at, wish, outcome, obstacle, plan,
                  col1, col2, col3, mode, breathing_cycles
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            userId,
            new Date().toISOString(),
            payload.wish || "",
            payload.outcome || "",
            payload.obstacle || "",
            payload.plan || "",
            payload.col1 || "",
            payload.col2 || "",
            payload.col3 || "",
            payload.mode || "daily",
            Number(payload.breathing_cycles || 0)
          ]
        });
        return sendJson(res, await getFullState(customUrl, userId), 200);
      }

      if (pathname === "/api/backup") {
        const fname = createBackup(true, customUrl);
        const state = await getFullState(customUrl, userId);
        state.backupCreated = fname;
        return sendJson(res, state, 200);
      }

      if (pathname === "/api/import-json") {
        if ("level" in payload) await setUserSetting(client, userId, "level", String(payload.level));
        if ("xp" in payload) await setUserSetting(client, userId, "xp", String(payload.xp));
        if ("totalMin" in payload) await setUserSetting(client, userId, "total_min", String(payload.totalMin));
        if ("lichessUsername" in payload) await setUserSetting(client, userId, "lichess_username", String(payload.lichessUsername));
        if (payload.woop && typeof payload.woop === "object") {
          await setUserSetting(client, userId, "woop_json", JSON.stringify(payload.woop));
        }
        if (payload.journal && typeof payload.journal === "object") {
          await setUserSetting(client, userId, "journal_3col_json", JSON.stringify(payload.journal));
        }
        if (Array.isArray(payload.completedDays)) {
          for (const dk of payload.completedDays) {
            await client.execute({
              sql: "INSERT OR IGNORE INTO user_completed_days (user_id, day_key) VALUES (?, ?)",
              args: [userId, String(dk).slice(0, 10)]
            });
          }
        }
        if (Array.isArray(payload.customPuzzles)) {
          for (const cp of payload.customPuzzles) {
            await client.execute({
              sql: `INSERT OR IGNORE INTO puzzles (code, title, fen, theme, type, diff, side, solution, custom, solved, user_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
              args: [
                cp.code || `IMPORT-${Date.now() % 100000}`,
                cp.title || cp.description || "Puzzle importé",
                cp.fen || "",
                cp.theme || "fork",
                cp.type || "tactique",
                Number(cp.diff || cp.difficulty || 3),
                cp.side || "Blancs",
                cp.solution || "",
                userId
              ]
            });
          }
        }
        if (Array.isArray(payload.journalContextuel)) {
          for (const cj of payload.journalContextuel) {
            await client.execute({
              sql: `INSERT INTO contextual_journal (
                      user_id, log_id, linked_text, created_at, at_label, note,
                      before_emotion, after_emotion, before_intensity, after_intensity,
                      lieu, bruit, sommeil, fatigue, pression, tag
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              args: [
                userId,
                cj.logId || null,
                cj.linkedText || "Séance importée",
                cj.createdAt || new Date().toISOString(),
                cj.atLabel || "Importé",
                cj.note || "",
                cj.beforeEmotion || "stress",
                cj.afterEmotion || "calme",
                Number(cj.beforeIntensity || 3),
                Number(cj.afterIntensity || 2),
                cj.lieu || "Maison",
                cj.bruit || "Calme",
                cj.sommeil || "Bon",
                Number(cj.fatigue || 2),
                cj.pression || "Entraînement",
                cj.tag || ""
              ]
            });
          }
        }
        await recalculateStreak(client, userId);
        return sendJson(res, await getFullState(customUrl, userId), 200);
      }

      if (pathname === "/api/lichess/sync") {
        let username = String(payload.username || "").trim();
        if (!username) {
          username = String(await getUserSetting(client, userId, "lichess_username", "") || session.username || "").trim();
        } else {
          await setUserSetting(client, userId, "lichess_username", username);
        }

        let effectivePgn = String(payload.raw_pgn || "").trim();
        let profileData = payload.profile && typeof payload.profile === "object" ? payload.profile : null;

        if (!effectivePgn && username) {
          const remote = await fetchLichessRemoteData(username, Number(payload.max_games || 10));
          if (remote.rawPgn) effectivePgn = remote.rawPgn;
          if (!profileData && remote.profile) profileData = remote.profile;
        }

        if (profileData) {
          await setUserSetting(client, userId, "lichess_profile_json", JSON.stringify(profileData));
        }

        const beforeCountRes = await client.execute({
          sql: "SELECT COUNT(*) AS c FROM user_lichess_games WHERE user_id = ?",
          args: [userId]
        });
        const beforeCount = Number(beforeCountRes.rows[0]?.c || 0);

        const parsedGames = effectivePgn ? parsePgnGamesBatch(effectivePgn, username) : [];
        for (const g of parsedGames) {
          await client.execute({
            sql: `INSERT OR IGNORE INTO user_lichess_games (
                    user_id, game_id, white, black, result, speed, played_at, pgn, hour_of_day,
                    opening, critical_fen, critical_move_san, critical_solution_moves,
                    critical_side, critical_move_number
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              userId,
              g.id,
              g.white,
              g.black,
              g.result,
              g.speed,
              g.played_at,
              g.pgn,
              Number(g.hour_of_day ?? 14),
              g.opening || "Ouverture Classique",
              g.critical_fen || "",
              g.critical_move_san || "",
              JSON.stringify(g.critical_solution_moves || []),
              g.critical_side || "Blancs",
              Number(g.critical_move_number || 15)
            ]
          });
        }

        const afterCountRes = await client.execute({
          sql: "SELECT COUNT(*) AS c FROM user_lichess_games WHERE user_id = ?",
          args: [userId]
        });
        const afterCount = Number(afterCountRes.rows[0]?.c || 0);
        const insertedCount = Math.max(0, afterCount - beforeCount);

        const updatedState = await getFullState(customUrl, userId);
        updatedState.syncReport = {
          username,
          parsedCount: parsedGames.length,
          insertedCount,
          duplicatesSkipped: Math.max(0, parsedGames.length - insertedCount),
          totalInDb: afterCount
        };
        return sendJson(res, updatedState, 200);
      }

      if (pathname === "/api/lichess/to-puzzle") {
        let pzInput = { ...payload };

        if (payload.game_id) {
          const gRes = await client.execute({
            sql: "SELECT game_id AS id, white, black, result, speed, played_at, pgn, hour_of_day, opening, critical_fen, critical_move_san, critical_solution_moves, critical_side, critical_move_number FROM user_lichess_games WHERE user_id = ? AND game_id = ?",
            args: [userId, String(payload.game_id)]
          });
          const gRow = gRes.rows && gRes.rows[0];
          if (!gRow) {
            return sendJson(res, { error: `Partie Lichess introuvable: ${payload.game_id}` }, 404);
          }

          let critFen = gRow.critical_fen;
          let critMoves = [];
          try {
            critMoves =
              typeof gRow.critical_solution_moves === "string"
                ? JSON.parse(gRow.critical_solution_moves)
                : gRow.critical_solution_moves || [];
          } catch (_e) {}

          if (!critFen && gRow.pgn) {
            const parsed = parsePgnGamesBatch(gRow.pgn, "");
            if (parsed[0]) {
              critFen = parsed[0].critical_fen;
              critMoves = parsed[0].critical_solution_moves;
            }
          }

          pzInput = {
            gameId: gRow.id,
            white: gRow.white,
            black: gRow.black,
            fen: payload.fen || critFen,
            solution_moves: payload.solution_moves || critMoves,
            moveNumber: payload.moveNumber || gRow.critical_move_number || 15,
            theme: payload.theme || "middlegame",
            diff: payload.diff || 3,
            title:
              payload.title ||
              `Gaffe / Moment clé · ${gRow.white} vs ${gRow.black} (${gRow.opening || gRow.speed || "Lichess"})`,
            hint:
              payload.hint ||
              `Extrait de la partie ${gRow.white} vs ${gRow.black} (${gRow.played_at || "Lichess"}).`
          };
        }

        const builtPuzzle = convertPositionToFsrsPuzzle(pzInput);

        const insRes = await client.execute({
          sql: `INSERT INTO puzzles (
                  code, title, fen, theme, type, diff, side, solution, solution_moves, hint,
                  custom, solved, attempts, box, fsrs_state, fsrs_stability, fsrs_difficulty, user_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 1, 0, 0.0, ?, ?)`,
          args: [
            `${builtPuzzle.code}-U${userId}`,
            builtPuzzle.title,
            builtPuzzle.fen,
            builtPuzzle.theme,
            builtPuzzle.type,
            builtPuzzle.diff,
            builtPuzzle.side,
            builtPuzzle.solution,
            JSON.stringify(builtPuzzle.solution_moves || []),
            builtPuzzle.hint,
            builtPuzzle.fsrs_difficulty,
            userId
          ]
        });

        const updatedState = await getFullState(customUrl, userId);
        updatedState.createdPuzzle = {
          ...builtPuzzle,
          id: Number(insRes.lastInsertRowid || 0)
        };
        return sendJson(res, updatedState, 200);
      }

      if (pathname === "/api/opponents") {
        const name = String(payload.name || "").trim();
        if (!name) {
          return sendJson(res, { error: "Le nom de l'adversaire est obligatoire." }, 400);
        }

        const fideElo = payload.fide_elo ? Number(payload.fide_elo) : null;
        const lichessUsername = String(payload.lichess_username || "").trim();
        const style = String(payload.style || "Solide / Positionnel").trim();
        const psychProfile = String(payload.psych_profile || "").trim();
        const whiteRep = String(payload.white_repertoire || "").trim();
        const blackRep = String(payload.black_repertoire || "").trim();
        const refPgn = String(payload.reference_pgn || "").trim();
        const matchPlan = String(payload.match_plan || "").trim();

        let opponentId = payload.id ? Number(payload.id) : null;
        if (opponentId) {
          await client.execute({
            sql: `UPDATE opponents
                  SET name = ?, fide_elo = ?, lichess_username = ?, style = ?,
                      psych_profile = ?, white_repertoire = ?, black_repertoire = ?,
                      reference_pgn = ?, match_plan = ?, updated_at = CURRENT_TIMESTAMP
                  WHERE id = ? AND user_id = ?`,
            args: [
              name,
              fideElo,
              lichessUsername,
              style,
              psychProfile,
              whiteRep,
              blackRep,
              refPgn,
              matchPlan,
              opponentId,
              userId
            ]
          });
        } else {
          const insOpp = await client.execute({
            sql: `INSERT INTO opponents (
                    user_id, name, fide_elo, lichess_username, style, psych_profile,
                    white_repertoire, black_repertoire, reference_pgn, match_plan
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              userId,
              name,
              fideElo,
              lichessUsername,
              style,
              psychProfile,
              whiteRep,
              blackRep,
              refPgn,
              matchPlan
            ]
          });
          opponentId = Number(insOpp.lastInsertRowid || 0);
        }

        const updatedState = await getFullState(customUrl, userId);
        updatedState.lastOpponent = updatedState.opponents.find((o) => o.id === opponentId) || null;
        return sendJson(res, updatedState, 200);
      }

      if (pathname === "/api/openings") {
        const name = String(payload.name || "").trim();
        const movesText = String(payload.moves || "").trim();
        if (!name || !movesText) {
          return sendJson(
            res,
            { error: "Le nom et la séquence de coups de l'ouverture sont obligatoires." },
            400
          );
        }

        const startFen = String(payload.start_fen || "start").trim();
        const parsedLine = parseOpeningLineMoves(movesText, startFen);
        if (!parsedLine.valid) {
          return sendJson(
            res,
            { error: parsedLine.error || "Séquence de coups d'ouverture illégale sur ValisoaChessLite." },
            400
          );
        }

        const side = payload.side === "Noirs" ? "Noirs" : "Blancs";
        const eco = String(payload.eco || "").trim();
        const plan = String(payload.plan || "").trim();
        const mastery = Math.min(100, Math.max(0, Number(payload.mastery ?? 60)));
        const sanMovesJson = JSON.stringify(parsedLine.sanMoves);
        const finalFen = parsedLine.finalFen;

        let lineId = payload.id ? Number(payload.id) : null;
        if (lineId) {
          await client.execute({
            sql: `UPDATE opening_repertoire
                  SET side = ?, name = ?, eco = ?, moves = ?, plan = ?, start_fen = ?,
                      mastery = ?, san_moves_json = ?, final_fen = ?, updated_at = CURRENT_TIMESTAMP
                  WHERE id = ? AND user_id = ?`,
            args: [
              side,
              name,
              eco,
              movesText,
              plan,
              startFen,
              mastery,
              sanMovesJson,
              finalFen,
              lineId,
              userId
            ]
          });
        } else {
          const insLine = await client.execute({
            sql: `INSERT INTO opening_repertoire (
                    user_id, side, name, eco, moves, plan, start_fen, mastery, san_moves_json, final_fen
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [userId, side, name, eco, movesText, plan, startFen, mastery, sanMovesJson, finalFen]
          });
          lineId = Number(insLine.lastInsertRowid || 0);
        }

        const updatedState = await getFullState(customUrl, userId);
        updatedState.lastOpeningLine =
          updatedState.openingRepertoire.find((l) => l.id === lineId) || null;
        return sendJson(res, updatedState, 200);
      }

      if (pathname === "/api/openings/review") {
        const lineId = Number(payload.id);
        const rating = Number(payload.rating || 3);
        const rowRes = await client.execute({
          sql: "SELECT * FROM opening_repertoire WHERE id = ? AND user_id = ?",
          args: [lineId, userId]
        });
        const row = rowRes.rows && rowRes.rows[0];
        if (!row) {
          return sendJson(res, { error: `Ligne d'ouverture introuvable: ${lineId}` }, 404);
        }

        const rev = reviewOpeningLineFSRS(row, rating, new Date());
        await client.execute({
          sql: `UPDATE opening_repertoire
                SET mastery = ?,
                    fsrs_state = ?,
                    fsrs_stability = ?,
                    fsrs_difficulty = ?,
                    fsrs_reps = ?,
                    fsrs_lapses = ?,
                    fsrs_last_review = ?,
                    fsrs_due_date = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND user_id = ?`,
          args: [
            rev.mastery,
            rev.fsrs_state,
            rev.fsrs_stability,
            rev.fsrs_difficulty,
            rev.fsrs_reps,
            rev.fsrs_lapses,
            rev.fsrs_last_review,
            rev.fsrs_due_date,
            lineId,
            userId
          ]
        });

        const updatedState = await getFullState(customUrl, userId);
        updatedState.lastOpeningReview = rev;
        return sendJson(res, updatedState, 200);
      }

      if (pathname === "/api/reset") {
        createBackup(true, customUrl);
        await client.batch([
          { sql: "DELETE FROM contextual_journal WHERE user_id = ?", args: [userId] },
          { sql: "DELETE FROM logs WHERE user_id = ?", args: [userId] },
          { sql: "DELETE FROM user_completed_days WHERE user_id = ?", args: [userId] },
          { sql: "DELETE FROM blindage_entries WHERE user_id = ?", args: [userId] },
          { sql: "DELETE FROM fsrs_review_logs WHERE user_id = ?", args: [userId] },
          { sql: "DELETE FROM user_lichess_games WHERE user_id = ?", args: [userId] },
          { sql: "DELETE FROM opponents WHERE user_id = ?", args: [userId] },
          { sql: "DELETE FROM opening_repertoire WHERE user_id = ?", args: [userId] },
          { sql: "DELETE FROM user_puzzle_progress WHERE user_id = ?", args: [userId] },
          { sql: "DELETE FROM puzzles WHERE custom = 1 AND user_id = ?", args: [userId] },
          { sql: "INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, 'xp', '0')", args: [userId] },
          { sql: "INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, 'streak', '0')", args: [userId] },
          { sql: "INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, 'total_min', '0')", args: [userId] },
          { sql: "INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, 'attempts', '0')", args: [userId] },
          { sql: "INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, 'solved_count', '0')", args: [userId] },
          { sql: "INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, 'endurance_sessions_json', '[]')", args: [userId] },
          { sql: "INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, 'lichess_profile_json', 'null')", args: [userId] }
        ]);
        return sendJson(res, await getFullState(customUrl, userId), 200);
      }

      return sendJson(res, { error: `Route POST inconnue: ${pathname}` }, 404);
    }

    // ========================================================================
    // DELETE ROUTES
    // ========================================================================
    if (req.method === "DELETE") {
      const idParam = parsedUrl.searchParams.get("id");
      if (idParam) {
        const idNum = Number(idParam);
        if (pathname === "/api/journal") {
          await client.execute({
            sql: "DELETE FROM contextual_journal WHERE id = ? AND user_id = ?",
            args: [idNum, userId]
          });
        } else if (pathname === "/api/logs") {
          await client.execute({
            sql: "DELETE FROM logs WHERE id = ? AND user_id = ?",
            args: [idNum, userId]
          });
        } else if (pathname === "/api/puzzles") {
          await client.execute({
            sql: "DELETE FROM puzzles WHERE id = ? AND custom = 1 AND user_id = ?",
            args: [idNum, userId]
          });
        } else if (pathname === "/api/lichess") {
          await client.execute({
            sql: "DELETE FROM user_lichess_games WHERE game_id = ? AND user_id = ?",
            args: [String(idParam), userId]
          });
        } else if (pathname === "/api/opponents") {
          await client.execute({
            sql: "DELETE FROM opponents WHERE id = ? AND user_id = ?",
            args: [idNum, userId]
          });
        } else if (pathname === "/api/openings") {
          await client.execute({
            sql: "DELETE FROM opening_repertoire WHERE id = ? AND user_id = ?",
            args: [idNum, userId]
          });
        }
      }
      return sendJson(res, await getFullState(customUrl, userId), 200);
    }

    return sendJson(res, { error: `Méthode non supportée: ${req.method}` }, 405);
  } catch (err) {
    console.error("[MIND FORTRESS API ERROR]", err);
    return sendJson(res, { error: err.message || String(err) }, 500);
  }
}

module.exports = apiHandler;
