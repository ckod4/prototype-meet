# Prototype Meet - visioconférence Jitsi à créneau strict

MVP auto-hébergé : Jitsi Meet protégé par JWT, API sans interface, projet web avec authentification, organisations multiples, réunions publiques, salle d'attente, enregistrement Jibri automatique, transcription française auto-hébergée, artefacts S3, webhooks et flux d'événements.

Toute la configuration est dans `.env`. Les réunions ne peuvent être créées que par l'API. L'API est strictement sans état de compte et sans interface : elle ne crée aucun utilisateur, ne gère aucun mot de passe et ne sert aucune page. Ses deux rôles, organisateur et participant, viennent exclusivement du lien utilisé. Un projet web quelconque peut la consommer côté serveur avec la clé maître, sans que le navigateur ne reçoive jamais cette clé. Plusieurs projets web peuvent partager la même API. Jitsi refuse toute création ou connexion directe sans JWT.

## Démarrage rapide

Prérequis : Docker + Docker Compose, environ 6 Go de RAM libres pour la pile de base, davantage avec Jibri et Whisper.

```bash
./scripts/init-env.sh
docker compose up -d --build
```

- Interface web et liens de réunion : http://localhost:3090
- API backend : http://localhost:3080
- Jitsi Meet : https://meet.localhost:9443 (certificat auto-signé local, accepter l'avertissement)
- Console S3 RustFS : http://localhost:9003
- API S3 RustFS : http://localhost:9002
- JVB : UDP 10001

Parcours utilisateur :

1. Ouvrir http://localhost:3090, créer un compte puis se connecter.
2. Créer une réunion, choisir le créneau et activer éventuellement l'enregistrement, la transcription, le chat, l'accès public et la salle d'attente.
3. Conserver le lien organisateur secret, réserver aux comptes organisateurs. Ajouter d'autres organisateurs par e-mail. Partager le lien participant : chaque participant doit avoir un compte web.
4. Sans session dans le navigateur, un lien redirige vers la connexion puis revient automatiquement sur la réunion. Avec une session, le lien ouvre directement la salle, même dans un nouvel onglet.
5. Retrouver dans la fiche de la réunion la présence, le chat, l'enregistrement et les transcriptions dès qu'ils sont produits.

Enregistrement et transcription :

```bash
docker compose --profile recording --profile transcription up -d --build
```

Jibri télécharge une image volumineuse et consomme beaucoup de CPU. Le worker Whisper télécharge le modèle au premier job (volume `whisper-models`). Jibri est piloté automatiquement par l'API ; une seule réunion enregistrée peut être active à la fois.

Pour tester l'API directement, sans passer par l'interface web (usage réservé aux tests et intégrations) :

```bash
KEY=$(grep '^MASTER_API_KEY=' .env | cut -d= -f2-)
START="2026-11-05T14:00:00+01:00"
END="2026-11-05T15:00:00+01:00"

curl -sS -X POST http://localhost:3080/api/v1/meetings \
  -H "X-API-Key: $KEY" \
  -H 'content-type: application/json' \
  -d "{
    \"title\": \"Point projet\",
    \"starts_at\": \"$START\",
    \"ends_at\": \"$END\",
    \"early_join_minutes\": 10,
    \"recording\": true,
    \"transcription\": true,
    \"chat\": true,
    \"public_access\": false,
    \"waiting_room\": true,
    \"organizers\": [{\"display_name\": \"Alice Martin\", \"external_id\": \"u-alice\"}],
    \"participants\": [{\"display_name\": \"Bob Durand\", \"external_id\": \"u-bob\"}],
    \"generic_participant\": true
  }" | python3 -m json.tool
```

La réponse contient les jetons de lien **une seule fois**, sous forme neutre (`token`), jamais sous forme d'URL. L'API ne connaît ni le domaine ni la route du projet web consommateur : c'est le projet web qui compose ses propres URL, par exemple `https://mon-web.example/m/{token}`. Les jetons sont stockés hachés en base : un lien perdu ne peut pas être réaffiché. Utiliser `POST /api/v1/meetings/{id}/links` pour créer un lien supplémentaire avant le début. L'interface web, elle, conserve les jetons du créateur dans sa propre base, chiffrés avec AES-256-GCM.

Pour qu'un lien organisateur créé directement par l'API soit utilisable dans le web, `external_id` doit être l'UUID du compte web organisateur : le web vérifie que le lien nominatif correspond au compte connecté. C'est automatique quand la réunion est créée depuis le projet web. L'API, elle, ne vérifie pas cette appartenance : elle applique uniquement le rôle porté par le lien.

## Interface web

Le projet web est un service Node séparé, exposé sur le port 3090. Il consomme l'API de réunions uniquement côté serveur, avec `MASTER_API_KEY`. Le navigateur ne reçoit jamais cette clé. Ce projet est un consommateur parmi d'autres : un second projet web, avec sa propre base de comptes et son propre `WEB_CLIENT_ID`, peut réutiliser la même API et le même système de liens.

- Inscription et connexion par e-mail et mot de passe.
- Mots de passe hachés avec scrypt et sel aléatoire.
- Session en cookie HttpOnly, SameSite=Lax, expiration 7 jours.
- Jeton CSRF sur tous les formulaires.
- Chaque réunion est rattachée au compte créateur et aux organisateurs ajoutés. Un autre compte reçoit 404 sur les pages, exports et téléchargements.
- Le créateur et chaque organisateur disposent de leur propre lien organisateur nominatif. Les liens sont chiffrés en base web.
- Un organisateur peut ajouter d'autres organisateurs par e-mail. Une invitation sans compte reste en attente jusqu'à l'inscription avec la même adresse.
- Un organisateur qui ouvre un lien participant est automatiquement redirigé vers son lien organisateur. Il n'est jamais enregistré deux fois, participant puis organisateur.
- Un lien organisateur est lié au compte organisateur nominatif. Un autre compte, même connecté, reçoit 403.
- Création, modification du créneau, annulation et fin immédiate via l'API.
- Activation de l'enregistrement, de la transcription, du chat, de l'accès public et de la salle d'attente.
- Réunion publique : le lien participant générique demande le nom affiché avant l'entrée.
- Consentement à l'enregistrement : si la réunion est enregistrée, le web affiche un écran de consentement avant tout appel `join`. L'API reste totalement transparente à ce consentement ; la pastille d'enregistrement reste visible dans la salle pendant la captation.
- Salle d'attente : le participant voit « En attente d'admission ». L'organisateur voit la liste et admet, refuse ou exclut une personne en un clic.
- Modération en direct : micro, caméra, partage d'écran, chat, exclusion définitive et fin anticipée depuis la salle.
- Tableau de présence avec entrées/sorties, chat, artefacts, téléchargements protégés et exports JSON.
- Téléchargement des artefacts via une URL présignée courte, après contrôle de propriété. Suppression définitive possible par un organisateur.
- Enregistrement géré par le serveur : il démarre automatiquement dès qu'un participant consenti a rejoint une réunion avec enregistrement activé.
- Toutes les vues de réunion sont dans le web : attente, salle, réunion terminée, réunion annulée, capacité atteinte.
- Tout lien de réunion exige une session web. Sans session : redirection vers `/login` avec retour automatique sur le lien. Avec session : accès direct, y compris dans un nouvel onglet.
- La salle web intègre l'iframe Jitsi et conserve la logique de fin de créneau, le chat, la capture audio et les événements de présence.
- Le web entretient un abonnement SSE persistant vers `/api/v1/events/stream`. Les changements d'admission, de présence, de médias, de chat, d'enregistrement et de fin de réunion arrivent par ce flux, sans boucle d'interrogation. L'API conserve un journal d'événements rejouable après redémarrage. Seul un heartbeat de présence toutes les 30 s reste envoyé par la salle pour maintenir la vivacité de la session ; il ne demande aucun événement.
- L'API ne sert aucune page, aucun formulaire et aucun asset : uniquement du JSON, des URL présignées et des flux d'événements.

L'API conserve son propre modèle : une seule clé maître, aucune session utilisateur. L'interface web est la couche d'authentification, de propriété et de présentation. Jitsi reste limité à l'iframe de visioconférence ; Jibri reste limité à l'enregistrement. Aucune vue, aucun formulaire ni aucune logique de réunion n'est servi par Jitsi ou Jibri en dehors de la salle.

## Organisateurs

- Le créateur est organisateur et reçoit son lien nominatif.
- Tout organisateur peut ajouter d'autres organisateurs depuis la fiche de la réunion, en saisissant leur adresse e-mail.
- Si l'adresse correspond à un compte existant, le lien organisateur nominatif est généré immédiatement et la réunion apparaît dans son tableau de bord.
- Sinon, l'invitation reste en attente. À l'inscription avec la même adresse, le lien est généré automatiquement si la réunion n'a pas commencé.
- Chaque organisateur ne voit que son propre lien organisateur. Les autres liens restent chiffrés.
- Le lien organisateur est lié à l'`external_id` du compte organisateur. Un autre compte connecté, même avec le lien, reçoit 403.
- Si un organisateur ouvre un lien participant, le web le redirige vers son propre lien organisateur avant toute création de session. Les sessions participantes actives du même identifiant sont fermées.
- La présence agrège les sessions par identifiant externe et affiche le rôle organisateur si l'utilisateur a rejoint en tant qu'organisateur.

## Accès public

Le mode public est un booléen de réunion, activé à la création ou modifiable par un organisateur. Il ne supprime pas l'authentification web, conformément à la règle d'accès précédente.

- Réunion privée : le lien participant générique utilise le nom et l'identifiant du compte connecté.
- Réunion publique : le lien participant générique demande un nom affiché avant l'entrée. Le nom est conservé pour cette réunion via un cookie chiffré, lié au compte.
- Les liens participants nominatifs conservent toujours le nom inscrit dans le jeton.
- Un organisateur qui ouvre un lien participant est toujours basculé vers son lien organisateur avant l'étape du nom public.

## Salle d'attente

- Chaque réunion porte le mode `waiting_room`, activé à la création et modifiable par un organisateur.
- Participant : après résolution du lien, la session est créée avec `admission_status=waiting`. La page affiche « En attente d'admission » et reçoit sa décision par SSE. Aucun JWT Jitsi n'est émis avant l'admission.
- Organisateur : il entre directement. Son panneau « Modération » liste les participants en attente et permet d'admettre, de refuser ou d'exclure durablement.
- L'admission côté API exige au moins un organisateur effectivement connecté à Jitsi. Sans organisateur présent, l'admission renvoie 409 et tout le monde attend.
- Le mode peut être activé ou désactivé pendant la réunion depuis la fiche web. La désactivation admet automatiquement toutes les personnes en attente, avec un événement par session.
- Les participants en attente ne rejoignent pas Jitsi, ne sont pas comptés dans la présence et ne peuvent ni chatter ni envoyer de capture.
- Un organisateur qui arrive par un lien participant est automatiquement converti en organisateur et peut donc admettre.

## Modération en direct

Le panneau « Modération » de la salle est réservé au rôle organisateur, lui-même issu du lien. Toutes les commandes passent par la session de réunion de l'organisateur, jamais par la clé maître.

- Micro : couper ou autoriser le micro d'un participant, ou couper tous les micros.
- Caméra : couper ou autoriser la caméra d'un participant.
- Partage d'écran : arrêter ou autoriser le partage.
- Chat : activer ou désactiver le chat de la réunion.
- Exclusion : marquer la session exclue, fermer sa connexion et créer une interdiction de réunion liée à son `external_id` et, pour un lien nominatif, à son jeton. Toute nouvelle résolution ou jointure avec le même lien renvoie 403 avec `details.code=excluded`. Un participant exclu déjà connecté reçoit l'événement et raccroche.
- Salle d'attente : admettre une sélection, tout admettre, refuser une demande ou exclure durablement.
- Fin anticipée : l'organisateur termine la réunion pour tous. Les autres salles reçoivent `meeting.ended` et raccrochent.

Les politiques média sont appliquées côté navigateur du participant : s'il tente de réactiver son micro, sa caméra ou son partage alors qu'un organisateur l'a coupé, la page le recoupe immédiatement et affiche un message. Pour le chat, la page masque le panneau et l'API refuse aussi l'enregistrement des messages lorsque le chat est désactivé.

## Suppression des artefacts

Depuis la fiche de réunion, un organisateur peut supprimer chaque artefact. Le web appelle l'API `DELETE /api/v1/artifacts/{id}`.

- Suppression de l'objet S3.
- Suppression de la copie locale Jibri pour un enregistrement.
- Suppression de la ligne de métadonnées.
- Les URLs présignées déjà émises, d'une durée maximale de 900 secondes, renvoient 404 après suppression.
- Aucune expiration automatique.
- Aucune restauration possible.

## Architecture

```text
Navigateur du créateur
  └── projet web A http://localhost:3090
        ├── comptes, sessions, propriété des réunions
        ├── appels API serveur à serveur avec la clé maître
        ├── jetons de liens chiffrés dans sa propre SQLite
        └── abonnement SSE aux événements de l'API

Navigateur participant
  └── projet web A ou B /m/{jeton}
        ├── session web requise, retour automatique après connexion
        ├── vues attente / consentement / salle / terminée / annulée
        ├── iframe Jitsi https://meet.localhost:9443  (JWT court, rôle du lien)
        ├── SSE navigateur pour admission, médias, modération et fin
        └── proxy des événements et captures vers l'API

API Node (SQLite + S3), sans interface et sans comptes
  ├── crée les réunions et les jetons de liens neutres
  ├── signe les JWT Jitsi avec le rôle du lien
  ├── gère sessions, admission, présence, chat, médias et exclusions
  ├── publie un journal d'événements durable + SSE + webhooks HMAC
  ├── pilote Jibri via son API HTTP interne
  ├── importe les MP4 Jibri vers S3 avec reprise
  └── publie attendance.json et chat.json à la fin

Projet web B (comptes séparés, autre WEB_CLIENT_ID)
  └── même API, mêmes jetons de liens, même système

Jibri ◀── startService / stopService ── API
  └── MP4 composite audio + vidéo + écran → volume → API → S3

Page participant (web) ── chunks audio Opus 20 s ──> proxy web ──> API ──> worker faster-whisper
                                                                        └── transcript JSON/TXT/SRT/VTT → S3
```

Services Compose : `web` (Jitsi), `frontend` (projet web consommateur), `prosody`, `jicofo`, `jvb`, `jibri` (profil `recording`), `api` (headless), `rustfs`, `transcriber` (profil `transcription`).

### Pourquoi RustFS ?

L'environnement de démonstration n'a pas accès aux images MinIO sur Docker Hub. RustFS 1.0.4 (ghcr.io) expose l'API S3 utilisée par l'API et le worker : buckets, PUT/GET/DELETE, URLs présignées. Le code est compatible avec MinIO, AWS S3, Scaleway ou Garage : seules les variables `S3_*` changent.

## Règles de créneau

`opens_at = starts_at - early_join_minutes` (0 par défaut).

| Moment | Comportement |
|---|---|
| Avant `opens_at` | Page d'attente avec heure de Paris, compte à rebours local et SSE pour les changements de créneau. |
| Entre `opens_at` et `ends_at` | Connexion possible. Un JWT Jitsi est émis à l'ouverture de la page. |
| 3 minutes avant `ends_at` | Bandeau d'avertissement dans la salle (`END_WARNING_MINUTES`). |
| À `ends_at` | La page raccroche, la session est clôturée, les nouveaux JWT sont refusés. Le scheduler finalise la réunion en moins de 5 s. |
| Après `ends_at` | Tous les liens affichent « Réunion terminée ». |
| Annulée | Tous les liens affichent « Réunion annulée ». |

Le JWT Jitsi porte `nbf = maintenant - 60 s` et `exp = ends_at`. Un jeton présenté après la fin est refusé par Prosody pour une nouvelle connexion. La coupure des clients déjà connectés est assurée par la page de réunion (timer local de fin et événement SSE `meeting.ended`). Voir la section Limites pour le cas d'un JWT extrait et utilisé hors de la page fournie.

### Modification, annulation, fin

- `PATCH` : possible uniquement tant que la réunion est `scheduled` et qu'aucun participant n'a rejoint. Modifie `title`, `starts_at`, `ends_at`, `early_join_minutes`, `recording`, `transcription`, `chat`. Les liens restent valides.
- `POST /cancel` : uniquement avant le début effectif. La réunion passe à `cancelled`.
- `POST /end` : termine immédiatement une réunion `scheduled` ou `in_progress`, ferme les présences, produit les artefacts et déclenche les webhooks.

Une réunion terminée ne peut plus être modifiée. Les durées acceptées vont de 30 minutes à 8 heures. Les identifiants externes doivent être uniques dans une réunion.

## Liens

| Lien | Route | Droits |
|---|---|---|
| Organisateur nominatif | `/m/{jeton}` sur le web | Modérateur Jitsi, réservé au compte organisateur nominatif |
| Participant nominatif | `/m/{jeton}` sur le web | Participant, nom et `external_id` figés par le lien |
| Participant générique | `/m/{jeton}` sur le web | Participant avec le nom du compte, ou nom demandé si la réunion est publique |

Tous les liens de réunion passent par le projet web. Sans session web, redirection vers la connexion avec retour automatique sur le lien. Une session déjà présente dans le navigateur ouvre directement la salle, même dans un nouvel onglet.

Les jetons font 256 bits aléatoires (`crypto.randomBytes(32)`), sont hachés SHA-256 en base et ne sont jamais dérivés du nom de salle, de l'identifiant de réunion ou d'un autre lien. Plusieurs organisateurs disposent chacun d'un lien nominatif. L'API ne génère aucune URL : elle renvoie uniquement des jetons. Chaque projet web décide de sa route, ici `/m/{jeton}`. Un jeton créé par un projet web fonctionne sur un autre projet web connecté à la même API, à condition que l'utilisateur y possède un compte et que le lien organisateur corresponde à son identifiant.

Un organisateur qui ouvre un lien participant est redirigé vers son propre lien organisateur avant toute création de session. Si son lien est indisponible, il reçoit une erreur, jamais une session participante. Les sessions participante actives du même identifiant sont fermées quand il rejoint en organisateur.

La salle Jitsi a un nom aléatoire (`pm` + 12 octets hexadécimaux). Sans JWT valide, Jitsi refuse la connexion (`ENABLE_AUTH=1`, `AUTH_TYPE=jwt`, `JWT_ALLOW_EMPTY=0`). Le navigateur ne reçoit le JWT et le nom de salle qu'après authentification web et résolution du lien. Une URL de réunion inventée ou modifiée ne correspond à aucun jeton en base : elle renvoie 404, ne crée aucune session et n'ouvre aucune salle. Le rôle, la réunion et le créneau sont revérifiés côté API à chaque résolution, jointure, changement de statut et action de modération.

## API

Authentification : en-tête `X-API-Key: $MASTER_API_KEY` (ou `Authorization: Bearer ...`). Aucune autre clé dans le système.

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/v1/meetings` | Créer une réunion et ses liens |
| GET | `/api/v1/meetings?status=&limit=` | Lister |
| GET | `/api/v1/meetings/{id}` | Détail, capacité, état du créneau |
| PATCH | `/api/v1/meetings/{id}` | Modifier avant le début ; `waiting_room`, `public_access` et `chat` restent modifiables pendant la réunion |
| POST | `/api/v1/meetings/{id}/cancel` | Annuler avant le début |
| POST | `/api/v1/meetings/{id}/end` | Terminer maintenant |
| POST | `/api/v1/meetings/{id}/links` | Ajouter un lien avant le début, retourne un `token` |
| GET | `/api/v1/meetings/{id}/waiting` | Participants en attente d'admission |
| POST | `/api/v1/meetings/{id}/waiting/admit` | Admettre une sélection ou tout le monde |
| GET | `/api/v1/meetings/{id}/processing` | État et erreurs de l'enregistrement et de la transcription |
| POST | `/api/v1/meetings/{id}/processing/retry` | Rejouer un traitement en échec (`recording`, `transcription`, `all`) |
| GET | `/api/v1/meetings/{id}/attendance` | Entrées, sorties, totaux |
| GET | `/api/v1/meetings/{id}/chat` | Historique du chat |
| GET | `/api/v1/meetings/{id}/artifacts` | Artefacts disponibles (`attendance`, `chat`, `recording`, `transcript_json`, `transcript_txt`, `transcript_srt`, `transcript_vtt`) |
| GET | `/api/v1/meetings/{id}/webhooks` | Journal des livraisons |
| GET | `/api/v1/artifacts/{id}` | Métadonnées |
| GET | `/api/v1/artifacts/{id}/url` | URL présignée, expiration 900 s maximum |
| GET | `/api/v1/artifacts/{id}/download` | Redirection vers l'URL présignée |
| DELETE | `/api/v1/artifacts/{id}` | Suppression définitive |
| GET | `/api/v1/events/stream` | Flux SSE durable des événements, reprise via `last_event_id` |
| GET | `/health` | Santé de l'API, base de données incluse |

Les réponses de création contiennent `links.organizers[].token`, `links.participants[].token` et `links.generic_participant.token`. Aucune URL de web n'est fabriquée par l'API. L'en-tête `x-client-id` identifie le projet web appelant ; il est journalisé et stocké sur la réunion (`client_id`), sans servir d'authentification.

Endpoints publics de lien, sans clé maître, authentifiés par le jeton de lien lui-même :

- `POST /api/v1/links/resolve` avec `{token}` : résout le rôle, la réunion et le créneau. Renvoie 403 `excluded` si l'identité du lien est exclue.
- `POST /api/v1/links/join` avec `{token, display_name?, external_id?, session_token?}` : crée ou réutilise une session de réunion, applique la salle d'attente et renvoie le JWT Jitsi uniquement si la session est admise. Un participant exclu reçoit 403 `excluded`.
- `POST /api/v1/links/resolve` et `/join` sont limités en débit par adresse IP et ne permettent aucune création de réunion.

Endpoints de session de réunion, authentifiés par `Authorization: Bearer {session_token}` et non par la clé maître :

- `GET /api/session/status` : état, rôle, admission et politiques média.
- `POST /api/session/events` : jointure, heartbeat, sortie, chat, fin de capture.
- `POST /api/session/capture` : chunks audio de transcription.
- `GET /api/session/waiting` : file d'attente, réservé à l'organisateur connecté.
- `GET /api/session/participants` : participants connectés, attente et exclusions, réservé à l'organisateur.
- `POST /api/session/moderation` : `set_media`, `mute_all`, `admit`, `reject`, `exclude`, `chat`, `end`, réservé à l'organisateur connecté. L'API vérifie le rôle de la session à chaque requête.

Le web expose un proxy same-origin `/room-api/*` qui transmet le jeton de session de réunion à ces endpoints. Il expose aussi `/room-api/session/stream`, flux SSE navigateur, et `/m/{jeton}/events`, flux SSE minimal pour la page d'attente avant ouverture. Aucun CORS n'est ouvert sur l'API.

### Consommer l'API depuis un autre projet web

1. Déployer le projet web avec `API_INTERNAL_URL`, `MASTER_API_KEY`, `WEB_BASE_URL`, `WEB_SESSION_SECRET`, `WEB_ENCRYPTION_KEY` et un `WEB_CLIENT_ID` distinct.
2. Créer les réunions et les liens via les routes de gestion avec `X-API-Key` et `X-Client-ID`.
3. Composer les URL de ce projet avec les jetons reçus.
4. Appeler `/api/v1/links/resolve` et `/api/v1/links/join` depuis le serveur du projet web pour l'accès utilisateur.
5. Ouvrir `/api/v1/events/stream` en SSE avec la clé maître pour recevoir les événements et les pousser au navigateur.
6. Gérer les comptes, l'authentification, la propriété et les organisateurs dans la base du projet web. L'API ne reçoit que des `external_id` opaques.

Deux projets web peuvent partager la même API et la même base de réunions. Un jeton de lien reste valide quel que soit le projet web qui l'a créé, tant que ce projet transmet le jeton et un `external_id` stable pour l'utilisateur.

### Exemples

Modifier le créneau :

```bash
curl -sS -X PATCH http://localhost:3080/api/v1/meetings/$ID \
  -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{"starts_at":"2026-11-05T15:00:00+01:00","ends_at":"2026-11-05T16:00:00+01:00"}'
```

Présence :

```bash
curl -sS -H "X-API-Key: $KEY" \
  http://localhost:3080/api/v1/meetings/$ID/attendance | python3 -m json.tool
```

Réponse : `participants[]` avec `display_name`, `external_id`, `role`, `total_seconds`, sessions détaillées ; `entries[]` avec chaque `joined`/`left` horodaté.

Chat :

```bash
curl -sS -H "X-API-Key: $KEY" \
  http://localhost:3080/api/v1/meetings/$ID/chat | python3 -m json.tool
```

Chaque message contient `author.display_name`, `author.external_id`, `author.role`, `timestamp`, `message`.

URL temporaire et suppression :

```bash
curl -sS -H "X-API-Key: $KEY" \
  http://localhost:3080/api/v1/artifacts/$ARTIFACT_ID/url
# {"url":"...","expires_at":"...","expires_in_seconds":900}

curl -sS -X DELETE -H "X-API-Key: $KEY" \
  http://localhost:3080/api/v1/artifacts/$ARTIFACT_ID
```

`DELETE` supprime l'objet S3, la copie locale Jibri éventuelle et la ligne de métadonnées. Une URL présignée déjà émise renvoie ensuite 404 chez S3/RustFS. Une nouvelle demande sur l'artefact renvoie 404. Aucune restauration n'est possible.

## Webhooks

Configurer `WEBHOOK_URL` et `WEBHOOK_SECRET` dans `.env`, puis redémarrer l'API. Receveur de démonstration :

```bash
node --env-file=.env scripts/webhook-receiver.js
# Dans .env : WEBHOOK_URL=http://host.docker.internal:4555/webhook
```

Événements : `meeting.created`, `meeting.updated`, `meeting.started`, `meeting.ended`, `meeting.cancelled`, `attendance.ready`, `chat.ready`, `recording.ready`, `recording.updated`, `transcript.ready`, `transcript.failed`, `session.joined`, `session.left`, `waiting.updated`, `admission.updated`, `media.policy`, `media.broadcast`, `participant.excluded`, `chat.message`, `artifact.deleted`, `processing.updated`.

Le même journal alimente le flux SSE `GET /api/v1/events/stream`. Chaque événement possède un `seq` croissant. Le consommateur peut se reconnecter avec `Last-Event-ID` ou `?last_event_id={seq}` pour rejouer les événements manqués depuis la base. Le web conserve ce curseur dans sa propre base, ce qui couvre un redémarrage du web comme de l'API. Le flux envoie un `stream.ready` avec `latest_seq` pour détecter une réinitialisation de base. Le journal conserve les 10 000 derniers événements ; les états courants restent disponibles par les endpoints de statut et de détail.

En-têtes :

```text
X-Webhook-Event: meeting.ended
X-Webhook-Timestamp: 1793780000
X-Webhook-Signature: t=1793780000,v1=<hmac_sha256(secret, "timestamp.rawBody")>
```

Le corps brut signé est le JSON exact envoyé. Trois tentatives avec backoff ; le journal est consultable via `GET /api/v1/meetings/{id}/webhooks`.

## Enregistrement

- Jibri enregistre un MP4 composite audio + vidéo + partage d'écran, comme à l'écran.
- L'API pilote Jibri elle-même via son API HTTP interne (`startService` / `stopService`). Dès qu'une première session admise rejoint une réunion avec enregistrement activé, l'API démarre Jibri sans dépendre d'un clic organisateur.
- L'API suit `recording_state` (`idle`, `pending`, `active`, `failed`, `stopped`) et expose l'état dans la fiche de réunion et la pastille de la salle. Chaque changement est aussi poussé par SSE (`recording.updated`).
- À la fin, l'API arrête Jibri, le MP4 est déposé dans le volume partagé, puis l'API le détecte, l'envoie dans S3 sous `meetings/{id}/recording/` et émet `recording.ready`. L'artefact `recording` fait partie de la liste d'artefacts de la réunion.
- Les envois de MP4 sont suivis dans `recording_uploads` avec statut, tentatives et erreur. Un échec est visible dans `GET /api/v1/meetings/{id}/processing` et rejouable par `POST .../processing/retry`. Un fichier déjà présent dans S3 n'est jamais réenvoyé, même après redémarrage.
- Le consentement à l'enregistrement est géré par le projet web avant l'appel `join`. L'API l'ignore totalement et se contente de maintenir l'indicateur visible dans la salle : pastille dans la barre et notification Jitsi sticky `pm-recording-indicator`, visible même en plein écran.
- Une seule réunion avec enregistrement peut être active à la fois (`MAX_CONCURRENT_RECORDINGS=1`) sur ce nœud Jibri. Une deuxième réunion d'enregistrement chevauchante est refusée en 409 afin de garantir la production de l'artefact.
- Jibri doit être lancé avec le profil `recording` et son API HTTP est exposée uniquement sur le réseau Docker interne via `config/jibri-custom.conf`.
- Suppression par API uniquement, sans expiration automatique.

Limites : Jibri réel n'a pas été exécuté dans cet environnement. Le contrat HTTP start/stop et le déclenchement automatique ont été validés avec un faux Jibri sur le réseau Docker. L'enregistrement démarre au premier participant admis ; une réunion sans aucun participant ne produit pas de MP4. Si Jibri est indisponible, `recording_state=failed` est visible, rejouable pendant la réunion et aucun artefact n'est fabriqué. Un redémarrage de l'API ne perd ni les artefacts déjà produits ni les fichiers MP4 en attente d'envoi.

## Transcription

Approche retenue pour garantir l'attribution du locuteur sans diarisation sur une piste mixte :

1. Chaque page participant capture son propre microphone, en chunks Opus de 20 s envoyés à l'API. Les périodes de micro coupé sont mémorisées.
2. Après la réunion, le worker `faster-whisper` (modèle auto-hébergé, langue française forcée) transcrit chaque piste séparément.
3. Les segments sont fusionnés par horodatage, filtrés sur les périodes muettes et attribués à `display_name` + `external_id` + `role`.
4. Le worker écrit quatre artefacts dans S3 et émet `transcript.ready` :
   - `transcript_json` : segments `start`, `end`, `started_at`, `ended_at`, `speaker`, `text`
   - `transcript_txt` : texte lisible avec `[HH:MM:SS] Nom (external_id): ...`
   - `transcript_srt`
   - `transcript_vtt`
5. Les captures audio brutes sont supprimées après succès. Un échec émet `transcript.failed` et laisse les captures pour diagnostic.
6. Le worker envoie un heartbeat toutes les 45 s. Un job `processing` sans heartbeat depuis 5 minutes est remis en file au démarrage de l'API et périodiquement. Un job en échec est visible dans `GET /api/v1/meetings/{id}/processing` et rejouable par `POST .../processing/retry`.

Le modèle est téléchargé une fois puis mis en cache dans le volume `whisper-models`. Aucun appel à un service de reconnaissance externe à l'exécution. `WHISPER_MODEL=tiny|base|small|medium` permet d'arbitrer vitesse et qualité ; `small` par défaut. Le premier chargement du modèle peut prendre plusieurs minutes sur CPU, même avec `tiny`.

Limites : la transcription dépend de l'autorisation micro de la page (origine de l'application, distincte de l'iframe Jitsi). Un participant qui refuse la capture n'apparaîtra pas dans la transcription, même s'il est présent dans la visio. Une réunion de 8 h avec 30 pistes demande un temps de calcul important ; le délai de quelques heures est accepté par le cahier des charges. Les fichiers n'ont pas d'expiration automatique ; seule l'API les supprime.

## Configuration `.env`

Le fichier `.env` est l'unique source de configuration. `scripts/init-env.sh` génère des secrets aléatoires pour :

- `MASTER_API_KEY` : clé unique de l'API
- `JWT_APP_SECRET` : secret HS256 partagé entre l'API et Prosody
- mots de passe internes XMPP (`JICOFO`, `JVB`, `JIBRI`, `JIGASI`)
- clés S3 RustFS
- secret de signature des webhooks
- `WEB_SESSION_SECRET` et `WEB_ENCRYPTION_KEY` pour l'interface web

Variables principales :

| Variable | Rôle |
|---|---|
| `APP_BASE_URL` | URL publique de l'API, utilisée dans ses réponses et redirections d'artefacts |
| `PUBLIC_URL`, `JITSI_PUBLIC_URL` | URL publique de Jitsi |
| `JITSI_PUBLIC_HOST` | Hôte utilisé par Jibri pour joindre Jitsi via `host-gateway` |
| `JWT_APP_ID`, `JWT_APP_SECRET`, `JWT_ACCEPTED_AUDIENCES` | Authentification Jitsi |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` | Endpoint interne et endpoint navigateur pour les URLs présignées |
| `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_PRESIGN_TTL_SECONDS` | Stockage |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | Webhooks |
| `MAX_PARTICIPANTS`, `MAX_CONCURRENT_MEETINGS` | Limites |
| `MIN_MEETING_MINUTES`, `MAX_MEETING_MINUTES`, `MAX_EARLY_JOIN_MINUTES` | Fenêtre et marge |
| `END_WARNING_MINUTES` | Avertissement avant la fin |
| `WHISPER_MODEL`, `WHISPER_LANGUAGE` | Transcription |
| `JIBRI_HTTP_API_URL` | API HTTP interne de Jibri, `http://jibri:2222` |
| `JIBRI_CALL_LOGIN_DOMAIN` | Domaine XMPP caché du recorder, `hidden.meet.jitsi` |
| `MAX_CONCURRENT_RECORDINGS` | Réunions avec enregistrement simultanées, `1` sur un seul Jibri |
| `WEB_PORT`, `WEB_BASE_URL` | Interface web et URL publique ; sert à composer `/m/{jeton}` |
| `WEB_CLIENT_ID` | Identifiant du projet web, `web` par défaut ; distinct pour chaque projet qui partage l'API |
| `API_INTERNAL_URL` | URL de l'API vue par le conteneur web, `http://api:3080` |
| `WEB_DB_PATH` | Base SQLite des comptes, sessions, consentements et jetons chiffrés |
| `WEB_SESSION_SECRET`, `WEB_ENCRYPTION_KEY` | Secrets de session et de chiffrement des liens |
| `TRUST_PROXY` | `1` si un proxy de confiance termine TLS devant l'API, pour le limiteur de débit des liens |
| `TRUSTED_PROXIES` | Liste d'adresses de proxies de confiance séparées par des virgules, optionnelle |
| `BRAND_NAME`, `BRAND_COLOR`, `BRAND_LOGO_URL`, `BRAND_FOOTER` | Branding des interfaces |
| `DISPLAY_TIMEZONE` | Fuseau d'affichage, `Europe/Paris` par défaut |

## Sécurité

- Une seule clé maître API de gestion. Elle n'est utilisée que par les serveurs des projets web, jamais transmise au navigateur. Aucun compte utilisateur côté API : l'identité vient du projet web pour le lien générique, ou du jeton nominatif pour les liens organisateur et participant nommé.
- Séparation stricte : l'API ne sert aucune page, aucun formulaire, aucun asset et aucun back-office. Elle ne crée pas de compte et ne gère aucun mot de passe. Les seuls rôles API sont `organizer` et `participant`, déterminés par le jeton de lien et revérifiés à chaque connexion et action de session.
- Les routes de gestion exigent la clé maître. Les routes de lien sont authentifiées par le jeton lui-même, avec limitation de débit ; elles ne permettent ni création de réunion ni énumération.
- Un participant exclu reçoit 403 à la résolution et à la jointure avec le même lien. L'exclusion est liée à l'`external_id` fourni par le projet web et, pour un lien nominatif, au jeton. La salle déjà connectée reçoit l'événement d'exclusion.
- Interface web : mots de passe scrypt, sessions HttpOnly, CSRF, contrôle de propriété, jetons organisateur/participant chiffrés AES-256-GCM, consentement à l'enregistrement. La clé maître reste côté serveur et n'apparaît dans aucune page.
- Inscription ouverte dans ce MVP. Pour une mise en production, ajouter vérification d'e-mail, limitation de débit, récupération de mot de passe et éventuellement une liste d'invitation.
- Jetons de liens aléatoires 256 bits, hachés en base, routés séparément. Un participant ne peut pas déduire le lien organisateur du sien.
- Tous les liens de réunion exigent une session web. Le paramètre `next` est limité aux chemins `/m/{jeton}` pour éviter les redirections ouvertes.
- Les liens organisateurs sont liés au compte nominatif et à une ligne organisateur active. Un lien volé reste inutilisable par un autre compte.
- L'admission en salle d'attente est refusée côté API sans organisateur connecté. Les participants en attente n'obtiennent aucun JWT.
- Le web conserve un cookie de session de réunion par jeton, HttpOnly, pour réutiliser la même présence lors d'un rechargement ou d'un nouvel onglet du même navigateur.
- JWT Jitsi HS256 signé par l'API seule. `context.user.moderator` est vrai uniquement pour un lien organisateur. `room`, `exp`, `nbf`, `iss`, `aud` sont vérifiés par Prosody.
- Les médias WebRTC passent par JVB avec DTLS-SRTP, configuration par défaut de Jitsi. Aucun média ne transite par l'API.
- Jitsi exige un JWT : impossible de rejoindre une room directement sans passer par le web et l'API. Le nom de room et le JWT ne sont transmis qu'à la salle web après authentification et résolution du lien.
- Chat privé désactivé, profil désactivé, nom d'affichage issu du JWT, préjoin désactivé.
- URLs S3 présignées limitées à 900 s, jamais stockées en base. Suppression = suppression de l'objet puis des métadonnées.
- Webhooks signés HMAC-SHA256 avec horodatage. Flux SSE API réservé à la clé maître ; le navigateur ne voit que le flux filtré du projet web, protégé par le jeton de session de réunion.
- Les commandes de modération utilisent la session organisateur, pas la clé maître. Un participant ne peut ni cibler un autre participant ni s'auto-admettre : l'API vérifie le rôle et l'appartenance de la cible à la réunion.
- Pages web : `no-store`, `Referrer-Policy: no-referrer`, CSP, `X-Frame-Options: DENY`. API : en-têtes `no-store` et `nosniff`, aucune CSP de page inutile.
- Journaux structurés JSON côté API et web, avec identifiant de requête, chemin sans jeton et sans secret.
- En production : terminer TLS devant l'interface web (3090) et l'API (3080), mettre `WEB_BASE_URL` en HTTPS pour le cookie `Secure`, restreindre les ports S3/JVB/Jitsi, remplacer le certificat auto-signé, isoler RustFS sur un réseau privé, sauvegarder les bases SQLite (API et web) et le bucket.

## Limites connues du MVP

1. **Coupure de fin** : la page de réunion raccroche à l'heure de fin et le JWT empêche les nouvelles connexions. Un participant qui extrait le JWT et se connecte à Jitsi hors de la page fournie ne sera pas expulsé côté serveur à l'heure de fin, car Jitsi vérifie le jeton à la connexion. Durcissement production : détruire la MUC via un bot XMPP modérateur ou Jicofo à `ends_at`.
2. **Enregistrement** : Jibri réel n'a pas été exécuté dans cet environnement (image lourde, profil fourni). Le démarrage automatique par l'API, le contrat HTTP Jibri, l'arrêt, la capacité, le watcher S3, le webhook et la suppression sont en place et le déclenchement a été testé avec un faux Jibri.
3. **Fin de réunion manuelle** : les pages déjà ouvertes reçoivent `meeting.ended` par SSE et raccrochent en moins d'une seconde. Les JWT émis avant l'arrêt gardent leur `exp` d'origine.
4. **Transcription** : dépend de la capture micro côté page. Pas de diarisation de secours sur l'enregistrement composite. Le worker ne traite pas les réunions sans aucune capture (webhook `transcript.failed`).
5. **Présence** : calculée à partir des événements de la page. Une fermeture brutale du navigateur est clôturée à la fin du créneau ou après le dernier heartbeat. Le temps affiché est une approximation à quelques secondes.
6. **Chat** : activable par réunion. Capturé via l'API externe Jitsi (`incomingMessage` / `outgoingMessage`) et dédoublonné. Les messages privés sont désactivés. L'`external_id` est rattaché par le nom affiché ; deux participants portant exactement le même nom dans une réunion peuvent rendre cette attribution ambiguë.
7. **Dimensionnement** : un seul JVB, un seul Jibri. Les cibles 10 réunions / 300 connexions / plusieurs enregistrements simultanés exigent plusieurs JVB/Jibri, un objectif de placement et une file d'enregistrement. Le présent compose est mono-nœud.
8. **Branding Jitsi** : les interfaces applicatives sont brandées par `.env`. Le watermark Jitsi natif dans l'iframe n'est pas remplacé par un logo client dans ce MVP.
9. **SQLite** : adapté au prototype mono-instance. Pas de haute disponibilité.
10. **Authentification web** : inscription ouverte, pas de vérification d'e-mail ni de récupération de mot de passe. Les liens sont conservés chiffrés dans la base web : si `WEB_ENCRYPTION_KEY` ou cette base est perdue, l'API ne peut pas régénérer les liens existants.
11. **Participants** : aucun accès anonyme. Chaque participant doit créer ou utiliser un compte web. Le lien générique utilise le nom et l'identifiant du compte connecté ; le lien nominatif conserve l'identité inscrite dans le jeton.
12. **API directe** : elle reste utilisable avec la clé maître pour les tests et intégrations. Les projets web sont les seuls composants à utiliser cette clé côté serveur ; le navigateur ne la reçoit jamais. L'API ne sert aucune page et retourne uniquement du JSON, des artefacts signés et des flux SSE.
13. **Invitations** : aucun e-mail n'est envoyé par le prototype. L'invitation par adresse crée un lien dès que le compte existe ou s'inscrit. L'adresse n'est pas vérifiée, ce qui suppose une inscription de confiance.
14. **Enregistrement** : un seul Jibri sur ce nœud, donc une seule réunion enregistrée à la fois. L'enregistrement démarre au premier participant admis, pas avant. Jibri réel non exécuté dans cet environnement ; le pilotage HTTP a été validé avec un faux Jibri.
15. **Salle d'attente** : une session en attente abandonnée sans fermeture propre reste listée jusqu'à la fin du créneau ; elle n'entre pas dans la présence. Le mode est modifiable pendant la réunion depuis la fiche web, pas depuis la salle.
16. **Multi-web** : plusieurs projets web peuvent partager une API et une clé maître. Le prototype ne fournit pas de clé par projet ni d'isolation forte entre projets web ; un projet web de confiance voit les événements de l'API et peut appeler toutes les routes de gestion. Pour une isolation stricte, ajouter une clé par projet et un propriétaire de réunion côté API.
17. **Modération média** : les coupures micro, caméra et partage sont appliquées par la page du participant, sur décision serveur. Un client qui contournerait la page fournie pourrait ignorer la politique locale ; le JWT Jitsi reste la seule barrière d'accès à la salle.

## Vérifications effectuées

- Démarrage Compose de `web`, `frontend`, `prosody`, `jicofo`, `jvb`, `api`, `rustfs`.
- Interface web : inscription, connexion, tableau de bord, création, modification, annulation et fin d'une réunion via l'API. CSRF refusé sans jeton (403), accès d'un autre compte refusé (404), téléchargement d'artefact protégé et fonctionnel.
- Chat désactivable par réunion : l'interface Jitsi masque le chat et retire la fonctionnalité ; une tentative d'envoi via l'API est refusée en 403.
- Liens web : organisateur et participant affichés au créateur, chiffrés en base, aucune clé maître dans le HTML.
- Accès sans session : redirection vers la connexion avec `next`. Connexion ou inscription : retour automatique sur le lien. Session déjà présente : accès direct à la salle, sans redirection, y compris dans un second onglet.
- Salle web : iframe Jitsi chargée dans le web, événements de présence et captures audio transmis par le proxy web ; un client Chrome headless a rejoint la réunion avec le nom de l'organisateur.
- Lien participant générique : identité reprise du compte web connecté ; présence enregistrée avec cet identifiant.
- Présence : événement `joined`, passage de la réunion à `in_progress`, total de temps calculé.
- Capture audio : chunks Opus reçus par l'API et stockés par session, y compris deux chunks successifs transmis via le proxy web.
- S3 : bucket créé, artefacts `attendance` et `chat` téléversés, URL présignée 900 s, suppression, ancienne URL en 404, nouvelle demande en 404.
- Webhooks : `meeting.created`, `meeting.ended`, `attendance.ready`, `chat.ready` reçus avec signature HMAC valide.
- Limites : 10 réunions simultanées acceptées, 11e refusée en 409.
- Attente, annulation, page terminée, mise à jour de créneau vérifiées.
- Transcription : testée de bout en bout sur un audio français de synthèse avec le modèle `tiny` ; deux segments produits, attribution correcte à `Alice Martin` / `u-alice` / `organizer`, et quatre artefacts JSON/TXT/SRT/VTT envoyés dans S3. Le premier chargement du modèle a pris plusieurs minutes sur CPU.
- Organisateurs : ajout d'un compte existant, invitation en attente puis activation à l'inscription, tableau de bord partagé, lien organisateur lié au compte. Un autre compte reçoit 403. Un organisateur qui ouvre un lien participant est redirigé vers son lien organisateur et n'apparaît pas en participant.
- Réunion publique : le lien générique affiche le formulaire de nom, le nom choisi est repris dans la salle et la présence.
- Salle d'attente : participant en lobby, organisateur voyant la liste via l'interface, admission d'une sélection ou de tous, refus d'une demande puis nouvelle tentative, refus d'admission sans organisateur présent (409), désactivation du mode qui admet automatiquement.
- Enregistrement : déclenchement automatique dès la première session admise, payload `startService` correct, arrêt à la fin, capacité d'une réunion enregistrée à la fois (deuxième refusée en 409). Testé avec un faux Jibri sur le réseau Docker.
- Suppression d'artefact depuis le web : objet S3 et métadonnées supprimés, artefact retiré de la liste. Ancienne URL présignée en 404.
- Séparation API/web : création refusée sans clé maître (401), résolution et jointure d'un lien sans clé maître, réponse de création sans URL (jetons uniquement), racine API JSON et absence de pages `/o/`, `/j/`, `/static`.
- Multi-web : second projet web indépendant sur le port 3190, base de comptes séparée, même API, `client_id=web2` enregistré côté API. Un jeton participant créé par ce second web a été résolu et ouvert sur le premier web.
- Événements : flux SSE API avec reprise par `last_event_id`, web connecté en persistant, événements `waiting.updated`, `admission.updated`, `session.joined`, `media.policy`, `participant.excluded`, `meeting.ended` observés dans l'ordre.
- Salle sans boucle : lobby et salle reçoivent l'admission, les médias et la fin par SSE ; le panneau de modération se met à jour sur événements, pas par intervalle HTTP.
- Navigateur réel (Chrome headless, deux contextes) : connexion organisateur et participante, consentement, formulaire de nom public, lobby, admission par le panneau, salle Jitsi des deux côtés, notification de micro coupé, exclusion avec éjection et page 403, puis fin de réunion depuis l'organisateur avec page terminale.
- Modération : coupure micro/caméra/partage, coupure globale des micros, chat activé/désactivé, exclusion et fin anticipée via la session organisateur. Un participant exclu reçoit l'événement et le même lien renvoie 403 `excluded` au web.
- Consentement : écran de consentement avant l'appel `join` pour une réunion enregistrée, acceptation persistée dans la base web, aucune connaissance côté API, pastille d'enregistrement visible dans la salle.
- Traitements : erreur Jibri et erreur Whisper injectées, affichées dans la fiche web avec boutons de relance, puis statut remis à `idle` / `pending` après `POST .../processing/retry`.
- Journaux : API et web en JSON, avec `request_id`, statut, durée et chemins sans jeton.

## Arborescence

```text
web/                 projet web : comptes, sessions, liens, salle et artefacts
  src/               server, SQLite, client API, événements SSE, vues
  public/            CSS, salle Jitsi, attente, lobby et modération
api/                 API Node headless : réunions, sessions, événements, artefacts
  src/               server, links, session, admin, events, finalize, webhooks, S3
transcriber/         worker faster-whisper avec heartbeat et reprise
scripts/             init-env.sh, webhook-receiver.js
config/              jibri-custom.conf : API HTTP Jibri sur le réseau interne
docker-compose.yml   Jitsi officiel + frontend + API + RustFS + Jibri + worker
.env.example         configuration complète, sans secrets
```
