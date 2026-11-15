/**
 * MIND FORTRESS — Convertisseur & Proxy de Puzzles Lichess
 * Transforme les réponses API Lichess (game.pgn + initialPly + solution UCI)
 * en objets puzzles compatibles avec ValisoaChessLite & ValisoaChessboard.
 */

const ValisoaChessLite = require("../vendor/ValisoaChessLite.js");

const THEME_MAP = {
  fork: "fork",
  pin: "pin",
  mateIn1: "mateIn2",
  mateIn2: "mateIn2",
  mateIn3: "mateIn3",
  mateIn4: "veryLong",
  mateIn5: "veryLong",
  advancedPawn: "advancedPawn",
  promotion: "advancedPawn",
  defensiveMove: "defensiveMove",
  veryLong: "veryLong",
  long: "veryLong"
};

function parsePgnTokens(pgn) {
  if (!pgn || typeof pgn !== "string") return [];
  const cleaned = pgn
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\$\d+/g, " ")
    .replace(/\d+\.(\.\.)?/g, " ")
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, " ");
  return cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function ratingToDiff(rating) {
  const r = Number(rating || 1500);
  if (r < 1200) return 1;
  if (r < 1550) return 2;
  if (r < 1900) return 3;
  if (r < 2250) return 4;
  return 5;
}

function pickPrimaryTheme(themes = []) {
  if (!Array.isArray(themes) || themes.length === 0) return "fork";
  for (const t of themes) {
    if (THEME_MAP[t]) return THEME_MAP[t];
  }
  return String(themes[0] || "fork");
}

function convertLichessPuzzle(apiPayload) {
  if (!apiPayload || !apiPayload.puzzle || !apiPayload.game) {
    throw new Error("Payload puzzle Lichess invalide");
  }
  const { puzzle, game } = apiPayload;
  const tokens = parsePgnTokens(game.pgn || "");
  const initialPly = Number(puzzle.initialPly ?? -1);

  const chess = new ValisoaChessLite();
  let lastMove = null;
  const applyCount = initialPly >= 0 ? Math.min(tokens.length, initialPly + 1) : tokens.length;

  for (let i = 0; i < applyCount; i++) {
    const m = chess.move(tokens[i]);
    if (!m) {
      throw new Error(`Coup PGN illégal à l'index ${i}: ${tokens[i]}`);
    }
    if (i === applyCount - 1) {
      lastMove = {
        from: chess.indexToSquare(m.from),
        to: chess.indexToSquare(m.to),
        san: m.san || tokens[i]
      };
    }
  }

  const startFen = chess.fen();
  const side = chess.turn === "w" ? "Blancs" : "Noirs";
  const uciSolution = Array.isArray(puzzle.solution) ? puzzle.solution : [];
  const sanMoves = [];

  for (const uci of uciSolution) {
    const m = chess.move(String(uci).trim());
    if (!m) {
      throw new Error(`Coup solution UCI illégal (${uci}) sur FEN ${chess.fen()}`);
    }
    sanMoves.push(m.san);
  }

  const themes = Array.isArray(puzzle.themes) ? puzzle.themes : [];
  const primaryTheme = pickPrimaryTheme(themes);
  const rating = Number(puzzle.rating || 1500);
  const diff = ratingToDiff(rating);
  const lichessId = String(puzzle.id || "");

  return {
    id: `lichess-${lichessId}`,
    lichessId,
    code: `LICHESS-${lichessId}`,
    title: `Lichess #${lichessId} · Elo ${rating}`,
    fen: startFen,
    theme: primaryTheme,
    themes,
    type: "tactique",
    diff,
    rating,
    side,
    solution: sanMoves.join(" "),
    solution_moves: sanMoves,
    solution_uci: uciSolution,
    hint: themes.length ? `Thèmes Lichess : ${themes.join(", ")}` : "Trouve la suite gagnante !",
    lastMove,
    url: `https://lichess.org/training/${lichessId}`,
    source: "lichess_stream"
  };
}

module.exports = {
  parsePgnTokens,
  ratingToDiff,
  pickPrimaryTheme,
  convertLichessPuzzle
};
