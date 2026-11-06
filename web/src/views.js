'use strict';

const config = require('./config');
const {
  escapeHtml,
  parisDateLong,
  parisDateTime,
  parisShortDateTime,
  parisTime,
  formatDuration,
  formatBytes,
  statusInfo,
  artifactLabel,
  recordingStateLabel,
} = require('./util');

const BRAND = config.branding;

function brandMark() {
  if (BRAND.logoUrl) {
    return `<img class="brand-logo" src="${escapeHtml(BRAND.logoUrl)}" alt="${escapeHtml(BRAND.name)}">`;
  }
  return `<span class="brand-dot" aria-hidden="true"></span><span>${escapeHtml(BRAND.name)}</span>`;
}

function csrfField(csrf) {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">`;
}

function layout({ title, user = null, csrf = '', body = '', bodyClass = '', notice = '', error = '', noHeader = false, head = '', bodyData = '' }) {
  const header = user && !noHeader
    ? `<header class="topbar">
        <a class="brand" href="/dashboard">${brandMark()}</a>
        <nav class="topbar__nav">
          <a href="/dashboard">Mes réunions</a>
          <span class="topbar__user">${escapeHtml(user.name)}</span>
          <form method="post" action="/logout" class="inline-form">
            ${csrfField(csrf)}
            <button class="button button--quiet button--small" type="submit">Se déconnecter</button>
          </form>
        </nav>
      </header>`
    : '';
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)} · ${escapeHtml(BRAND.name)}</title>
  <link rel="stylesheet" href="/static/app.css">
  <link rel="stylesheet" href="/theme.css">
  ${head}
</head>
<body class="${escapeHtml(bodyClass)}" ${bodyData}>
${header}
${notice ? `<div class="flash flash--ok" role="status">${escapeHtml(notice)}</div>` : ''}
${error ? `<div class="flash flash--error" role="alert">${escapeHtml(error)}</div>` : ''}
${body}
<footer class="site-footer">${escapeHtml(BRAND.footer || BRAND.name)}</footer>
<script src="/static/app.js" defer></script>
</body>
</html>`;
}

function authPage({ mode, values = {}, error = '', csrf, next = '' }) {
  const isRegister = mode === 'register';
  const title = isRegister ? 'Créer un compte' : 'Connexion';
  return layout({
    title,
    csrf,
    bodyClass: 'page page--center',
    noHeader: true,
    body: `
      <main class="auth-card card">
        <a class="brand" href="/">${brandMark()}</a>
        <p class="eyebrow">${isRegister ? 'Nouveau compte' : 'Espace organisateur'}</p>
        <h1>${isRegister ? 'Créez votre espace' : 'Reprenez la main'}</h1>
        <p class="lede">${isRegister
          ? 'Un compte suffit pour créer et piloter vos réunions à créneau strict.'
          : 'Connectez-vous pour retrouver vos réunions, vos liens et vos artefacts.'}</p>
        ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ''}
        <form method="post" action="${isRegister ? '/register' : '/login'}" class="form">
          ${csrfField(csrf)}
          ${next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : ''}
          ${isRegister ? `
          <label>Nom affiché
            <input name="name" required minlength="2" maxlength="80" autocomplete="name" value="${escapeHtml(values.name || '')}" placeholder="Prénom Nom">
          </label>` : ''}
          <label>Adresse e-mail
            <input type="email" name="email" required autocomplete="email" value="${escapeHtml(values.email || '')}" placeholder="vous@exemple.fr">
          </label>
          <label>Mot de passe
            <input type="password" name="password" required minlength="8" maxlength="200" autocomplete="${isRegister ? 'new-password' : 'current-password'}" placeholder="8 caractères minimum">
          </label>
          ${isRegister ? `
          <label>Confirmer le mot de passe
            <input type="password" name="password_confirm" required minlength="8" maxlength="200" autocomplete="new-password">
          </label>` : ''}
          <button class="button" type="submit">${isRegister ? 'Créer mon compte' : 'Se connecter'}</button>
        </form>
        <p class="switch-link">${isRegister
          ? `Déjà un compte ? <a href="/login${next ? `?next=${encodeURIComponent(next)}` : ''}">Se connecter</a>`
          : `Pas encore de compte ? <a href="/register${next ? `?next=${encodeURIComponent(next)}` : ''}">Créer un compte</a>`}</p>
      </main>`,
  });
}

function newMeetingForm({ csrf, values, action, submitLabel }) {
  return `
    <form method="post" action="${action}" class="form form--grid">
      ${csrfField(csrf)}
      <label class="span-2">Titre de la réunion
        <input name="title" required minlength="1" maxlength="200" value="${escapeHtml(values.title || '')}" placeholder="Point projet hebdomadaire">
      </label>
      <label>Début (heure de Paris)
        <input type="datetime-local" name="starts_local" required value="${escapeHtml(values.starts_local || '')}">
      </label>
      <label>Fin (heure de Paris)
        <input type="datetime-local" name="ends_local" required value="${escapeHtml(values.ends_local || '')}">
      </label>
      <label>Ouverture anticipée (minutes)
        <input type="number" name="early_join_minutes" min="0" max="60" step="1" value="${escapeHtml(values.early_join_minutes ?? 0)}">
      </label>
      <div class="check-group">
        <label class="check"><input type="checkbox" name="recording" value="1" ${values.recording ? 'checked' : ''}> Activer l'enregistrement</label>
        <label class="check"><input type="checkbox" name="transcription" value="1" ${values.transcription ? 'checked' : ''}> Activer la transcription</label>
        <label class="check"><input type="checkbox" name="chat" value="1" ${values.chat ? 'checked' : ''}> Activer le chat</label>
        <label class="check"><input type="checkbox" name="public_access" value="1" ${values.public_access ? 'checked' : ''}> Réunion ouverte au public</label>
        <label class="check"><input type="checkbox" name="waiting_room" value="1" ${values.waiting_room ? 'checked' : ''}> Activer la salle d'attente</label>
      </div>
      <p class="hint span-2">Durée autorisée : 30 minutes à 8 heures. L'enregistrement couvre l'audio, la vidéo et le partage d'écran. La transcription est produite après la réunion.</p>
      <div class="form-actions span-2">
        <button class="button" type="submit">${submitLabel}</button>
        <a class="button button--quiet" href="/dashboard">Annuler</a>
      </div>
    </form>`;
}

function newMeetingPage({ user, csrf, values = {}, error = '' }) {
  return layout({
    title: 'Nouvelle réunion',
    user,
    csrf,
    error,
    bodyClass: 'page',
    body: `
      <main class="container container--narrow">
        <a class="back-link" href="/dashboard">Retour au tableau de bord</a>
        <p class="eyebrow">Nouvelle réunion</p>
        <h1>Réservez un créneau</h1>
        <p class="lede">La réunion et ses liens seront créés via l'API. Vous serez l'organisateur et recevrez le lien de modération.</p>
        <section class="card">
          ${newMeetingForm({ csrf, values, action: '/meetings', submitLabel: 'Créer la réunion' })}
        </section>
      </main>`,
  });
}

function dashboardPage({ user, csrf, meetings, notice = '', error = '' }) {
  const cards = meetings.map(({ web, api, apiError }) => {
    const info = statusInfo(api || {
      status: 'unknown',
      state: { phase: 'unknown' },
    });
    const title = api?.title || web.title;
    const starts = api?.starts_at || web.starts_at;
    const ends = api?.ends_at || web.ends_at;
    const recording = api ? api.recording : Boolean(web.recording);
    const transcription = api ? api.transcription : Boolean(web.transcription);
    return `
      <article class="meeting-card">
        <div class="meeting-card__head">
          <span class="status status--${info.tone}">${escapeHtml(info.label)}</span>
          <span class="meeting-card__date">${parisShortDateTime(starts)}</span>
        </div>
        <h2><a href="/meetings/${web.id}">${escapeHtml(title)}</a></h2>
        <p class="meeting-card__slot">${parisTime(starts)} - ${parisTime(ends)} <span>heure de Paris</span></p>
        <div class="chips">
          ${recording ? '<span class="chip">Enregistrement</span>' : ''}
          ${transcription ? '<span class="chip">Transcription</span>' : ''}
          ${api?.chat || web.chat ? '<span class="chip">Chat</span>' : ''}
          ${api?.public_access || web.public_access ? '<span class="chip">Public</span>' : ''}
          ${api?.waiting_room || web.waiting_room ? '<span class="chip">Salle d\'attente</span>' : ''}
          ${!recording && !transcription ? '<span class="chip chip--muted">Sans média</span>' : ''}
        </div>
        ${apiError ? `<p class="inline-error">${escapeHtml(apiError)}</p>` : ''}
        <div class="meeting-card__actions">
          <a class="button button--small" href="/meetings/${web.id}">Ouvrir</a>
          ${api && api.status === 'scheduled' && !api.started_at
            ? `<a class="button button--quiet button--small" href="/meetings/${web.id}/edit">Modifier</a>`
            : ''}
        </div>
      </article>`;
  }).join('');

  return layout({
    title: 'Tableau de bord',
    user,
    csrf,
    notice,
    error,
    bodyClass: 'page',
    body: `
      <main class="container">
        <div class="page-head">
          <div>
            <p class="eyebrow">Espace organisateur</p>
            <h1>Mes réunions</h1>
            <p class="lede">Créez un créneau, partagez le lien participant, gardez le lien organisateur pour vous.</p>
          </div>
          <a class="button" href="/meetings/new">Nouvelle réunion</a>
        </div>
        ${meetings.length ? `<div class="meeting-grid">${cards}</div>` : `
          <section class="empty-state card">
            <h2>Aucune réunion pour l'instant</h2>
            <p class="muted">Votre première réunion vous donnera un lien organisateur secret et un lien participant partageable.</p>
            <a class="button" href="/meetings/new">Créer une réunion</a>
          </section>`}
      </main>`,
  });
}

function linkBlock({ label, url, hint, secret = false }) {
  if (!url) {
    return `<div class="link-block link-block--missing"><span>${escapeHtml(label)}</span><p>Lien indisponible. Contactez l'administrateur.</p></div>`;
  }
  return `
    <div class="link-block ${secret ? 'link-block--secret' : ''}">
      <div class="link-block__head">
        <span>${escapeHtml(label)}</span>
        ${secret ? '<span class="link-warning">Secret</span>' : '<span class="link-share">Partageable</span>'}
      </div>
      <div class="copy-row">
        <input readonly value="${escapeHtml(url)}" aria-label="${escapeHtml(label)}">
        <button class="button button--quiet button--small" type="button" data-copy-target="${escapeHtml(url)}">Copier</button>
      </div>
      <div class="link-block__foot">
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Ouvrir le lien</a>
        <span>${escapeHtml(hint)}</span>
      </div>
    </div>`;
}

function attendanceSection({ web, data, error }) {
  if (error) {
    return `<section class="card section-card"><h2>Présence</h2><p class="inline-error">${escapeHtml(error)}</p></section>`;
  }
  const participants = data?.participants || [];
  const entries = data?.entries || [];
  return `
    <section class="card section-card">
      <div class="section-head">
        <div><p class="eyebrow">Présence</p><h2>Qui était là</h2></div>
        <a class="button button--quiet button--small" href="/meetings/${web.id}/attendance.json">Télécharger le JSON</a>
      </div>
      ${participants.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Participant</th><th>Identifiant</th><th>Rôle</th><th>Temps total</th></tr></thead>
            <tbody>${participants.map((p) => `
              <tr>
                <td>${escapeHtml(p.display_name)}</td>
                <td class="mono">${escapeHtml(p.external_id || '-')}</td>
                <td>${p.role === 'organizer' ? 'Organisateur' : 'Participant'}</td>
                <td>${formatDuration(p.total_seconds)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <details class="entries">
          <summary>Voir les ${entries.length} entrées et sorties</summary>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Moment</th><th>Événement</th><th>Participant</th><th>Identifiant</th></tr></thead>
              <tbody>${entries.map((e) => `
                <tr>
                  <td>${parisShortDateTime(e.at)}</td>
                  <td>${e.type === 'joined' ? 'Entrée' : 'Sortie'}</td>
                  <td>${escapeHtml(e.display_name)}</td>
                  <td class="mono">${escapeHtml(e.external_id || '-')}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </details>` : '<p class="muted">Aucune présence enregistrée pour le moment.</p>'}
    </section>`;
}

function chatSection({ web, data, error, enabled = true }) {
  if (error) {
    return `<section class="card section-card"><h2>Chat</h2><p class="inline-error">${escapeHtml(error)}</p></section>`;
  }
  const messages = data?.messages || [];
  return `
    <section class="card section-card">
      <div class="section-head">
        <div><p class="eyebrow">Chat</p><h2>Conversation</h2></div>
        <a class="button button--quiet button--small" href="/meetings/${web.id}/chat.json">Télécharger le JSON</a>
      </div>
      ${!enabled ? '<p class="muted">Le chat a été désactivé pour cette réunion.</p>' : ''}
      ${enabled && messages.length ? `
        <div class="chat-list">
          ${messages.map((m) => `
            <article class="chat-message">
              <header>
                <strong>${escapeHtml(m.author.display_name)}</strong>
                <span class="mono">${escapeHtml(m.author.external_id || '-')}</span>
                <time datetime="${escapeHtml(m.timestamp)}">${parisShortDateTime(m.timestamp)}</time>
              </header>
              <p>${escapeHtml(m.message)}</p>
            </article>`).join('')}
        </div>` : (enabled ? '<p class="muted">Aucun message pour le moment.</p>' : '')}
    </section>`;
}

function artifactsSection({ web, artifacts, error, csrf }) {
  if (error) {
    return `<section class="card section-card"><h2>Artefacts</h2><p class="inline-error">${escapeHtml(error)}</p></section>`;
  }
  return `
    <section class="card section-card">
      <div class="section-head">
        <div><p class="eyebrow">Artefacts</p><h2>Enregistrement et transcription</h2></div>
      </div>
      <p class="muted small">L'enregistrement MP4 composite contient l'audio, la vidéo et le partage d'écran. Il démarre automatiquement dès qu'un participant rejoint une réunion où l'enregistrement est activé. Le fichier apparaît après la réunion. La suppression est définitive et coupe aussi les anciennes URLs temporaires.</p>
      ${artifacts.length ? `
        <ul class="artifact-list">
          ${artifacts.map((a) => `
            <li>
              <div>
                <strong>${escapeHtml(artifactLabel(a.type))}</strong>
                <span>${escapeHtml(a.filename)} · ${formatBytes(a.size)} · ${parisShortDateTime(a.created_at)}</span>
              </div>
              <div class="artifact-actions">
                <a class="button button--quiet button--small" href="/meetings/${web.id}/artifacts/${a.id}/download">Télécharger</a>
                <form method="post" action="/meetings/${web.id}/artifacts/${a.id}/delete" data-confirm="Supprimer définitivement cet artefact ? L’objet S3 et ses métadonnées seront effacés.">
                  ${csrfField(csrf)}
                  <button class="button button--danger button--small" type="submit">Supprimer</button>
                </form>
              </div>
            </li>`).join('')}
        </ul>` : '<p class="muted">Aucun artefact disponible. Ils sont produits à la fin de la réunion, puis la transcription quelques minutes ou heures plus tard.</p>'}
    </section>`;
}

function processingSection({ web, processing, error, csrf }) {
  if (error) {
    return `<section class="card section-card"><h2>Traitements</h2><p class="inline-error">${escapeHtml(error)}</p></section>`;
  }
  if (!processing) return '';
  const recording = processing.recording || {};
  const transcription = processing.transcription || {};
  const failedUploads = (recording.uploads || []).filter((upload) => upload.status === 'failed');
  const recordingError = recording.error || failedUploads[0]?.error || '';
  const transcriptionError = transcription.error || '';
  const canRetryRecording = recording.enabled
    && (failedUploads.length > 0
      || (recording.state === 'failed' && ['scheduled', 'in_progress'].includes(processing.meeting_status)));
  const canRetryTranscription = transcription.enabled
    && ['failed', 'not_queued'].includes(transcription.status);
  return `
    <section class="card section-card">
      <div class="section-head">
        <div><p class="eyebrow">Traitements</p><h2>Enregistrement et transcription</h2></div>
      </div>
      <div class="processing-grid">
        <article class="processing-item">
          <header><strong>Enregistrement</strong><span class="status ${recording.state === 'failed' ? 'status--danger' : 'status--open'}">${escapeHtml(recordingStateLabel(recording.state || 'idle'))}</span></header>
          ${recordingError ? `<p class="inline-error">${escapeHtml(recordingError)}</p>` : '<p class="muted small">Aucune erreur signalée.</p>'}
          ${failedUploads.length ? `<p class="muted small">${failedUploads.length} fichier(s) en échec d'envoi vers le stockage privé.</p>` : ''}
          ${canRetryRecording ? `
            <form method="post" action="/meetings/${web.id}/processing/retry">
              ${csrfField(csrf)}
              <input type="hidden" name="kind" value="recording">
              <button class="button button--quiet button--small" type="submit">Relancer l'enregistrement</button>
            </form>` : ''}
        </article>
        <article class="processing-item">
          <header><strong>Transcription</strong><span class="status ${transcription.status === 'failed' ? 'status--danger' : 'status--open'}">${escapeHtml({
            disabled: 'désactivée',
            not_queued: 'non planifiée',
            pending: 'en attente',
            processing: 'en cours',
            completed: 'terminée',
            failed: 'échec',
          }[transcription.status] || transcription.status || 'inconnue')}</span></header>
          ${transcriptionError ? `<p class="inline-error">${escapeHtml(transcriptionError)}</p>` : '<p class="muted small">Aucune erreur signalée.</p>'}
          ${canRetryTranscription ? `
            <form method="post" action="/meetings/${web.id}/processing/retry">
              ${csrfField(csrf)}
              <input type="hidden" name="kind" value="transcription">
              <button class="button button--quiet button--small" type="submit">Relancer la transcription</button>
            </form>` : ''}
        </article>
      </div>
    </section>`;
}

function detailPage({ user, csrf, web, api, links, attendance, chat, artifacts, processing, organizers = [], errors = {}, notice = '', error = '' }) {
  const info = statusInfo(api);
  const live = api || {
    title: web.title,
    starts_at: web.starts_at,
    ends_at: web.ends_at,
    early_join_minutes: web.early_join_minutes,
    status: 'unknown',
    recording: Boolean(web.recording),
    transcription: Boolean(web.transcription),
    chat: Boolean(web.chat),
    public_access: Boolean(web.public_access),
    waiting_room: Boolean(web.waiting_room),
    recording_state: web.recording_state || 'idle',
    state: {},
  };
  const editable = api && api.status === 'scheduled' && !api.started_at;
  const canEnd = api && ['scheduled', 'in_progress'].includes(api.status);
  return layout({
    title: live.title,
    user,
    csrf,
    notice,
    error,
    bodyClass: 'page',
    body: `
      <main class="container">
        <a class="back-link" href="/dashboard">Retour au tableau de bord</a>
        <div class="page-head page-head--detail">
          <div>
            <div class="title-row"><span class="status status--${info.tone}">${escapeHtml(info.label)}</span></div>
            <h1>${escapeHtml(live.title)}</h1>
            <p class="lede">${parisDateLong(live.starts_at)} · ${parisTime(live.starts_at)} - ${parisTime(live.ends_at)} (Paris)</p>
            <div class="chips">
              ${live.recording ? '<span class="chip">Enregistrement activé</span>' : '<span class="chip chip--muted">Enregistrement désactivé</span>'}
              ${live.transcription ? '<span class="chip">Transcription activée</span>' : '<span class="chip chip--muted">Transcription désactivée</span>'}
              ${live.chat ? '<span class="chip">Chat activé</span>' : '<span class="chip chip--muted">Chat désactivé</span>'}
              ${live.public_access ? '<span class="chip">Ouverte au public</span>' : '<span class="chip chip--muted">Sur invitation</span>'}
              ${live.waiting_room ? '<span class="chip">Salle d\'attente</span>' : '<span class="chip chip--muted">Sans salle d\'attente</span>'}
              ${live.recording ? `<span class="chip chip--muted">Enregistrement : ${escapeHtml(recordingStateLabel(live.recording_state || 'idle'))}</span>` : ''}
              <span class="chip chip--muted">Ouverture ${live.early_join_minutes || 0} min avant</span>
            </div>
          </div>
          <div class="detail-actions">
            ${editable ? `<a class="button button--quiet" href="/meetings/${web.id}/edit">Modifier</a>` : ''}
            ${canEnd ? `<form method="post" action="/meetings/${web.id}/end" data-confirm="Terminer la réunion pour tous les participants maintenant ?">${csrfField(csrf)}<button class="button button--danger" type="submit">Terminer maintenant</button></form>` : ''}
            ${editable ? `<form method="post" action="/meetings/${web.id}/cancel" data-confirm="Annuler définitivement cette réunion ?">${csrfField(csrf)}<button class="button button--quiet" type="submit">Annuler la réunion</button></form>` : ''}
          </div>
        </div>

        <div class="links-grid">
          ${linkBlock({ label: 'Lien organisateur', url: links.organizer, hint: 'Réservé aux comptes organisateurs. Ne le partagez jamais.', secret: true })}
          ${linkBlock({ label: 'Lien participant', url: links.participant, hint: 'À partager. Chaque participant doit être connecté au site.', secret: false })}
        </div>
        <p class="muted small link-note">Les liens s'ouvrent dans ce projet web. Sans session dans le navigateur, la connexion est demandée puis l'accès reprend automatiquement. Une session existante ouvre directement la réunion, même dans un nouvel onglet.</p>

        <section class="card section-card">
          <div class="section-head">
            <div><p class="eyebrow">Organisateurs</p><h2>Équipe de modération</h2></div>
          </div>
          <ul class="organizer-list">
            ${organizers.map((organizer) => `
              <li>
                <div>
                  <strong>${escapeHtml(organizer.display_name || organizer.email)}</strong>
                  <span>${escapeHtml(organizer.email)}</span>
                </div>
                <span class="status ${organizer.status === 'active' ? 'status--open' : 'status--wait'}">${organizer.status === 'active' ? 'Actif' : 'En attente de compte'}</span>
              </li>`).join('')}
          </ul>
          <form method="post" action="/meetings/${web.id}/organizers" class="invite-form">
            ${csrfField(csrf)}
            <label>Ajouter un organisateur par e-mail
              <input type="email" name="email" required placeholder="organisateur@exemple.fr">
            </label>
            <button class="button button--small" type="submit">Ajouter</button>
          </form>
          <p class="muted small">Seules les personnes ajoutées ici peuvent utiliser un lien organisateur. Une invitation sans compte reste en attente jusqu'à l'inscription avec la même adresse.</p>
        </section>

        ${api && ['scheduled', 'in_progress'].includes(api.status) ? `
        <section class="card section-card">
          <div class="section-head"><div><p class="eyebrow">Accès</p><h2>Réglages d'accès</h2></div></div>
          <form method="post" action="/meetings/${web.id}/access" class="access-form">
            ${csrfField(csrf)}
            <label class="check"><input type="checkbox" name="public_access" value="1" ${live.public_access ? 'checked' : ''}> Réunion ouverte au public (nom demandé sur le lien générique)</label>
            <label class="check"><input type="checkbox" name="waiting_room" value="1" ${live.waiting_room ? 'checked' : ''}> Activer la salle d'attente</label>
            <button class="button button--small" type="submit">Enregistrer les réglages</button>
          </form>
        </section>` : ''}

        ${attendanceSection({ web, data: attendance, error: errors.attendance })}
        ${chatSection({ web, data: chat, error: errors.chat, enabled: Boolean(live.chat) })}
        ${processingSection({ web, processing, error: errors.processing, csrf })}
        ${artifactsSection({ web, artifacts, error: errors.artifacts, csrf })}
      </main>`,
  });
}

function editMeetingPage({ user, csrf, web, api, values, error = '' }) {
  return layout({
    title: 'Modifier la réunion',
    user,
    csrf,
    error,
    bodyClass: 'page',
    body: `
      <main class="container container--narrow">
        <a class="back-link" href="/meetings/${web.id}">Retour à la réunion</a>
        <p class="eyebrow">Modification</p>
        <h1>Changer le créneau</h1>
        <p class="lede">La modification reste possible tant que personne n'a rejoint la réunion. Les liens déjà émis restent valides.</p>
        <section class="card">
          <form method="post" action="/meetings/${web.id}/edit" class="form form--grid">
            ${csrfField(csrf)}
            <label class="span-2">Titre
              <input name="title" required minlength="1" maxlength="200" value="${escapeHtml(values.title)}">
            </label>
            <label>Début (Paris)
              <input type="datetime-local" name="starts_local" required value="${escapeHtml(values.starts_local)}">
            </label>
            <label>Fin (Paris)
              <input type="datetime-local" name="ends_local" required value="${escapeHtml(values.ends_local)}">
            </label>
            <label>Ouverture anticipée (minutes)
              <input type="number" name="early_join_minutes" min="0" max="60" step="1" value="${escapeHtml(values.early_join_minutes)}">
            </label>
            <div class="check-group">
              <label class="check"><input type="checkbox" name="recording" value="1" ${values.recording ? 'checked' : ''}> Enregistrement</label>
              <label class="check"><input type="checkbox" name="transcription" value="1" ${values.transcription ? 'checked' : ''}> Transcription</label>
              <label class="check"><input type="checkbox" name="chat" value="1" ${values.chat ? 'checked' : ''}> Chat</label>
              <label class="check"><input type="checkbox" name="public_access" value="1" ${values.public_access ? 'checked' : ''}> Public</label>
              <label class="check"><input type="checkbox" name="waiting_room" value="1" ${values.waiting_room ? 'checked' : ''}> Salle d'attente</label>
            </div>
            <div class="form-actions span-2">
              <button class="button" type="submit">Enregistrer</button>
              <a class="button button--quiet" href="/meetings/${web.id}">Retour</a>
            </div>
          </form>
        </section>
      </main>`,
  });
}

function meetingWaitingPage({ user, csrf, meeting, state }) {
  return layout({
    title: `Ouverture à ${parisTime(state.opens_at)}`,
    user,
    csrf,
    bodyClass: 'page page--center',
    bodyData: `data-open-at="${escapeHtml(state.opens_at)}"`,
    body: `
      <main class="auth-card card waiting-card">
        <p class="eyebrow">Réunion programmée</p>
        <h1>${escapeHtml(meeting.title)}</h1>
        <div class="time-display">${parisTime(state.opens_at)}<span>heure de Paris</span></div>
        <p class="lede">Le lien s'ouvrira le ${escapeHtml(parisDateTime(state.opens_at))}.</p>
        <div class="countdown" id="countdown" aria-live="polite">Ouverture imminente…</div>
        <div class="mini-grid">
          <div><span>Créneau</span><strong>${parisTime(state.starts_at)} - ${parisTime(state.ends_at)}</strong></div>
          <div><span>Durée</span><strong>${formatDuration((new Date(state.ends_at) - new Date(state.starts_at)) / 1000)}</strong></div>
        </div>
        <p class="muted small">L'ouverture se fait automatiquement à l'heure prévue. ${user ? 'Vous êtes connecté, aucune nouvelle authentification ne sera demandée.' : "Aucune connexion n'est nécessaire pour cette réunion publique."}</p>
      </main>
      <script src="/static/waiting.js"></script>`,
  });
}

function meetingPublicNamePage({ user, csrf, meeting, token, suggestedName = '', error = '' }) {
  return layout({
    title: 'Rejoindre la réunion',
    user,
    csrf,
    bodyClass: 'page page--center',
    body: `
      <main class="auth-card card">
        <p class="eyebrow">Réunion ouverte au public</p>
        <h1>${escapeHtml(meeting.title)}</h1>
        <p class="lede">Cette réunion est ouverte. Indiquez le nom qui apparaîtra dans la liste de présence et la transcription.</p>
        ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ''}
        <form method="post" action="/m/${escapeHtml(token)}/name" class="form">
          ${csrfField(csrf)}
          <label>Nom du participant
            <input name="display_name" required minlength="2" maxlength="80" autocomplete="name" value="${escapeHtml(suggestedName)}" placeholder="Prénom Nom">
          </label>
          <button class="button" type="submit">Continuer vers la réunion</button>
        </form>
        <p class="muted small">${user
          ? 'Votre compte web reste associé à cette présence. Le nom choisi est utilisé pour cette réunion.'
          : 'Vous rejoignez cette réunion publique sans compte. Le nom choisi reste associé à cette réunion dans ce navigateur.'}</p>
      </main>`,
  });
}

function meetingConsentPage({ user, csrf, meeting, token }) {
  return layout({
    title: 'Consentement à l’enregistrement',
    user,
    csrf,
    bodyClass: 'page page--center',
    body: `
      <main class="auth-card card">
        <p class="eyebrow">Avant de rejoindre</p>
        <h1>${escapeHtml(meeting.title)}</h1>
        <p class="lede">Cette réunion est enregistrée${meeting.transcription ? ' et transcrite' : ''}. L'enregistrement couvre l'audio, la vidéo et le partage d'écran.</p>
        <div class="consent-notice">
          <strong>Enregistrement actif</strong>
          <p>Un indicateur reste visible dans la salle pendant toute la captation. En continuant, vous consentez à cet enregistrement pour cette réunion.</p>
        </div>
        <form method="post" action="/m/${escapeHtml(token)}/consent" class="form">
          ${csrfField(csrf)}
          <button class="button" type="submit">Je consens et je rejoins</button>
        </form>
        <p class="switch-link"><a href="/dashboard">Refuser et revenir à mes réunions</a></p>
      </main>`,
  });
}

function meetingLobbyPage({ user, csrf, meeting, access, state, sessionToken }) {
  const bodyData = [
    `data-session-token="${escapeHtml(sessionToken)}"`,
    'data-api-base="/room-api"',
    `data-meeting-title="${escapeHtml(meeting.title)}"`,
  ].join(' ');
  return layout({
    title: "En attente d'admission",
    user,
    csrf,
    bodyClass: 'page page--center',
    bodyData,
    body: `
      <main class="auth-card card waiting-card">
        <p class="eyebrow">Salle d'attente</p>
        <h1>En attente d'admission</h1>
        <p class="lede">${escapeHtml(meeting.title)}</p>
        <div class="lobby-person">
          <span>Participant</span>
          <strong>${escapeHtml(access.display_name)}</strong>
        </div>
        <div class="lobby-pulse" aria-hidden="true"><span></span><span></span><span></span></div>
        <p class="muted" id="lobby-status">Un organisateur doit vous admettre pour entrer dans la salle.</p>
        <p class="muted small">Cette page est prévenue en temps réel de la décision. Ne fermez pas cet onglet.</p>
      </main>
      <script src="/static/lobby.js"></script>`,
  });
}

function meetingTerminalPage({ user, csrf, eyebrow, title, meeting, message, tone = '' }) {
  return layout({
    title,
    user,
    csrf,
    bodyClass: 'page page--center',
    body: `
      <main class="auth-card card">
        <a class="brand" href="/dashboard">${brandMark()}</a>
        <p class="eyebrow ${tone}">${escapeHtml(eyebrow)}</p>
        <h1>${escapeHtml(title)}</h1>
        ${meeting ? `<p class="lede">${escapeHtml(meeting.title)}</p>` : ''}
        <p class="muted">${escapeHtml(message)}</p>
        ${meeting ? `<div class="mini-grid">
          <div><span>Créneau</span><strong>${parisTime(meeting.starts_at)} - ${parisTime(meeting.ends_at)}</strong></div>
          <div><span>Date</span><strong>${escapeHtml(parisDateTime(meeting.starts_at))}</strong></div>
        </div>` : ''}
        <div class="form-actions"><a class="button" href="${user ? '/dashboard' : '/'}">${user ? 'Retour à mes réunions' : 'Fermer'}</a></div>
      </main>`,
  });
}

function meetingRoomPage({ user, meeting, access, state, jitsiJwt, sessionToken, sessionId, warningMinutes, csrf: _csrf }) {
  const roleLabel = access.role === 'organizer' ? 'Organisateur' : 'Participant';
  const bodyData = [
    `data-room="${escapeHtml(meeting.room)}"`,
    `data-jwt="${escapeHtml(jitsiJwt)}"`,
    `data-jitsi-domain="${escapeHtml(config.jitsiDomain)}"`,
    `data-session-token="${escapeHtml(sessionToken)}"`,
    `data-session-id="${escapeHtml(sessionId || '')}"`,
    `data-api-base="/room-api"`,
    `data-ends-at="${escapeHtml(state.ends_at)}"`,
    `data-role="${escapeHtml(access.role)}"`,
    `data-recording="${meeting.recording ? '1' : '0'}"`,
    `data-recording-state="${escapeHtml(meeting.recording_state || 'idle')}"`,
    `data-transcription="${meeting.transcription ? '1' : '0'}"`,
    `data-chat="${meeting.chat ? '1' : '0'}"`,
    `data-warning-minutes="${escapeHtml(warningMinutes)}"`,
    `data-display-name="${escapeHtml(access.display_name)}"`,
    `data-external-id="${escapeHtml(access.external_id || '')}"`,
    `data-meeting-id="${escapeHtml(meeting.id)}"`,
    `data-waiting-room="${meeting.waiting_room ? '1' : '0'}"`,
  ].join(' ');
  return layout({
    title: meeting.title,
    noHeader: true,
    bodyClass: 'room-page',
    bodyData,
    head: `<link rel="stylesheet" href="/static/room.css">
      <script src="${escapeHtml(config.jitsiPublicUrl)}/external_api.js"></script>`,
    body: `
      <header class="room-bar">
        <div class="room-bar__identity">
          <span class="brand">${brandMark()}</span>
          <div class="room-bar__title">
            <strong>${escapeHtml(meeting.title)}</strong>
            <span>${escapeHtml(access.display_name)} · ${roleLabel}</span>
          </div>
        </div>
        <div class="room-bar__meta">
          ${meeting.recording ? '<span class="recording-chip" id="recording-chip"><span></span>Enregistrement</span>' : ''}
          ${access.role === 'organizer' ? '<button class="waiting-button" id="moderation-toggle" type="button">Modération <span id="waiting-count">0</span></button>' : ''}
          <span class="slot-chip">Fin à ${parisTime(state.ends_at)}</span>
        </div>
      </header>
      <div id="end-warning" class="end-warning" hidden role="status"></div>
      <div id="capture-notice" class="capture-notice" hidden></div>
      <main id="jitsi-container" class="jitsi-container" aria-label="Visioconférence"></main>
      ${access.role === 'organizer' ? `
      <aside id="moderation-panel" class="waiting-panel moderation-panel" hidden>
        <header class="waiting-panel__head">
          <div><p class="eyebrow">Modération</p><h2>Pilotage de la salle</h2></div>
          <button class="button button--quiet button--small" type="button" id="moderation-close">Fermer</button>
        </header>
        <div class="moderation-toolbar">
          <button class="button button--quiet button--small" type="button" id="mute-all">Couper tous les micros</button>
          <button class="button button--quiet button--small" type="button" id="chat-toggle">Désactiver le chat</button>
          <button class="button button--danger button--small" type="button" id="end-meeting">Terminer la réunion</button>
        </div>
        <section class="moderation-section">
          <h3>Participants connectés</h3>
          <div id="participants-list" class="moderation-list"><p class="muted">Chargement…</p></div>
        </section>
        <section class="moderation-section">
          <div class="moderation-section__head">
            <h3>Salle d'attente <span id="waiting-count-inline">0</span></h3>
            <button class="button button--small" type="button" id="waiting-admit-all">Tout admettre</button>
          </div>
          <div id="waiting-list" class="moderation-list"><p class="muted">Chargement…</p></div>
        </section>
        <p id="moderation-message" class="muted small" role="status"></p>
      </aside>` : ''}
      <div id="leave-overlay" class="leave-overlay" hidden>
        <div class="card card--narrow">
          <p class="eyebrow">Session locale</p>
          <h1>Vous avez quitté la réunion</h1>
          <p class="lede" id="leave-message">Le créneau est toujours ouvert. Vous pouvez rejoindre à nouveau tant qu'il reste du temps.</p>
          <button class="button" id="rejoin-button" type="button">Rejoindre à nouveau</button>
        </div>
      </div>
      <script src="/static/room.js"></script>`,
  });
}

function errorPage({ user = null, csrf = '', status = 404, title = 'Page introuvable', message = '' }) {
  return layout({
    title,
    user,
    csrf,
    bodyClass: 'page page--center',
    noHeader: !user,
    body: `
      <main class="auth-card card">
        <a class="brand" href="${user ? '/dashboard' : '/'}">${brandMark()}</a>
        <p class="eyebrow">Erreur ${status}</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="lede">${escapeHtml(message || 'La page demandée est introuvable.')}</p>
        <a class="button" href="${user ? '/dashboard' : '/login'}">Retour</a>
      </main>`,
  });
}

module.exports = {
  layout,
  csrfField,
  authPage,
  dashboardPage,
  newMeetingPage,
  meetingWaitingPage,
  meetingPublicNamePage,
  meetingConsentPage,
  meetingLobbyPage,
  meetingTerminalPage,
  meetingRoomPage,
  detailPage,
  editMeetingPage,
  errorPage,
};
