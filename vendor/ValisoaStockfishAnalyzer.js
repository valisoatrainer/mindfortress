/**
 * ValisoaStockfishAnalyzer.js — Détection de gaffes (> 150 cp) & Stockfish WASM Client-Side
 * Zéro coût serveur : l'analyse UCI s'exécute dans un Web Worker côté navigateur
 * et chaque meilleur coup est validé légalement par ValisoaChessLite.js.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    const ValisoaChessLite = require("./ValisoaChessLite.js");
    module.exports = factory(ValisoaChessLite);
  } else {
    root.ValisoaStockfishAnalyzer = factory(root.ValisoaChessLite);
  }
})(typeof self !== "undefined" ? self : this, function (ValisoaChessLite) {
  "use strict";

  const STOCKFISH_CDN_URL = "https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js";

  function parsePgnSanTokens(pgn) {
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

  function extractPositionsFromPgn(pgn, ChessClass = ValisoaChessLite) {
    const tokens = parsePgnSanTokens(pgn);
    const chess = new ChessClass();
    const plies = [];

    for (let i = 0; i < tokens.length; i++) {
      const fenBefore = chess.fen();
      const turnBefore = chess.turn; // "w" | "b"
      const moveNumber = Math.floor(i / 2) + 1;
      const moveObj = chess.move(tokens[i]);
      if (!moveObj) break;
      const fromSq = chess.indexToSquare(moveObj.from);
      const toSq = chess.indexToSquare(moveObj.to);
      const uci = fromSq + toSq + (moveObj.promotion || "");
      plies.push({
        ply: i + 1,
        moveNumber,
        turnBefore,
        san: moveObj.san || tokens[i],
        uci,
        fenBefore,
        fenAfter: chess.fen()
      });
    }
    return plies;
  }

  /**
   * Convertit un score UCI (toujours du point de vue du camp au trait) vers le point de vue des Blancs.
   */
  function normalizeEvalToWhiteCp(scoreType, scoreValue, turnToMove) {
    let cp = 0;
    if (scoreType === "mate") {
      const m = Number(scoreValue || 0);
      cp = m >= 0 ? 10000 - Math.min(99, m) * 10 : -10000 + Math.min(99, Math.abs(m)) * 10;
    } else {
      cp = Number(scoreValue || 0);
    }
    return turnToMove === "b" ? -cp : cp;
  }

  function detectBlundersFromEvaluations(pliesWithEvals, thresholdCp = 150, ChessClass = ValisoaChessLite) {
    if (!Array.isArray(pliesWithEvals)) return [];
    const blunders = [];

    for (const item of pliesWithEvals) {
      const evalBeforeW = Number(item.evalBeforeWhiteCp);
      const evalAfterW = Number(item.evalAfterWhiteCp);
      if (!Number.isFinite(evalBeforeW) || !Number.isFinite(evalAfterW)) continue;

      const turn = item.turnBefore === "b" ? "b" : "w";
      const dropCp = turn === "w" ? evalBeforeW - evalAfterW : evalAfterW - evalBeforeW;

      if (dropCp <= thresholdCp) continue;

      const bestUci = String(item.bestMoveUci || "").trim();
      if (!bestUci || bestUci === String(item.uci || "").trim()) continue;

      // Valider la légalité du meilleur coup Stockfish sur ValisoaChessLite
      const chess = new ChessClass();
      if (!chess.load(item.fenBefore)) continue;
      const bestMoveObj = chess.move(bestUci);
      if (!bestMoveObj) continue;

      const bestSan = bestMoveObj.san;
      const roundedDrop = Math.round(dropCp);
      const severity = roundedDrop >= 300 ? "Gaffe (Blunder)" : "Erreur (Mistake)";

      blunders.push({
        ply: item.ply,
        moveNumber: item.moveNumber,
        side: turn === "w" ? "Blancs" : "Noirs",
        playedSan: item.san,
        playedUci: item.uci || "",
        bestMoveUci: bestUci,
        bestMoveSan: bestSan,
        fen: item.fenBefore,
        evalDropCp: roundedDrop,
        severity,
        diff: roundedDrop >= 300 ? 4 : 3,
        solution_moves: [bestSan]
      });
    }

    return blunders;
  }

  function createStockfishWorker() {
    if (typeof Worker === "undefined") {
      throw new Error("Web Workers non disponibles dans cet environnement.");
    }
    const blobCode = `importScripts(${JSON.stringify(STOCKFISH_CDN_URL)});`;
    const blob = new Blob([blobCode], { type: "application/javascript" });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);

    let readyPromise = null;
    let currentResolve = null;
    let latestEval = { type: "cp", value: 0 };

    worker.onmessage = (ev) => {
      const line = String(ev.data || "");
      const scoreMatch = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
      if (scoreMatch) {
        latestEval = { type: scoreMatch[1], value: Number(scoreMatch[2]) };
      }
      if (line.startsWith("bestmove ") && currentResolve) {
        const parts = line.split(/\s+/);
        const bestMove = parts[1] && parts[1] !== "(none)" ? parts[1] : "";
        const resolve = currentResolve;
        currentResolve = null;
        resolve({ bestMove, evalType: latestEval.type, evalValue: latestEval.value });
      }
    };

    function init() {
      if (readyPromise) return readyPromise;
      readyPromise = new Promise((resolve) => {
        const prevHandler = worker.onmessage;
        worker.onmessage = (ev) => {
          const line = String(ev.data || "");
          if (line === "readyok") {
            worker.onmessage = prevHandler;
            resolve();
          }
        };
        worker.postMessage("uci");
        worker.postMessage("isready");
      });
      return readyPromise;
    }

    async function evaluateFen(fen, depth = 12) {
      await init();
      latestEval = { type: "cp", value: 0 };
      return new Promise((resolve) => {
        currentResolve = resolve;
        worker.postMessage(`position fen ${fen}`);
        worker.postMessage(`go depth ${Number(depth || 12)}`);
      });
    }

    function terminate() {
      try {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
      } catch (_e) {}
    }

    return { evaluateFen, terminate };
  }

  async function analyzeGameWithStockfish(pgn, options = {}) {
    const depth = Number(options.depth || 11);
    const thresholdCp = Number(options.thresholdCp || 150);
    const maxPlies = Number(options.maxPlies || 80);
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

    const plies = extractPositionsFromPgn(pgn).slice(0, maxPlies);
    if (plies.length === 0) return [];

    const sf = createStockfishWorker();
    const evaluated = [];

    try {
      // Évaluer la position de départ de chaque coup + la position résultante
      let prevAfterWhiteCp = 20; // léger avantage initial des Blancs ~0.2
      for (let i = 0; i < plies.length; i++) {
        const p = plies[i];
        if (onProgress) onProgress(i + 1, plies.length);

        const beforeRes = await sf.evaluateFen(p.fenBefore, depth);
        const evalBeforeWhiteCp =
          i === 0 ? prevAfterWhiteCp : normalizeEvalToWhiteCp(beforeRes.evalType, beforeRes.evalValue, p.turnBefore);

        const turnAfter = p.turnBefore === "w" ? "b" : "w";
        const afterRes = await sf.evaluateFen(p.fenAfter, depth);
        const evalAfterWhiteCp = normalizeEvalToWhiteCp(afterRes.evalType, afterRes.evalValue, turnAfter);
        prevAfterWhiteCp = evalAfterWhiteCp;

        evaluated.push({
          ...p,
          bestMoveUci: beforeRes.bestMove,
          evalBeforeWhiteCp,
          evalAfterWhiteCp
        });
      }
    } finally {
      sf.terminate();
    }

    return detectBlundersFromEvaluations(evaluated, thresholdCp);
  }

  return {
    parsePgnSanTokens,
    extractPositionsFromPgn,
    normalizeEvalToWhiteCp,
    detectBlundersFromEvaluations,
    createStockfishWorker,
    analyzeGameWithStockfish
  };
});
