# Receipt Webapp + API (GED upload + OCR + Écritures)

## UI
- `/` : utilisateur
  - 1) Upload PDF en GED (arbo 945) **ET OCR** du même PDF -> pré-remplit Date / Libellé / Numéro ticket / TTC / HT / TVA + propose Catégorie/TVA
  - 2) Ajuste si besoin puis génère le JSON Écritures (ReferenceGed = Id GED)
- `/?admin=1` : admin (URL API + identifiant + mdp CNX)

## Variables Render (recommandé)
- `CNX_BASE_URL` (ex: https://isuiteacd.suiteexpert.fr/cnx/api)
- `CNX_IDENTIFIANT`
- `CNX_MOTDEPASSE`
- `OPENAI_API_KEY` (obligatoire pour OCR)

## Notes Swagger
- Le header de session est `UUID` (apiKey in header) et le modèle de connexion expose `UUID` dans la réponse. citeturn7view1
