/**
 * MIND FORTRESS — Import privé des répertoires d'ouvertures depuis D:\Chess\Reference (MySQL)
 * Usage :
 *   node db/import_reference_openings.js [--user=TemporaryOpening] [--dry-run]
 *
 * Isolé strictement par `user_id` : les lignes importées ne sont visibles que par le compte cible.
 */

const { execFileSync } = require("child_process");
const { initDatabase } = require("./init");
const { upsertLichessUser } = require("./auth");
const { parseOpeningLineMoves } = require("./scouting");

function parseCliArgs(argv) {
  const opts = {
    username: "TemporaryOpening",
    refUsername: "",
    dryRun: false
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg.startsWith("--user=")) {
      const val = arg.slice("--user=".length).trim();
      if (val) opts.username = val;
    } else if (arg.startsWith("--ref-user=")) {
      const val = arg.slice("--ref-user=".length).trim();
      if (val) opts.refUsername = val;
    }
  }
  if (!opts.refUsername) opts.refUsername = opts.username;
  return opts;
}

function fetchReferenceDataViaPhp(targetUsername) {
  const phpScript = `<?php
$pdo = new PDO(
  "mysql:host=127.0.0.1;dbname=reference;charset=utf8mb4",
  "root",
  "",
  [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
  ]
);

$stmtUser = $pdo->prepare("SELECT id, identifiant AS username FROM utilisateurs WHERE LOWER(identifiant) = LOWER(?) LIMIT 1");
$stmtUser->execute([${JSON.stringify(targetUsername)}]);
$user = $stmtUser->fetch();

if (!$user) {
  $allUsers = $pdo->query("SELECT u.id, u.identifiant, COUNT(r.id) AS nb_repertoires FROM utilisateurs u LEFT JOIN repertoires r ON r.utilisateur_id = u.id GROUP BY u.id ORDER BY nb_repertoires DESC")->fetchAll();
  echo json_encode(["user" => null, "availableUsers" => $allUsers, "repertoires" => [], "moves" => []], JSON_UNESCAPED_UNICODE);
  exit(0);
}

$stmtRep = $pdo->prepare(
  "SELECT id, nom, couleur, description, position_souche_fen FROM repertoires WHERE utilisateur_id = ? ORDER BY id ASC"
);
$stmtRep->execute([$user["id"]]);
$repertoires = $stmtRep->fetchAll();

if (count($repertoires) === 0) {
  echo json_encode(["user" => $user, "repertoires" => [], "moves" => []]);
  exit(0);
}

$repIds = array_map(fn($r) => (int)$r["id"], $repertoires);
$placeholders = implode(",", array_fill(0, count($repIds), "?"));
$stmtMoves = $pdo->prepare(
  "SELECT id, repertoire_id, parent_id, move_san, comment, annotation FROM repertoire_moves WHERE repertoire_id IN ($placeholders) ORDER BY id ASC"
);
$stmtMoves->execute($repIds);
$moves = $stmtMoves->fetchAll();

echo json_encode([
  "user" => $user,
  "repertoires" => $repertoires,
  "moves" => $moves
], JSON_UNESCAPED_UNICODE);
`;

  const stdout = execFileSync("php", [], {
    input: phpScript,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

function formatSanMoves(sanList, isDefaultStart) {
  if (!isDefaultStart) {
    return sanList.join(" ");
  }
  const parts = [];
  for (let i = 0; i < sanList.length; i += 2) {
    const moveNum = Math.floor(i / 2) + 1;
    if (i + 1 < sanList.length) {
      parts.push(`${moveNum}. ${sanList[i]} ${sanList[i + 1]}`);
    } else {
      parts.push(`${moveNum}. ${sanList[i]}`);
    }
  }
  return parts.join(" ");
}

function extractLinesFromRepertoires(repertoires, moves) {
  const movesByRep = new Map();
  for (const mv of moves) {
    const repId = Number(mv.repertoire_id);
    if (!movesByRep.has(repId)) movesByRep.set(repId, []);
    movesByRep.get(repId).push(mv);
  }

  const lines = [];
  for (const rep of repertoires) {
    const repMoves = movesByRep.get(Number(rep.id)) || [];
    if (repMoves.length === 0) continue;

    const childrenByParent = new Map();
    for (const mv of repMoves) {
      const parentKey = mv.parent_id == null ? 0 : Number(mv.parent_id);
      if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
      childrenByParent.get(parentKey).push(mv);
    }

    const roots = childrenByParent.get(0) || [];
    if (roots.length === 0) continue;

    const side = String(rep.couleur || "").toLowerCase() === "noir" ? "Noirs" : "Blancs";
    const soucheFen =
      rep.position_souche_fen && String(rep.position_souche_fen).trim()
        ? String(rep.position_souche_fen).trim()
        : "start";
    const repDesc = String(rep.description || "").trim();

    const branches = [];
    function dfs(node, sanAcc, commentAcc, visited) {
      if (visited.has(node.id)) return;
      visited.add(node.id);

      const nextSan = [...sanAcc, String(node.move_san || "").trim()];
      const note = String(node.comment || "").trim();
      const nextComments = note ? [...commentAcc, note] : commentAcc;

      const children = childrenByParent.get(Number(node.id)) || [];
      if (children.length === 0) {
        branches.push({ sanList: nextSan, comments: nextComments });
      } else {
        for (const child of children) {
          dfs(child, nextSan, nextComments, visited);
        }
      }
      visited.delete(node.id);
    }

    for (const root of roots) {
      dfs(root, [], [], new Set());
    }

    branches.forEach((branch, idx) => {
      // Dans Reference, repertoire_moves démarre généralement de la position initiale standard,
      // même si position_souche_fen indique la position thématique (ex: après 1.e4 c5).
      const rawSanJoined = branch.sanList.join(" ");
      let effectiveStartFen = "start";
      let movesText = formatSanMoves(branch.sanList, true);
      if (soucheFen !== "start") {
        const testFromStart = parseOpeningLineMoves(movesText, "start");
        if (!testFromStart.valid) {
          effectiveStartFen = soucheFen;
          movesText = rawSanJoined;
        }
      }
      const name =
        branches.length === 1
          ? String(rep.nom || "Ouverture").trim()
          : `${String(rep.nom || "Ouverture").trim()} · Variante ${idx + 1}`;
      const plan =
        branch.comments.length > 0 ? branch.comments.join(" | ") : repDesc;

      lines.push({
        side,
        name,
        eco: "",
        moves: movesText,
        plan,
        start_fen: effectiveStartFen
      });
    });
  }

  return lines;
}

async function run() {
  const opts = parseCliArgs(process.argv);
  console.log(`🔍 Lecture des répertoires dans D:\\Chess\\Reference pour « ${opts.username} »...`);

  const refData = fetchReferenceDataViaPhp(opts.refUsername);
  if (!refData.user) {
    console.log(`⚠️ Utilisateur « ${opts.refUsername} » introuvable dans la base MySQL reference.`);
    if (Array.isArray(refData.availableUsers) && refData.availableUsers.length > 0) {
      console.log("   Comptes disponibles dans Reference :", refData.availableUsers);
      console.log("   Relance avec : node db/import_reference_openings.js --ref-user=<identifiant> --user=TemporaryOpening");
    }
    process.exit(0);
  }

  console.log(
    `📚 Trouvé : ${refData.repertoires.length} répertoire(s) et ${refData.moves.length} coup(s) dans Reference.`
  );

  const candidateLines = extractLinesFromRepertoires(refData.repertoires, refData.moves);
  console.log(`🌿 ${candidateLines.length} variante(s) extraite(s) (racine → feuille).`);

  if (candidateLines.length === 0) {
    console.log("ℹ️ Aucune variante à importer.");
    process.exit(0);
  }

  const client = await initDatabase();

  // Trouver ou créer l'utilisateur cible dans Mind Fortress (isolé par user_id)
  const existingUserRes = await client.execute({
    sql: "SELECT id, lichess_id, username FROM users WHERE LOWER(lichess_id) = LOWER(?) OR LOWER(username) = LOWER(?) LIMIT 1",
    args: [opts.username, opts.username]
  });

  let targetUser = existingUserRes.rows && existingUserRes.rows[0];
  if (!targetUser) {
    if (opts.dryRun) {
      console.log(`🧪 [DRY-RUN] L'utilisateur « ${opts.username} » serait créé dans Mind Fortress.`);
      targetUser = { id: -1, lichess_id: opts.username.toLowerCase(), username: opts.username };
    } else {
      targetUser = await upsertLichessUser(client, {
        id: opts.username.toLowerCase(),
        username: opts.username
      });
      console.log(`👤 Utilisateur « ${targetUser.username} » créé (user_id=${targetUser.id}).`);
    }
  } else {
    console.log(`👤 Utilisateur cible trouvé : ${targetUser.username} (user_id=${targetUser.id}).`);
  }

  // Charger les lignes existantes de cet utilisateur pour éviter les doublons
  const existingKeys = new Set();
  if (targetUser.id > 0) {
    const existingLinesRes = await client.execute({
      sql: "SELECT side, start_fen, san_moves_json FROM opening_repertoire WHERE user_id = ?",
      args: [targetUser.id]
    });
    for (const row of existingLinesRes.rows || []) {
      existingKeys.add(`${row.side}|${row.start_fen || "start"}|${row.san_moves_json || "[]"}`);
    }
  }

  let importedCount = 0;
  let skippedDuplicate = 0;
  let invalidCount = 0;
  const pendingInserts = [];

  for (const line of candidateLines) {
    const parsed = parseOpeningLineMoves(line.moves, line.start_fen);
    if (!parsed.valid || parsed.sanMoves.length === 0) {
      invalidCount++;
      if (invalidCount <= 3) {
        console.warn(`⚠️ Ligne ignorée (coups invalides) : ${line.name} -> ${parsed.error || "vide"} | start_fen=${line.start_fen} | moves=${line.moves}`);
      }
      continue;
    }

    const sanMovesJson = JSON.stringify(parsed.sanMoves);
    const dedupKey = `${line.side}|${line.start_fen}|${sanMovesJson}`;
    if (existingKeys.has(dedupKey)) {
      skippedDuplicate++;
      continue;
    }

    if (opts.dryRun) {
      if (importedCount < 10) {
        console.log(`🧪 [DRY-RUN] Importerait : [${line.side}] ${line.name} -> ${line.moves}`);
      }
      importedCount++;
      existingKeys.add(dedupKey);
      continue;
    }

    pendingInserts.push({
      sql: `INSERT INTO opening_repertoire (
              user_id, side, name, eco, moves, plan, start_fen, mastery, san_moves_json, final_fen
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        targetUser.id,
        line.side,
        line.name,
        line.eco,
        line.moves,
        line.plan,
        line.start_fen,
        60,
        sanMovesJson,
        parsed.finalFen
      ]
    });
    existingKeys.add(dedupKey);
    importedCount++;
  }

  if (!opts.dryRun && pendingInserts.length > 0) {
    const CHUNK_SIZE = 25;
    for (let i = 0; i < pendingInserts.length; i += CHUNK_SIZE) {
      const chunk = pendingInserts.slice(i, i + CHUNK_SIZE);
      let attempt = 0;
      while (true) {
        try {
          await client.batch(chunk, "write");
          break;
        } catch (err) {
          attempt++;
          if (attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }
  }

  console.log("==================================================================");
  console.log(`✅ Import terminé pour ${opts.username} (strictement privé à user_id=${targetUser.id})`);
  console.log(`   • Importées : ${importedCount}`);
  console.log(`   • Déjà présentes (ignorées) : ${skippedDuplicate}`);
  console.log(`   • Invalides (ignorées) : ${invalidCount}`);
  console.log("==================================================================");

  try {
    client.close();
  } catch (_e) {}
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ Erreur lors de l'import Reference → Mind Fortress :", err);
  process.exit(1);
});
