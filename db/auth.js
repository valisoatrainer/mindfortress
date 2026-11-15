/**
 * MIND FORTRESS — Authentification OAuth 2.0 PKCE via Lichess & Sessions Signées
 * Chaque joueur dispose de sa propre préparation isolée par user_id dans SQLite / Turso.
 */

const crypto = require("crypto");

const SESSION_COOKIE_NAME = "mf_session";
const PKCE_COOKIE_NAME = "mf_oauth_pkce";
const LICHESS_CLIENT_ID = process.env.LICHESS_CLIENT_ID || "mind-fortress";
const LICHESS_OAUTH_SCOPES = "preference:read puzzle:read puzzle:write";
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 jours
const PKCE_MAX_AGE_SEC = 60 * 10; // 10 minutes

let warnedMissingSecret = false;

function getAuthSecret() {
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 16) {
    return process.env.AUTH_SECRET;
  }
  if (process.env.TURSO_AUTH_TOKEN && process.env.TURSO_AUTH_TOKEN.length >= 16) {
    return crypto.createHash("sha256").update("mf-auth:" + process.env.TURSO_AUTH_TOKEN).digest("hex");
  }
  if (process.env.VERCEL && !warnedMissingSecret) {
    warnedMissingSecret = true;
    console.warn("[MIND FORTRESS] AUTH_SECRET non défini en production : utilisez une variable d'environnement AUTH_SECRET dédiée.");
  }
  return "mind-fortress-local-dev-secret-2027";
}

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecodeToBuffer(str) {
  const padded = String(str).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(str).length + 3) % 4);
  return Buffer.from(padded, "base64");
}

function signToken(payloadObj) {
  const data = base64UrlEncode(JSON.stringify(payloadObj));
  const sig = base64UrlEncode(crypto.createHmac("sha256", getAuthSecret()).update(data).digest());
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  if (!data || !sig) return null;

  const expectedSig = base64UrlEncode(crypto.createHmac("sha256", getAuthSecret()).update(data).digest());
  const sigBuf = Buffer.from(sig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const payload = JSON.parse(base64UrlDecodeToBuffer(data).toString("utf8"));
    if (payload.exp && Date.now() > Number(payload.exp)) {
      return null;
    }
    return payload;
  } catch (_e) {
    return null;
  }
}

function parseCookies(req) {
  const header = req && req.headers ? req.headers.cookie || "" : "";
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch (_e) {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

function isHttpsRequest(req) {
  if (!req || !req.headers) return Boolean(process.env.VERCEL);
  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  if (proto === "https") return true;
  if (req.socket && req.socket.encrypted) return true;
  return Boolean(process.env.VERCEL && !String(req.headers.host || "").startsWith("localhost"));
}

function buildCookieString(name, value, { maxAge = SESSION_MAX_AGE_SEC, secure = false } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function appendSetCookie(res, cookieStr) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", cookieStr);
  } else if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", [...prev, cookieStr]);
  } else {
    res.setHeader("Set-Cookie", [prev, cookieStr]);
  }
}

function generatePkcePair() {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = crypto.randomBytes(16).toString("hex");
  return { codeVerifier, codeChallenge, state };
}

function createSessionToken(user) {
  return signToken({
    uid: Number(user.id),
    lid: String(user.lichess_id || user.username).toLowerCase(),
    username: String(user.username),
    exp: Date.now() + SESSION_MAX_AGE_SEC * 1000
  });
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE_NAME];
  if (!raw) return null;
  const payload = verifyToken(raw);
  if (!payload || !payload.uid || !payload.username) return null;
  return {
    userId: Number(payload.uid),
    lichessId: String(payload.lid || payload.username).toLowerCase(),
    username: String(payload.username)
  };
}

function resolveRequestOrigin(req) {
  const proto = String((req && req.headers && req.headers["x-forwarded-proto"]) || (isHttpsRequest(req) ? "https" : "http"))
    .split(",")[0]
    .trim();
  const host = String((req && req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "localhost:3000")
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function buildDefaultUserSettings(username = "") {
  return {
    level: "inter",
    xp: "0",
    streak: "0",
    total_min: "0",
    attempts: "0",
    solved_count: "0",
    lichess_username: username || "",
    count_lichess_in_tracker: "true",
    endurance_notes: "",
    distraction_returns: "0",
    woop_json: JSON.stringify({
      wish: "",
      outcome: "",
      obstacle: "",
      plan: ""
    }),
    journal_3col_json: JSON.stringify({
      win: "",
      lesson: "",
      tomorrow: "",
      pos: "",
      emo: "",
      move: ""
    }),
    baseline_scores_json: JSON.stringify({
      memoire: 5,
      focus: 5,
      emotion: 5,
      clarte: 5
    }),
    weekly_grid_json: JSON.stringify({}),
    repertoire_json: JSON.stringify([]),
    training_mode: "fsrs",
    woodpecker_cycle: "1",
    fsrs_request_retention: "0.90",
    share_club_stats: "false",
    endurance_sessions_json: JSON.stringify([]),
    lichess_profile_json: JSON.stringify(null)
  };
}

async function ensureUserDefaults(client, userId, username = "") {
  const defaults = buildDefaultUserSettings(username);
  const stmts = Object.entries(defaults).map(([k, v]) => ({
    sql: "INSERT OR IGNORE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)",
    args: [Number(userId), k, v]
  }));
  await client.batch(stmts);
}

async function upsertLichessUser(client, lichessAccount) {
  const lichessId = String(lichessAccount.id || lichessAccount.username || "").trim().toLowerCase();
  const username = String(lichessAccount.username || lichessId).trim();
  if (!lichessId || !username) {
    throw new Error("Compte Lichess invalide");
  }
  const perfsJson = JSON.stringify(lichessAccount.perfs || {});

  await client.execute({
    sql: `INSERT INTO users (lichess_id, username, perfs_json, last_login_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(lichess_id) DO UPDATE SET
            username = excluded.username,
            perfs_json = excluded.perfs_json,
            last_login_at = CURRENT_TIMESTAMP`,
    args: [lichessId, username, perfsJson]
  });

  const userRes = await client.execute({
    sql: "SELECT id, lichess_id, username, perfs_json, created_at, last_login_at FROM users WHERE lichess_id = ?",
    args: [lichessId]
  });
  const user = userRes.rows[0];
  await ensureUserDefaults(client, user.id, user.username);
  if (lichessAccount.perfs) {
    await client.execute({
      sql: `INSERT INTO user_settings (user_id, key, value, updated_at)
            VALUES (?, 'lichess_profile_json', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      args: [
        Number(user.id),
        JSON.stringify({
          username: user.username,
          perfs: lichessAccount.perfs,
          count: lichessAccount.count || {}
        })
      ]
    });
  }
  return user;
}

async function saveUserLichessToken(client, userId, accessToken) {
  if (!accessToken || !userId) return;
  const key = crypto.createHash("sha256").update(getAuthSecret()).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(accessToken), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = `${base64UrlEncode(iv)}.${base64UrlEncode(tag)}.${base64UrlEncode(encrypted)}`;
  await client.execute({
    sql: `INSERT INTO user_settings (user_id, key, value, updated_at)
          VALUES (?, 'lichess_oauth_token_enc', ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    args: [Number(userId), packed]
  });
}

async function getUserLichessToken(client, userId) {
  if (!userId) return null;
  const res = await client.execute({
    sql: "SELECT value FROM user_settings WHERE user_id = ? AND key = 'lichess_oauth_token_enc'",
    args: [Number(userId)]
  });
  const packed = res.rows[0]?.value;
  if (!packed || typeof packed !== "string") return null;
  const parts = packed.split(".");
  if (parts.length !== 3) return null;
  try {
    const [ivB64, tagB64, dataB64] = parts;
    const key = crypto.createHash("sha256").update(getAuthSecret()).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, base64UrlDecodeToBuffer(ivB64));
    decipher.setAuthTag(base64UrlDecodeToBuffer(tagB64));
    const decrypted = Buffer.concat([decipher.update(base64UrlDecodeToBuffer(dataB64)), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (_e) {
    return null;
  }
}

module.exports = {
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
  buildDefaultUserSettings,
  ensureUserDefaults,
  upsertLichessUser,
  saveUserLichessToken,
  getUserLichessToken
};
