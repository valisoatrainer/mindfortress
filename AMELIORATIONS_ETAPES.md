# 🚀 MIND FORTRESS — Feuille de Route des Améliorations (Phase 2)

Ce document liste les **5 améliorations** prévues après la mise en production multi-utilisateurs (Lichess OAuth 2.0 PKCE + Turso + Vercel).  
**Règle d'exécution** : chaque étape est réalisée **une par une**, sans précipitation, et **validée par des tests automatisés (100 % PASS)** avant de passer à la suivante.

---

## 📌 État de départ (Acquis)
- Socle SQLite natif / Turso (`@libsql/client`) + API Serverless Vercel ([`api/index.js`](api/index.js)).
- Authentification Lichess obligatoire (OAuth 2.0 PKCE) & isolation multi-utilisateurs par `user_id` ([`db/auth.js`](db/auth.js)).
- Échiquier & moteur [`ValisoaChessLite.js`](vendor/ValisoaChessLite.js) + FSRS v4.5 / Woodpecker + Pendule FIDE + Lichess Lab + Scouting + Analytique.
- **Suites de tests validées (8/8 à 100 %)** : `step1` à `step8` via `npm test`.

---

## 🧩 Étape 9 : Application installable sur téléphone (PWA)
**Objectif** : Permettre aux joueurs d'installer **MIND FORTRESS** sur Android / iPhone depuis Chrome / Safari en plein écran, sans barre d'adresse.

### Ce qui sera fait
- Création de `manifest.json` (nom, couleurs `#0A0A0F` / `#FFD700`, `display: "standalone"`, icônes PNG/SVG).
- Ajout des balises `<link rel="manifest">` et `<meta name="apple-mobile-web-app-capable">` dans [`index.html`](index.html).
- Service Worker minimal (`sw.js`) respectant strictement la sécurité (jamais de mise en cache des routes `/api/*` authentifiées ni des cookies de session).

### Validation & Tests obligatoires (`tests/step9_pwa.test.js`)
- Vérifier que `manifest.json`, les icônes et `sw.js` sont servis en HTTP `200` avec les bons `Content-Type`.
- Vérifier que `manifest.json` est un JSON valide avec `display: "standalone"` et `start_url: "/"`.
- Vérifier que les routes `/api/*` ne sont jamais mises en cache et conservent la sécurité `401 AUTH_REQUIRED`.

---

## 🏆 Étape 10 : Mode « Jour de Ronde » (Routine Pré-Ronde & Débriefing Post-Ronde)
**Objectif** : Offrir un protocole complet pour les jours de compétition FIDE (Championnat de Madagascar 2027).

### Ce qui sera fait
- **Routine Pré-Ronde (15 min)** :
  - Sélection automatique de 3 à 5 puzzles déjà maîtrisés (`fsrs_state >= 2`) pour activer la confiance sans fatigue.
  - Rappel rapide de la fiche adversaire du jour (issue de `opponents`) + exercice de respiration 4-6.
- **Débriefing Post-Ronde (5 min)** :
  - Formulaire rapide : résultat (`1`, `½`, `0`), cadence/gestion du temps (zeitnot oui/non), moment critique, état émotionnel.
  - Enregistrement structuré en base (table dédiée ou `tournament_rounds` isolée par `user_id`) + lien avec le Journal Contextuel.

### Validation & Tests obligatoires (`tests/step10_tournament_mode.test.js`)
- Vérifier la génération de l'échauffement pré-ronde (puzzles maîtrisés uniquement).
- Vérifier la persistance CRUD des rondes (`POST /api/rounds`, `GET /api/state`, `DELETE /api/rounds`) et l'isolation stricte par `user_id`.

---

## 🧠 Étape 11 : Entraînement à la Visualisation & Calcul à l'Aveugle
**Objectif** : Renforcer la vision mentale du joueur sans échiquier visible (indispensable en 4e heure de partie classique FIDE).

### Ce qui sera fait
- Mini-exercices chronométrés sans échiquier :
  1. **Couleur de case** (ex. `f6`, `c3`, `h2` → Blanc ou Noir sous pression du temps).
  2. **Trajet du Cavalier / Diagonales** (trouver le nombre minimal de coups ou la case d'intersection).
  3. **Série aveugle courte** : enchaîner des puzzles simples (1 à 2 coups) sans afficher les pièces.
- Sauvegarde des scores de précision et de temps de réponse dans l'espace du joueur.

### Validation & Tests obligatoires (`tests/step11_visualization.test.js`)
- Vérifier mathématiquement la logique de génération/vérification (couleur des 64 cases `a1..h8`, distances du Cavalier sur [`ValisoaChessLite.js`](vendor/ValisoaChessLite.js)).
- Vérifier l'enregistrement des sessions de visualisation par `user_id`.

---

## 🤖 Étape 12 : Détection automatique des vraies gaffes Lichess via Stockfish (WASM)
**Objectif** : Analyser automatiquement les dernières parties Lichess du joueur directement dans son navigateur (0 coût serveur) pour transformer ses vraies gaffes en puzzles FSRS.

### Ce qui sera fait
- Intégration d'un moteur **Stockfish WebAssembly (Worker)** côté client.
- Analyse des positions clés d'une partie importée depuis Lichess : détection des chutes d'évaluation (> 150 centipions).
- Extraction automatique de la position FEN juste avant la gaffe + le **meilleur coup exact** calculé par Stockfish, prêt à être enregistré via `POST /api/lichess/to-puzzle`.

### Validation & Tests obligatoires (`tests/step12_stockfish_blunders.test.js`)
- Vérifier la détection des seuils de gaffe (> 150 cp) à partir d'évaluations moteur simulées/réelles.
- Vérifier que chaque coup solution généré est légal sur [`ValisoaChessLite.js`](vendor/ValisoaChessLite.js) et enregistré en puzzle FSRS isolé par `user_id`.

---

## 🤝 Étape 13 : Défi & Régularité d'équipe (Opt-in strict)
**Objectif** : Créer une émulation saine entre joueurs du club / de la sélection tout en préservant une confidentialité absolue sur le travail personnel.

### Ce qui sera fait
- Paramètre `share_club_stats` (désactivé par défaut : `"false"`).
- Si activé volontairement par le joueur : partage uniquement du **pseudo Lichess**, de la **série de jours actifs (`streak`)** et du **nombre de puzzles résolus cette semaine**.
- **Confidentialité stricte** : les adversaires (`opponents`), le répertoire d'ouvertures (`opening_repertoire`), les journaux mentaux et les notes restent **100 % privés** et inaccessibles aux autres comptes.

### Validation & Tests obligatoires (`tests/step13_club_leaderboard.test.js`)
- Vérifier qu'un joueur avec `share_club_stats = false` n'apparaît jamais dans le classement.
- Vérifier qu'un joueur avec `share_club_stats = true` n'expose **aucune** donnée privée (ni journal, ni adversaires, ni ouvertures).


## ⚡ Étape 14 : Flux Tactique Lichess intégré (API `puzzle:read` / `puzzle:write` + option Woodpecker)
**Objectif** : Streamer des puzzles Lichess en continu directement sur l'échiquier de MIND FORTRESS sans quitter l'application et sans surcharger la base Turso.

### Ce qui sera fait
- Ajouter les scopes `puzzle:read` et `puzzle:write` lors de la connexion OAuth 2.0 PKCE Lichess (et stocker le jeton Lichess de manière sécurisée côté serveur/session pour appeler l'API Lichess au nom du joueur).
- Endpoint proxy backend (`GET /api/lichess/puzzle/next` et `POST /api/lichess/puzzle/complete`) pour récupérer le prochain puzzle adapté au classement Elo Lichess du joueur (avec filtre de thème optionnel) et synchroniser la tentative sur Lichess si activé.
- Lecteur de flux fluide dans l'interface (conversion `game.pgn` + `initialPly` vers FEN + coups UCI/SAN sur l'échiquier intégré `ValisoaChessboard`, sans sauvegarde automatique en base).
- Bouton à la volée **« 🪵 Ajouter au Woodpecker / FSRS »** pour sauvegarder uniquement les puzzles choisis dans la base personnelle du joueur (`user_id`).

### Validation & Tests obligatoires (`tests/step14_lichess_puzzle_stream.test.js`)
- Vérifier la présence des scopes `puzzle:read puzzle:write` dans l'URL de redirection OAuth `/api/auth/lichess/login`.
- Vérifier le parsing d'un puzzle Lichess (`game.pgn` + `initialPly` + `solution` UCI) et la légalité des coups sur `ValisoaChessLite.js`.
- Vérifier qu'un puzzle joué en flux n'est **pas** inséré automatiquement dans `puzzles`, et que le clic sur « Ajouter au Woodpecker » l'enregistre bien uniquement pour l'utilisateur connecté (`user_id`).
