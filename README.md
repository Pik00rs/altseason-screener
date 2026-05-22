# Altseason Screener — JS / GitHub Pages

Screener crypto **read-only** : un script Node tourne sur **GitHub Actions** (cron),
appelle l'API **CoinMarketCap** côté serveur, calcule un score, et écrit un JSON
statique. Un **dashboard** (GitHub Pages) lit ce JSON et l'affiche. 100% gratuit.

> ⚠️ Outil de **triage**, pas un prédicteur de pump. Le score dit « ça ressemble
> à ce qui a historiquement bougé », pas « ça va monter ». Agir dessus reste de
> la spéculation. Backteste avant d'y croire. Read-only : aucun fonds en jeu.

## Pourquoi cette archi (et pas un fetch direct CMC dans le navigateur)
- GitHub Pages = **statique**, pas de backend. Du JS front-end exposerait ta
  **clé API** dans le code source de la page → fuite.
- CMC **bloque les appels navigateur (CORS)** : leur API est server-side only.

Solution : **Actions = le backend**. Il appelle CMC avec la clé planquée dans les
Secrets, écrit `docs/data/screener.json`, et le commit. **Pages sert le dashboard**
qui lit ce JSON (même origine, pas de CORS, pas de clé exposée).

## Structure
- `scripts/scan.mjs` — Node : fetch CMC + scoring + écrit `docs/data/screener.json`.
- `docs/index.html`, `docs/style.css`, `docs/app.js` — le dashboard statique.
- `docs/data/screener.json` — données (exemple au départ, écrasées au 1er scan).
- `.github/workflows/screener.yml` — cron horaire + commit du JSON.

## Déploiement (gratuit)
1. Pousse le repo sur GitHub.
2. **Clé CMC** : crée un compte gratuit sur pro.coinmarketcap.com (plan Basic),
   puis Settings → Secrets and variables → Actions → ajoute `CMC_API_KEY`.
3. **Pages** : Settings → Pages → Source = *Deploy from a branch* →
   branche `main`, dossier `/docs`. Ton dashboard sera sur
   `https://<user>.github.io/<repo>/`.
4. **Lance le scan** : onglet Actions → screener-scan → Run workflow (ou attends
   le cron). Il écrit le JSON, le commit, Pages se redéploie tout seul.

## Coût / quotas
- CMC plan Basic : **gratuit**, ~10 000 crédits/mois, endpoint `listings/latest` inclus.
- Le scan = ~1 crédit/run. Cron horaire = ~720 crédits/mois → large sous le quota.
- GitHub Actions : gratuit (illimité repo public ; le job dure quelques secondes).

## Les signaux (et leurs limites)
- **Qualité du float** : circulating / total. Haut = peu d'overhang.
- **Momentum 7j / 30j**.
- **Surge de volume** : volume 24h / mcap (proxy d'attention).
- **Chaleur du secteur** : *non incluse* (catégories CMC pas simples sur le free).
  TODO : l'ajouter via les catégories CoinGecko (gratuit) ou CMC.
- **Overhang d'unlock** : LE signal différenciant, mais payant/scraping. TODO.

## À compléter
- Brancher une **source d'unlocks** (Tokenomist/CryptoRank) — signal le plus utile.
- **Backtester** le scoring : logge les alertes + le prix N jours après. Sans ça,
  les poids sont au doigt mouillé.
- (Optionnel) alertes Telegram en plus du dashboard.

## Limites GitHub Actions
- Cron pas garanti à la minute (retards possibles en charge). OK pour de l'horaire.
- Workflows planifiés **désactivés après 60 jours d'inactivité** du repo.

## Disclaimer
Éducatif. Pas un conseil financier. Les small caps peuvent aller à zéro.
