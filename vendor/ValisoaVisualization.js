/**
 * ValisoaVisualization.js — Entraînement à la Visualisation & Calcul à l'Aveugle
 * Couleur de case, Trajet minimal du Cavalier, Diagonales & Séries aveugles.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ValisoaVisualization = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const KNIGHT_DELTAS = [
    [2, 1],
    [2, -1],
    [-2, 1],
    [-2, -1],
    [1, 2],
    [1, -2],
    [-1, 2],
    [-1, -2]
  ];

  function parseSquare(sq) {
    if (typeof sq !== "string" || !/^[a-h][1-8]$/.test(sq.trim().toLowerCase())) {
      throw new Error(`Case invalide: ${sq}`);
    }
    const clean = sq.trim().toLowerCase();
    return {
      sq: clean,
      file: clean.charCodeAt(0) - 97,
      rank: Number(clean[1]) - 1
    };
  }

  function toSquare(file, rank) {
    return FILES[file] + String(rank + 1);
  }

  function getSquareColor(sq) {
    const { file, rank } = parseSquare(sq);
    // a1 -> (0 + 0) % 2 === 0 -> case noire ("dark")
    return (file + rank) % 2 === 0 ? "dark" : "light";
  }

  function areOnSameDiagonal(sq1, sq2) {
    const a = parseSquare(sq1);
    const b = parseSquare(sq2);
    if (a.sq === b.sq) return false;
    return Math.abs(a.file - b.file) === Math.abs(a.rank - b.rank);
  }

  function findDiagonalIntersections(sq1, sq2) {
    const a = parseSquare(sq1);
    const b = parseSquare(sq2);
    if (getSquareColor(a.sq) !== getSquareColor(b.sq)) return [];
    const results = [];
    for (let f = 0; f < 8; f++) {
      for (let r = 0; r < 8; r++) {
        const candidate = toSquare(f, r);
        if (candidate === a.sq || candidate === b.sq) continue;
        if (
          Math.abs(f - a.file) === Math.abs(r - a.rank) &&
          Math.abs(f - b.file) === Math.abs(r - b.rank)
        ) {
          results.push(candidate);
        }
      }
    }
    return results;
  }

  function knightMinMoves(startSq, targetSq) {
    const start = parseSquare(startSq);
    const target = parseSquare(targetSq);
    if (start.sq === target.sq) {
      return { distance: 0, path: [start.sq] };
    }
    const visited = new Set([start.sq]);
    const queue = [{ file: start.file, rank: start.rank, path: [start.sq] }];

    while (queue.length > 0) {
      const cur = queue.shift();
      for (const [df, dr] of KNIGHT_DELTAS) {
        const nf = cur.file + df;
        const nr = cur.rank + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const nextSq = toSquare(nf, nr);
        if (visited.has(nextSq)) continue;
        const nextPath = [...cur.path, nextSq];
        if (nextSq === target.sq) {
          return { distance: nextPath.length - 1, path: nextPath };
        }
        visited.add(nextSq);
        queue.push({ file: nf, rank: nr, path: nextPath });
      }
    }
    return { distance: -1, path: [] };
  }

  function randomSquare() {
    const f = Math.floor(Math.random() * 8);
    const r = Math.floor(Math.random() * 8);
    return toSquare(f, r);
  }

  function generateSquareColorDrill() {
    const square = randomSquare();
    return {
      type: "square_color",
      square,
      answer: getSquareColor(square)
    };
  }

  function generateKnightPathDrill() {
    const startSq = randomSquare();
    let targetSq = randomSquare();
    while (targetSq === startSq) {
      targetSq = randomSquare();
    }
    const res = knightMinMoves(startSq, targetSq);
    return {
      type: "knight_path",
      startSq,
      targetSq,
      answer: res.distance,
      path: res.path
    };
  }

  return {
    parseSquare,
    getSquareColor,
    areOnSameDiagonal,
    findDiagonalIntersections,
    knightMinMoves,
    generateSquareColorDrill,
    generateKnightPathDrill
  };
});
