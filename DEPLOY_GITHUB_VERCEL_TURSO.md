# 🚀 Guide de Mise en Ligne : GitHub (`valisoadev`) + Turso Cloud + Vercel

Ce guide explique comment héberger **MIND FORTRESS (Madagascar 2027)** en production en utilisant ton compte GitHub **`valisoadev`**, **Turso Cloud** (SQLite distribué `libSQL`) et **Vercel**.

---

## 1️⃣ Étape 1 : Pousser le projet sur ton compte GitHub `valisoadev`

> **Note importante** : Ton outil `gh` local est actuellement connecté à `valisoatrainer`. Pour publier sous **`valisoadev`**, bascule d'abord sur `valisoadev` ou configure l'URL distante vers `https://github.com/valisoadev/mindfortress.git`.

Dans PowerShell, depuis `d:\Chess\MIND FORTRESS` :

```powershell
# 1. Se connecter au compte GitHub valisoadev (si tu utilises GitHub CLI)
gh auth login -h github.com

# (Ou si valisoadev est déjà ajouté dans gh, basculer dessus :)
gh auth switch -u valisoadev

# 2. Initialiser le dépôt Git local (déjà préparé avec .gitignore)
git init
git branch -M main
git config user.name "valisoadev"
git add .
git commit -m "feat: MIND FORTRESS Madagascar 2027 (SQLite Natif, ValisoaChess, FSRS, FIDE Clock)"

# 3. Créer le dépôt sur le compte valisoadev et pousser le code
gh repo create valisoadev/mindfortress --private --source=. --remote=origin --push
```

*(Si tu crées le dépôt manuellement sur `https://github.com/new` connecté à **valisoadev**, exécute simplement :)*
```powershell
git remote add origin https://github.com/valisoadev/mindfortress.git
git push -u origin main
```

---

## 2️⃣ Étape 2 : Créer ta base SQLite Cloud sur Turso et synchroniser `mind_fortress.db`

1. Crée une base de données sur [Turso](https://turso.tech/) (ou via le CLI `turso db create mindfortress`).
2. Récupère l'URL `libsql://...` et le jeton `TURSO_AUTH_TOKEN`.
3. Crée un fichier `.env` à la racine de `d:\Chess\MIND FORTRESS` (copie de `.env.example`) :
   ```ini
   TURSO_DATABASE_URL="libsql://mindfortress-valisoadev.turso.io"
   TURSO_AUTH_TOKEN="eyJhbGciOiJFZERTQSI..."
   ```
4. Pousse toutes tes tables et ta progression locale `mind_fortress.db` vers Turso Cloud en une seule commande :
   ```powershell
   npm run db:push-turso
   ```

---

## 3️⃣ Étape 3 : Connecter le dépôt GitHub `valisoadev/mindfortress` à Vercel

1. Connecte-toi sur [Vercel](https://vercel.com/) avec ton compte GitHub **`valisoadev`**.
2. Clique sur **Add New… → Project** et importe le dépôt **`valisoadev/mindfortress`**.
3. Dans **Environment Variables** sur Vercel, ajoute :
   - `TURSO_DATABASE_URL` = `libsql://mindfortress-valisoadev.turso.io`
   - `TURSO_AUTH_TOKEN` = `ton_token_turso`
   - `AUTH_SECRET` = une chaîne secrète aléatoire (32+ caractères) pour signer les cookies de session Lichess OAuth 2.0 PKCE
4. Clique sur **Deploy** :
   - Le fichier [`vercel.json`](file:///d:/Chess/MIND%20FORTRESS/vercel.json) route automatiquement toutes les requêtes `/api/*` vers la fonction Serverless [`api/index.js`](file:///d:/Chess/MIND%20FORTRESS/api/index.js) et sert l'application unifiée ainsi que tes bibliothèques `vendor/Valisoa*.js`.
