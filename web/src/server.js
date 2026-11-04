'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { z } = require('zod');
const config = require('./config');
const { db } = require('./db');
const {
  hashPassword,
  verifyPassword,
  createSession,
  findUserBySessionToken,
  deleteSessionByToken,
  encryptJson,
  decryptJson,
  randomToken,
  safeEqual,
  sha256,
} = require('./security');
const { api, ApiError } = require('./api');
const events = require('./events');
const log = require('./log');
const views = require('./views');
const {
  parisLocalToIso,
  toParisInput,
} = require('./util');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(cookieParser());

const SESSION_COOKIE = 'pmw_session';
const CSRF_COOKIE = 'pmw_csrf';

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'self' ${config.jitsiOrigin}`,
      "style-src 'self'",
      "img-src 'self' data: https:",
      `frame-src ${config.jitsiOrigin}`,
      `connect-src 'self' ${config.jitsiOrigin}`,
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': `camera=(self "${config.jitsiOrigin}"), microphone=(self "${config.jitsiOrigin}"), display-capture=(self "${config.jitsiOrigin}")`,
    'Cache-Control': 'no-store, max-age=0',
  });
  next();
});

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: maxAgeMs,
  };
}

app.use((req, res, next) => {
  const started = Date.now();
  req.requestId = String(req.get('x-request-id') || '').slice(0, 100) || crypto.randomUUID();
  res.set('x-request-id', req.requestId);
  res.on('finish', () => {
    const safePath = req.originalUrl.split('?')[0].replace(/^\/m\/[^/]+/, '/m/[lien]');
    log.info('web.request', {
      request_id: req.requestId,
      method: req.method,
      path: safePath,
      status: res.statusCode,
      duration_ms: Date.now() - started,
    });
  });
  next();
});

app.use((req, res, next) => {
  let csrf = req.cookies?.[CSRF_COOKIE];
  if (!csrf) {
    csrf = randomToken(32);
    res.cookie(CSRF_COOKIE, csrf, cookieOptions(30 * 86400_000));
  }
  req.csrfToken = csrf;
  const sessionToken = req.cookies?.[SESSION_COOKIE];
  res.locals.user = findUserBySessionToken(sessionToken) || null;
  res.locals.csrfToken = csrf;
  res.locals.sessionToken = sessionToken || null;
  next();
});

function verifyCsrf(req, res, next) {
  if (req.method !== 'POST') return next();
  if (req.path.startsWith('/room-api/')) return next();
  const provided = String(req.body?._csrf || '');
  const expected = String(req.cookies?.[CSRF_COOKIE] || '');
  if (!provided || !expected || !safeEqual(provided, expected)) {
    return res.status(403).send(views.errorPage({
      user: res.locals.user,
      csrf: res.locals.csrfToken,
      status: 403,
      title: 'Requête refusée',
      message: 'Le jeton de sécurité du formulaire est invalide. Rechargez la page et réessayez.',
    }));
  }
  return next();
}
app.use(verifyCsrf);

function sseHeaders(res) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

function sseSend(res, type, payload) {
  if (res.writableEnded) return;
  try {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // La déconnexion du navigateur est nettoyée par les écouteurs close.
  }
}

function participantEventAllowed(event, status) {
  if (event.meeting_id !== status.meeting_id) return false;
  if (event.data?.session_id && event.data.session_id === status.session_id) {
    return ['admission.updated', 'media.policy', 'participant.excluded', 'session.left'].includes(event.type);
  }
  if (event.type === 'media.broadcast') return true;
  return ['meeting.updated', 'meeting.ended', 'meeting.cancelled', 'recording.updated', 'recording.ready']
    .includes(event.type);
}

// Flux de la salle et de la salle d'attente : le navigateur n'interroge jamais
// le statut en boucle, il reçoit les changements dès que l'API les publie.
app.get('/room-api/session/stream', asyncHandler(async (req, res) => {
  const authorization = req.get('authorization') || '';
  const sessionToken = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  if (!sessionToken) return jsonError(res, 401, 'Session de réunion requise');
  let status = null;
  let closed = false;
  const pending = [];

  function forward(event) {
    if (closed || !status) return;
    if (status.role !== 'organizer' && !participantEventAllowed(event, status)) return;
    if (status.role === 'organizer' && event.meeting_id !== status.meeting_id) return;
    sseSend(res, 'meeting-event', {
      type: event.type,
      data: event.data || {},
      seq: event.seq,
      created_at: event.created_at,
    });
  }

  // S'abonner avant l'appel de statut évite de perdre un événement publié
  // pendant la vérification d'authentification. Les événements sont tamponnés
  // jusqu'à ce que le rôle et la session permettent de les filtrer.
  const unsubscribe = events.onEvent((event) => {
    if (!status) {
      pending.push(event);
      return;
    }
    forward(event);
  });
  try {
    status = await api.sessionStatus(sessionToken);
  } catch (error) {
    closed = true;
    unsubscribe();
    return jsonError(res, error.status || 502, error.message);
  }
  if (closed) {
    unsubscribe();
    return undefined;
  }

  sseHeaders(res);
  res.write('retry: 2000\n\n');
  sseSend(res, 'ready', {
    status: {
      meeting_id: status.meeting_id,
      session_id: status.session_id,
      role: status.role,
      admission_status: status.admission_status,
      media: status.media,
      recording_state: status.recording_state,
      recording_error: status.recording_error,
      chat: status.chat,
      waiting_room: status.waiting_room,
      phase: status.phase,
      ends_at: status.ends_at,
      server_now: status.server_now,
    },
  });
  for (const event of pending) forward(event);
  pending.length = 0;

  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
  heartbeat.unref();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    res.end();
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('error', cleanup);
}));

// Le créneau n'est pas encore ouvert : la page attend un changement de statut
// sans boucle HTTP. Seuls les événements de calendrier sont exposés.
app.get('/m/:token/events', requireUser, asyncHandler(async (req, res) => {
  let resolved;
  try {
    resolved = await api.resolveAccess(req.params.token);
  } catch {
    return res.status(404).json({ error: 'Lien invalide' });
  }
  const meetingId = resolved.meeting.id;
  sseHeaders(res);
  res.write('retry: 3000\n\n');
  sseSend(res, 'ready', { phase: resolved.state.phase, ends_at: resolved.state.ends_at });
  const allowed = new Set(['meeting.updated', 'meeting.cancelled', 'meeting.ended']);
  const unsubscribe = events.onEvent((event) => {
    if (event.meeting_id !== meetingId || !allowed.has(event.type)) return;
    sseSend(res, 'meeting-event', { type: event.type, data: event.data || {}, created_at: event.created_at });
  });
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
  heartbeat.unref();
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    res.end();
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('error', cleanup);
}));

app.use('/room-api', express.raw({ type: '*/*', limit: '12mb' }), asyncHandler(async (req, res) => {
  const allowed = new Set([
    '/session/status',
    '/session/events',
    '/session/capture',
    '/session/waiting',
    '/session/participants',
    '/session/moderation',
  ]);
  if (!allowed.has(req.path)) {
    return res.status(404).json({ error: 'Endpoint de réunion inconnu' });
  }
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
  const headers = {};
  const authorization = req.get('authorization');
  if (authorization) headers.authorization = authorization;
  for (const header of ['x-capture-index', 'x-capture-mime', 'x-capture-started-at']) {
    const value = req.get(header);
    if (value) headers[header] = value;
  }
  let body;
  if (req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length > 0) {
    body = req.body;
    headers['content-type'] = req.get('content-type') || 'application/octet-stream';
  }
  let upstream;
  try {
    upstream = await fetch(`${config.apiInternalUrl}/api${req.path}`, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return res.status(502).json({ error: 'Service de réunion indisponible' });
  }
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.set('Content-Type', contentType);
  return res.send(buffer);
}));


app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'prototype-meet-web', time: new Date().toISOString() });
});

app.get('/theme.css', (req, res) => {
  res.type('text/css').send(`:root{--brand:${config.branding.color};}`);
});

app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

function requireUser(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  return next();
}

function flashUrl(pathname, type, message) {
  const params = new URLSearchParams({ [type]: String(message).slice(0, 400) });
  return `${pathname}?${params.toString()}`;
}

function getFlash(req) {
  return {
    notice: typeof req.query.notice === 'string' ? req.query.notice.slice(0, 400) : '',
    error: typeof req.query.error === 'string' ? req.query.error.slice(0, 400) : '',
  };
}

function setSessionCookie(res, token, expires) {
  res.cookie(SESSION_COOKIE, token, cookieOptions(new Date(expires).getTime() - Date.now()));
}

function rotateCsrf(res) {
  const csrf = randomToken(32);
  res.cookie(CSRF_COOKIE, csrf, cookieOptions(30 * 86400_000));
  res.locals.csrfToken = csrf;
  return csrf;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function safeMeetingNext(value) {
  const next = String(value || '');
  if (next.length > 500) return '';
  return /^\/m\/[A-Za-z0-9_-]+$/.test(next) ? next : '';
}

function meetingCookieName(token) {
  return `pmmeet_${sha256(token).slice(0, 20)}`;
}

function publicNameCookieName(token) {
  return `pmname_${sha256(token).slice(0, 20)}`;
}

function readPublicName(req, token, userId) {
  const raw = req.cookies?.[publicNameCookieName(token)];
  const data = decryptJson(raw);
  if (!data || data.tokenHash !== sha256(token) || data.user_id !== userId) return '';
  const name = String(data.name || '').trim();
  return name.length >= 2 && name.length <= 80 ? name : '';
}

function setMeetingSessionCookie(res, token, raw, meeting) {
  const ttl = Math.max(60_000, new Date(meeting.ends_at).getTime() - Date.now() + 3_600_000);
  res.cookie(meetingCookieName(token), raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: ttl,
  });
}

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function managedMeeting(id, userId) {
  return db.prepare(`
    SELECT wm.*, mo.organizer_url_enc AS my_organizer_url_enc,
           mo.display_name AS organizer_display_name
    FROM web_meetings wm
    JOIN meeting_organizers mo ON mo.web_meeting_id = wm.id
    WHERE wm.id=? AND mo.user_id=? AND mo.status='active'
  `).get(id, userId);
}

function managedMeetings(userId) {
  return db.prepare(`
    SELECT DISTINCT wm.* FROM web_meetings wm
    JOIN meeting_organizers mo ON mo.web_meeting_id = wm.id
    WHERE mo.user_id=? AND mo.status='active'
    ORDER BY wm.created_at DESC
  `).all(userId);
}

function meetingByApiId(apiMeetingId) {
  return db.prepare('SELECT * FROM web_meetings WHERE api_meeting_id=?').get(apiMeetingId);
}

function organizerMembership(webMeetingId, userId) {
  return db.prepare(`
    SELECT * FROM meeting_organizers
    WHERE web_meeting_id=? AND user_id=? AND status='active'
  `).get(webMeetingId, userId);
}

async function createOrganizerLink(webMeeting, user) {
  const link = await api.addLink(webMeeting.api_meeting_id, {
    role: 'organizer',
    kind: 'named',
    display_name: user.name,
    external_id: user.id,
  });
  return link.token;
}

async function activatePendingInvites(user) {
  const pending = db.prepare(`
    SELECT mo.*, wm.api_meeting_id
    FROM meeting_organizers mo JOIN web_meetings wm ON wm.id = mo.web_meeting_id
    WHERE mo.email=? COLLATE NOCASE AND mo.user_id IS NULL AND mo.status='pending'
  `).all(user.email);
  for (const invite of pending) {
    try {
      const meeting = await api.getMeeting(invite.api_meeting_id);
      if (meeting.status !== 'scheduled' || meeting.started_at) continue;
      const url = await createOrganizerLink(
        { api_meeting_id: invite.api_meeting_id },
        user,
      );
      db.prepare(`
        UPDATE meeting_organizers
        SET user_id=?, display_name=?, organizer_url_enc=?, status='active'
        WHERE id=?
      `).run(user.id, user.name, encryptJson({ organizer: url }), invite.id);
    } catch (error) {
      log.error('web.invitation_activation_failed', { invitation_id: invite.id, error: error.message });
    }
  }
}

function extractLinkToken(encrypted, role) {
  const data = decryptJson(encrypted);
  if (!data) return '';
  if (typeof data === 'string') return data;
  const raw = data.token || data[role] || data.organizer || data.participant || '';
  if (!raw) return '';
  if (/^[A-Za-z0-9_-]{20,256}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const match = /^\/(?:m|o|j)\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function linkUrl(token) {
  return token ? `${config.baseUrl}/m/${encodeURIComponent(token)}` : '';
}

function linksFor(webMeeting) {
  const organizerToken = extractLinkToken(
    webMeeting.my_organizer_url_enc || webMeeting.organizer_url_enc,
    'organizer',
  );
  const participantToken = extractLinkToken(webMeeting.participant_url_enc, 'participant');
  return {
    organizer: linkUrl(organizerToken),
    participant: linkUrl(participantToken),
  };
}

function hasRecordingConsent(apiMeetingId, externalId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM meeting_consents WHERE api_meeting_id=? AND external_id=?
  `).get(apiMeetingId, externalId));
}

function recordRecordingConsent(apiMeetingId, externalId) {
  db.prepare(`
    INSERT INTO meeting_consents (api_meeting_id, external_id, accepted_at)
    VALUES (?, ?, ?)
    ON CONFLICT(api_meeting_id, external_id) DO NOTHING
  `).run(apiMeetingId, externalId, new Date().toISOString());
}

const emailSchema = z.string().trim().toLowerCase().email().max(200);
const authSchema = z.object({
  email: emailSchema,
  password: z.string().min(8).max(200),
});
const registerSchema = authSchema.extend({
  name: z.string().trim().min(2).max(80),
  password_confirm: z.string().min(8).max(200),
});

function formValuesFromBody(body) {
  return {
    title: String(body.title || '').trim(),
    starts_local: String(body.starts_local || ''),
    ends_local: String(body.ends_local || ''),
    early_join_minutes: String(body.early_join_minutes ?? '0'),
    recording: body.recording === '1',
    transcription: body.transcription === '1',
    chat: body.chat === '1',
    public_access: body.public_access === '1',
    waiting_room: body.waiting_room === '1',
  };
}

function defaultFormValues() {
  const start = new Date(Date.now() + 10 * 60_000);
  start.setSeconds(0, 0);
  start.setMinutes(Math.ceil(start.getMinutes() / 5) * 5);
  const end = new Date(start.getTime() + 60 * 60_000);
  return {
    title: '',
    starts_local: toParisInput(start.toISOString()),
    ends_local: toParisInput(end.toISOString()),
    early_join_minutes: '0',
    recording: false,
    transcription: false,
    chat: true,
    public_access: false,
    waiting_room: false,
  };
}

function validateMeetingForm(body) {
  const values = formValuesFromBody(body);
  const parsed = z.object({
    title: z.string().trim().min(1, 'Le titre est requis').max(200),
    starts_local: z.string().min(1, 'Le début est requis'),
    ends_local: z.string().min(1, 'La fin est requise'),
    early_join_minutes: z.coerce.number().int().min(0).max(60),
  }).safeParse(values);
  if (!parsed.success) {
    return { values, error: parsed.error.issues.map((i) => i.message).join(' ; ') };
  }
  try {
    const startsAt = parisLocalToIso(values.starts_local);
    const endsAt = parisLocalToIso(values.ends_local);
    return {
      values,
      payload: {
        title: values.title,
        starts_at: startsAt,
        ends_at: endsAt,
        early_join_minutes: Number(values.early_join_minutes || 0),
        recording: values.recording,
        transcription: values.transcription,
        chat: values.chat,
        public_access: values.public_access,
        waiting_room: values.waiting_room,
      },
    };
  } catch (error) {
    return { values, error: error.message };
  }
}

function renderError(res, { status = 500, title = 'Erreur', message = '' } = {}) {
  res.status(status).send(views.errorPage({
    user: res.locals.user,
    csrf: res.locals.csrfToken,
    status,
    title,
    message,
  }));
}

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.redirect(res.locals.user ? '/dashboard' : '/login');
});

app.get('/login', (req, res) => {
  const next = safeMeetingNext(req.query.next);
  if (res.locals.user) return res.redirect(next || '/dashboard');
  const { error } = getFlash(req);
  return res.send(views.authPage({
    mode: 'login',
    csrf: res.locals.csrfToken,
    values: { email: typeof req.query.email === 'string' ? req.query.email : '' },
    error,
    next,
  }));
});

app.post('/login', asyncHandler(async (req, res) => {
  const next = safeMeetingNext(req.body.next);
  if (res.locals.user) return res.redirect(next || '/dashboard');
  const parsed = authSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).send(views.authPage({
      mode: 'login', csrf: res.locals.csrfToken,
      values: { email: String(req.body.email || '') },
      error: 'Adresse e-mail ou mot de passe invalide.',
      next,
    }));
  }
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(parsed.data.email);
  if (!user || !verifyPassword(parsed.data.password, user.password_salt, user.password_hash)) {
    return res.status(401).send(views.authPage({
      mode: 'login', csrf: res.locals.csrfToken,
      values: { email: parsed.data.email },
      error: 'Adresse e-mail ou mot de passe incorrect.',
      next,
    }));
  }
  await activatePendingInvites(user);
  const session = createSession(user.id);
  setSessionCookie(res, session.token, session.expires);
  rotateCsrf(res);
  return res.redirect(next || '/dashboard');
}));

app.get('/register', (req, res) => {
  const next = safeMeetingNext(req.query.next);
  if (res.locals.user) return res.redirect(next || '/dashboard');
  const { error } = getFlash(req);
  return res.send(views.authPage({
    mode: 'register', csrf: res.locals.csrfToken, values: {}, error, next,
  }));
});

app.post('/register', asyncHandler(async (req, res) => {
  const next = safeMeetingNext(req.body.next);
  if (res.locals.user) return res.redirect(next || '/dashboard');
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).send(views.authPage({
      mode: 'register', csrf: res.locals.csrfToken,
      values: { name: String(req.body.name || ''), email: String(req.body.email || '') },
      error: parsed.error.issues.map((issue) => issue.message).join(' ; '),
      next,
    }));
  }
  if (parsed.data.password !== parsed.data.password_confirm) {
    return res.status(422).send(views.authPage({
      mode: 'register', csrf: res.locals.csrfToken,
      values: { name: parsed.data.name, email: parsed.data.email },
      error: 'Les deux mots de passe ne correspondent pas.',
      next,
    }));
  }
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(parsed.data.email)) {
    return res.status(409).send(views.authPage({
      mode: 'register', csrf: res.locals.csrfToken,
      values: { name: parsed.data.name, email: parsed.data.email },
      error: 'Un compte existe déjà avec cette adresse.',
      next,
    }));
  }
  const userId = crypto.randomUUID();
  const password = hashPassword(parsed.data.password);
  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, password_salt, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, parsed.data.email, parsed.data.name, password.hash, password.salt, new Date().toISOString());
  const newUser = { id: userId, email: parsed.data.email, name: parsed.data.name };
  await activatePendingInvites(newUser);
  const session = createSession(userId);
  setSessionCookie(res, session.token, session.expires);
  rotateCsrf(res);
  return res.redirect(next || '/dashboard');
}));

app.post('/logout', (req, res) => {
  deleteSessionByToken(res.locals.sessionToken);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
  return res.redirect('/login');
});


// ---------------------------------------------------------------------------
// Accès à une réunion par lien secret
// ---------------------------------------------------------------------------

app.get('/m/:token', asyncHandler(async (req, res) => {
  const token = req.params.token;
  if (!res.locals.user) {
    const next = `/m/${encodeURIComponent(token)}`;
    return res.redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  let resolved;
  try {
    resolved = await api.resolveAccess(token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return res.status(404).send(views.errorPage({
        user: res.locals.user,
        csrf: res.locals.csrfToken,
        status: 404,
        title: 'Lien invalide',
        message: "Ce lien de réunion est invalide ou a expiré.",
      }));
    }
    if (error instanceof ApiError && error.status === 403 && error.details?.code === 'excluded') {
      return res.status(403).send(views.meetingTerminalPage({
        user: res.locals.user, csrf: res.locals.csrfToken,
        eyebrow: 'Accès refusé', title: 'Vous avez été exclu', meeting: null,
        message: "Ce lien ne permet plus de revenir dans cette réunion.",
      }));
    }
    return renderError(res, { status: 502, title: 'Service indisponible', message: error.message });
  }

  const { meeting, state, access } = resolved;
  if (state.phase === 'cancelled') {
    return res.status(410).send(views.meetingTerminalPage({
      user: res.locals.user, csrf: res.locals.csrfToken,
      eyebrow: 'Annulée', title: 'Réunion annulée', meeting,
      message: 'Cette réunion a été annulée par son organisateur.',
    }));
  }
  if (state.phase === 'ended') {
    return res.status(410).send(views.meetingTerminalPage({
      user: res.locals.user, csrf: res.locals.csrfToken,
      eyebrow: 'Créneau clôturé', title: 'Réunion terminée', meeting,
      message: "Le créneau est fermé. Les artefacts restent disponibles auprès de l'organisateur.",
    }));
  }
  if (state.phase === 'waiting') {
    return res.send(views.meetingWaitingPage({
      user: res.locals.user, csrf: res.locals.csrfToken, meeting, state,
    }));
  }

  const webMeeting = meetingByApiId(meeting.id);
  const membership = webMeeting ? organizerMembership(webMeeting.id, res.locals.user.id) : null;

  if (access.role === 'organizer') {
    const accountMatches = access.external_id && access.external_id === res.locals.user.id;
    const membershipMatches = webMeeting ? Boolean(membership) : true;
    if (!accountMatches || !membershipMatches) {
      return renderError(res, {
        status: 403,
        title: 'Accès organisateur refusé',
        message: "Ce lien organisateur est réservé à l'organisateur nominatif de cette réunion.",
      });
    }
  }

  if (access.role === 'participant' && membership && webMeeting) {
    const ownToken = extractLinkToken(membership.organizer_url_enc, 'organizer');
    if (ownToken) return res.redirect(302, `/m/${encodeURIComponent(ownToken)}`);
    return res.status(409).send(views.meetingTerminalPage({
      user: res.locals.user, csrf: res.locals.csrfToken,
      eyebrow: 'Organisateur', title: 'Lien organisateur indisponible', meeting,
      message: 'Votre compte est organisateur de cette réunion, mais son lien de modération est indisponible.',
    }));
  }

  let identity;
  if (access.kind === 'generic') {
    if (meeting.public_access && access.role === 'participant') {
      const publicName = readPublicName(req, token, res.locals.user.id);
      if (!publicName) {
        return res.send(views.meetingPublicNamePage({
          user: res.locals.user,
          csrf: res.locals.csrfToken,
          meeting,
          token,
          suggestedName: res.locals.user.name,
        }));
      }
      identity = { display_name: publicName, external_id: res.locals.user.id };
    } else {
      identity = { display_name: res.locals.user.name, external_id: res.locals.user.id };
    }
  } else {
    identity = { display_name: access.display_name, external_id: access.external_id };
  }

  // Le consentement à l'enregistrement appartient au consommateur de l'API.
  // L'API n'en sait rien ; la salle affiche ensuite l'indicateur d'enregistrement.
  if (meeting.recording && !hasRecordingConsent(meeting.id, res.locals.user.id)) {
    return res.send(views.meetingConsentPage({
      user: res.locals.user,
      csrf: res.locals.csrfToken,
      meeting,
      token,
    }));
  }

  const cookieName = meetingCookieName(token);
  const existingSession = req.cookies?.[cookieName] || '';
  let joined;
  try {
    joined = await api.joinAccess(token, identity, existingSession);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403 && error.details?.code === 'excluded') {
      return res.status(403).send(views.meetingTerminalPage({
        user: res.locals.user, csrf: res.locals.csrfToken,
        eyebrow: 'Accès refusé', title: 'Vous avez été exclu', meeting,
        message: "Ce lien ne permet plus de revenir dans cette réunion.",
      }));
    }
    if (error instanceof ApiError && error.status === 409) {
      return res.status(409).send(views.meetingTerminalPage({
        user: res.locals.user, csrf: res.locals.csrfToken,
        eyebrow: 'Capacité atteinte', title: 'Réunion complète', meeting,
        message: 'Les 30 places de cette réunion sont occupées. Réessayez si quelqu’un se déconnecte.',
      }));
    }
    if (error instanceof ApiError && error.status === 410) {
      return res.status(410).send(views.meetingTerminalPage({
        user: res.locals.user, csrf: res.locals.csrfToken,
        eyebrow: 'Créneau clôturé', title: 'Réunion terminée', meeting,
        message: error.message,
      }));
    }
    return renderError(res, { status: 502, title: 'Accès impossible', message: error.message });
  }

  setMeetingSessionCookie(res, token, joined.session_token, joined.meeting);
  if (joined.admission_status === 'waiting' || joined.status === 'waiting') {
    return res.send(views.meetingLobbyPage({
      user: res.locals.user,
      csrf: res.locals.csrfToken,
      meeting: joined.meeting,
      access: joined.access,
      state: joined.state,
      sessionToken: joined.session_token,
    }));
  }
  return res.send(views.meetingRoomPage({
    user: res.locals.user,
    meeting: joined.meeting,
    access: joined.access,
    state: joined.state,
    jitsiJwt: joined.jitsi_jwt,
    sessionToken: joined.session_token,
    sessionId: joined.session?.id || '',
    warningMinutes: joined.warning_minutes,
    csrf: res.locals.csrfToken,
  }));
}));

app.post('/m/:token/name', requireUser, asyncHandler(async (req, res) => {
  const token = req.params.token;
  let resolved;
  try {
    resolved = await api.resolveAccess(token);
  } catch (error) {
    return renderError(res, { status: 404, title: 'Lien invalide', message: error.message });
  }
  const { meeting, access, state } = resolved;
  if (access.role !== 'participant' || access.kind !== 'generic' || !meeting.public_access || state.phase !== 'open') {
    return renderError(res, { status: 403, title: 'Nom non modifiable', message: "Ce lien ne permet pas de saisir un nom public." });
  }
  const name = String(req.body.display_name || '').trim();
  if (name.length < 2 || name.length > 80) {
    return res.status(422).send(views.meetingPublicNamePage({
      user: res.locals.user,
      csrf: res.locals.csrfToken,
      meeting,
      token,
      suggestedName: name || res.locals.user.name,
      error: 'Le nom doit contenir entre 2 et 80 caractères.',
    }));
  }
  const ttl = Math.max(60_000, new Date(meeting.ends_at).getTime() - Date.now() + 3_600_000);
  res.cookie(publicNameCookieName(token), encryptJson({ tokenHash: sha256(token), name, user_id: res.locals.user.id }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: ttl,
  });
  return res.redirect(`/m/${encodeURIComponent(token)}`);
}));

app.post('/m/:token/consent', requireUser, asyncHandler(async (req, res) => {
  const token = req.params.token;
  let resolved;
  try {
    resolved = await api.resolveAccess(token);
  } catch (error) {
    return renderError(res, { status: 404, title: 'Lien invalide', message: error.message });
  }
  if (!resolved.meeting.recording) {
    return res.redirect(303, `/m/${encodeURIComponent(token)}`);
  }
  recordRecordingConsent(resolved.meeting.id, res.locals.user.id);
  return res.redirect(303, `/m/${encodeURIComponent(token)}`);
}));

// ---------------------------------------------------------------------------
// Tableau de bord
// ---------------------------------------------------------------------------

app.get('/dashboard', requireUser, asyncHandler(async (req, res) => {
  const rows = managedMeetings(res.locals.user.id);
  const meetings = await Promise.all(rows.map(async (web) => {
    try {
      return { web, api: await api.getMeeting(web.api_meeting_id), apiError: '' };
    } catch (error) {
      return {
        web,
        api: null,
        apiError: error instanceof ApiError && error.status === 503
          ? 'Service indisponible'
          : 'Réunion introuvable côté service',
      };
    }
  }));
  const { notice, error } = getFlash(req);
  res.send(views.dashboardPage({ user: res.locals.user, csrf: res.locals.csrfToken, meetings, notice, error }));
}));

app.get('/meetings/new', requireUser, (req, res) => {
  const { error } = getFlash(req);
  res.send(views.newMeetingPage({
    user: res.locals.user,
    csrf: res.locals.csrfToken,
    values: defaultFormValues(),
    error,
  }));
});

app.post('/meetings', requireUser, asyncHandler(async (req, res) => {
  const validated = validateMeetingForm(req.body);
  if (validated.error) {
    return res.status(422).send(views.newMeetingPage({
      user: res.locals.user,
      csrf: res.locals.csrfToken,
      values: validated.values,
      error: validated.error,
    }));
  }
  let created;
  try {
    created = await api.createMeeting({
      ...validated.payload,
      organizers: [{ display_name: res.locals.user.name, external_id: res.locals.user.id }],
      participants: [],
      generic_participant: true,
    });
  } catch (error) {
    return res.status(error instanceof ApiError ? error.status : 503).send(views.newMeetingPage({
      user: res.locals.user,
      csrf: res.locals.csrfToken,
      values: validated.values,
      error: error.message,
    }));
  }
  const organizerToken = created.links?.organizers?.[0]?.token || '';
  const participantToken = created.links?.generic_participant?.token || '';
  const webId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO web_meetings (id, user_id, api_meeting_id, title, starts_at, ends_at,
      early_join_minutes, recording, transcription, chat, public_access, waiting_room,
      organizer_url_enc, participant_url_enc, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    webId, res.locals.user.id, created.meeting.id, created.meeting.title,
    created.meeting.starts_at, created.meeting.ends_at, created.meeting.early_join_minutes,
    created.meeting.recording ? 1 : 0, created.meeting.transcription ? 1 : 0, created.meeting.chat ? 1 : 0,
    created.meeting.public_access ? 1 : 0, created.meeting.waiting_room ? 1 : 0,
    encryptJson({ organizer: organizerToken }), encryptJson({ participant: participantToken }), now,
  );
  db.prepare(`
    INSERT INTO meeting_organizers
      (id, web_meeting_id, user_id, email, display_name, organizer_url_enc, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(crypto.randomUUID(), webId, res.locals.user.id, res.locals.user.email,
    res.locals.user.name, encryptJson({ organizer: organizerToken }), now);
  return res.redirect(flashUrl(`/meetings/${webId}`, 'notice', 'Réunion créée. Conservez le lien organisateur.'));
}));

// ---------------------------------------------------------------------------
// Détail et actions
// ---------------------------------------------------------------------------

app.get('/meetings/:id', requireUser, asyncHandler(async (req, res) => {
  const web = managedMeeting(req.params.id, res.locals.user.id);
  if (!web) return renderError(res, { status: 404, title: 'Réunion introuvable', message: "Cette réunion n'existe pas ou ne vous appartient pas." });
  const links = linksFor(web);
  const errors = {};
  let meeting = null;
  let attendance = null;
  let chat = null;
  let artifacts = [];
  let processing = null;
  try { meeting = await api.getMeeting(web.api_meeting_id); } catch (error) { errors.meeting = error.message; }
  await Promise.all([
    api.getAttendance(web.api_meeting_id).then((data) => { attendance = data; }).catch((error) => { errors.attendance = error.message; }),
    api.getChat(web.api_meeting_id).then((data) => { chat = data; }).catch((error) => { errors.chat = error.message; }),
    api.getArtifacts(web.api_meeting_id).then((data) => { artifacts = data; }).catch((error) => { errors.artifacts = error.message; }),
    api.getProcessing(web.api_meeting_id).then((data) => { processing = data; }).catch((error) => { errors.processing = error.message; }),
  ]);
  const organizers = db.prepare(`
    SELECT display_name, email, status, user_id FROM meeting_organizers
    WHERE web_meeting_id=? ORDER BY created_at ASC
  `).all(web.id);
  const { notice, error } = getFlash(req);
  return res.send(views.detailPage({
    user: res.locals.user,
    csrf: res.locals.csrfToken,
    web,
    api: meeting,
    links,
    organizers,
    attendance,
    chat,
    artifacts,
    processing,
    errors,
    notice,
    error: error || errors.meeting || '',
  }));
}));

app.get('/meetings/:id/edit', requireUser, asyncHandler(async (req, res) => {
  const web = managedMeeting(req.params.id, res.locals.user.id);
  if (!web) return renderError(res, { status: 404, title: 'Réunion introuvable', message: "Cette réunion ne vous appartient pas." });
  let meeting;
  try { meeting = await api.getMeeting(web.api_meeting_id); } catch (error) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', error.message));
  }
  if (meeting.status !== 'scheduled' || meeting.started_at) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', "La réunion a déjà commencé et ne peut plus être modifiée."));
  }
  const { error } = getFlash(req);
  return res.send(views.editMeetingPage({
    user: res.locals.user,
    csrf: res.locals.csrfToken,
    web,
    api: meeting,
    values: {
      title: meeting.title,
      starts_local: toParisInput(meeting.starts_at),
      ends_local: toParisInput(meeting.ends_at),
      early_join_minutes: String(meeting.early_join_minutes ?? 0),
      recording: Boolean(meeting.recording),
      transcription: Boolean(meeting.transcription),
      chat: Boolean(meeting.chat),
      public_access: Boolean(meeting.public_access),
      waiting_room: Boolean(meeting.waiting_room),
    },
    error,
  }));
}));

app.post('/meetings/:id/edit', requireUser, asyncHandler(async (req, res) => {
  const web = managedMeeting(req.params.id, res.locals.user.id);
  if (!web) return renderError(res, { status: 404, title: 'Réunion introuvable', message: "Cette réunion ne vous appartient pas." });
  const validated = validateMeetingForm(req.body);
  if (validated.error) {
    return res.status(422).send(views.editMeetingPage({
      user: res.locals.user,
      csrf: res.locals.csrfToken,
      web,
      api: null,
      values: validated.values,
      error: validated.error,
    }));
  }
  try {
    await api.updateMeeting(web.api_meeting_id, validated.payload);
    db.prepare(`
      UPDATE web_meetings SET title=?, starts_at=?, ends_at=?, early_join_minutes=?, recording=?, transcription=?, chat=?,
        public_access=?, waiting_room=?
      WHERE id=?
    `).run(validated.payload.title, validated.payload.starts_at, validated.payload.ends_at,
      validated.payload.early_join_minutes, validated.payload.recording ? 1 : 0,
      validated.payload.transcription ? 1 : 0, validated.payload.chat ? 1 : 0,
      validated.payload.public_access ? 1 : 0, validated.payload.waiting_room ? 1 : 0, web.id);
  } catch (error) {
    return res.status(error instanceof ApiError ? error.status : 503).send(views.editMeetingPage({
      user: res.locals.user,
      csrf: res.locals.csrfToken,
      web,
      api: null,
      values: validated.values,
      error: error.message,
    }));
  }
  return res.redirect(flashUrl(`/meetings/${web.id}`, 'notice', 'Créneau mis à jour.'));
}));

app.post('/meetings/:id/cancel', requireUser, asyncHandler(async (req, res) => {
  const web = managedMeeting(req.params.id, res.locals.user.id);
  if (!web) return renderError(res, { status: 404, title: 'Réunion introuvable', message: "Cette réunion ne vous appartient pas." });
  try {
    await api.cancelMeeting(web.api_meeting_id);
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'notice', 'Réunion annulée.'));
  } catch (error) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', error.message));
  }
}));

app.post('/meetings/:id/end', requireUser, asyncHandler(async (req, res) => {
  const web = managedMeeting(req.params.id, res.locals.user.id);
  if (!web) return renderError(res, { status: 404, title: 'Réunion introuvable', message: "Cette réunion ne vous appartient pas." });
  try {
    await api.endMeeting(web.api_meeting_id);
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'notice', 'Réunion terminée. Les artefacts vont être produits.'));
  } catch (error) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', error.message));
  }
}));

app.post('/meetings/:id/processing/retry', requireUser, asyncHandler(async (req, res) => {
  const web = managedMeeting(req.params.id, res.locals.user.id);
  if (!web) return renderError(res, { status: 404, title: 'Réunion introuvable', message: "Cette réunion ne vous appartient pas." });
  const kind = ['recording', 'transcription', 'all'].includes(req.body.kind) ? req.body.kind : 'all';
  try {
    await api.retryProcessing(web.api_meeting_id, kind);
  } catch (error) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', error.message));
  }
  return res.redirect(flashUrl(`/meetings/${web.id}`, 'notice', 'Traitement relancé. Son état se met à jour ci-dessous.'));
}));

// ---------------------------------------------------------------------------
// Téléchargements protégés
// ---------------------------------------------------------------------------

app.get('/meetings/:id/artifacts/:artifactId/download', requireUser, asyncHandler(async (req, res) => {
  const web = managedMeeting(req.params.id, res.locals.user.id);
  if (!web) return renderError(res, { status: 404, title: 'Réunion introuvable', message: "Cette réunion ne vous appartient pas." });
  let artifacts;
  try { artifacts = await api.getArtifacts(web.api_meeting_id); } catch (error) {
    return renderError(res, { status: 502, title: 'Artefact indisponible', message: error.message });
  }
  if (!artifacts.some((artifact) => artifact.id === req.params.artifactId)) {
    return renderError(res, { status: 404, title: 'Artefact introuvable', message: "Cet artefact n'appartient pas à cette réunion." });
  }
  try {
    const signed = await api.getArtifactUrl(req.params.artifactId);
    return res.redirect(302, signed.url);
  } catch (error) {
    return renderError(res, { status: 502, title: 'Téléchargement impossible', message: error.message });
  }
}));

app.post('/meetings/:id/organizers', requireUser, asyncHandler(async (req, res) => {
  const web = managedMeeting(req.params.id, res.locals.user.id);
  if (!web) return renderError(res, { status: 404, title: 'Réunion introuvable', message: "Cette réunion ne vous appartient pas." });
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', 'Adresse e-mail invalide.'));
  }
  if (db.prepare('SELECT 1 FROM meeting_organizers WHERE web_meeting_id=? AND email=? COLLATE NOCASE').get(web.id, email)) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', 'Cette adresse est déjà organisatrice de la réunion.'));
  }
  let meeting;
  try {
    meeting = await api.getMeeting(web.api_meeting_id);
  } catch (error) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', error.message));
  }
  if (meeting.status !== 'scheduled' || meeting.started_at) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', 'Impossible d’ajouter un organisateur après le début de la réunion.'));
  }
  const user = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(email);
  if (!user) {
    db.prepare(`
      INSERT INTO meeting_organizers
        (id, web_meeting_id, user_id, email, display_name, organizer_url_enc, status, invited_by, created_at)
      VALUES (?, ?, NULL, ?, ?, NULL, 'pending', ?, ?)
    `).run(crypto.randomUUID(), web.id, email, email, res.locals.user.id, new Date().toISOString());
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'notice', 'Invitation enregistrée. L’organisateur devra créer un compte avec cette adresse.'));
  }
  try {
    const url = await createOrganizerLink(web, user);
    db.prepare(`
      INSERT INTO meeting_organizers
        (id, web_meeting_id, user_id, email, display_name, organizer_url_enc, status, invited_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(crypto.randomUUID(), web.id, user.id, user.email, user.name,
      encryptJson({ organizer: url }), res.locals.user.id, new Date().toISOString());
  } catch (error) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', error.message));
  }
  return res.redirect(flashUrl(`/meetings/${web.id}`, 'notice', 'Organisateur ajouté.'));
}));

app.post('/meetings/:id/access', requireUser, asyncHandler(async (req, res) => {
  const web = managedMeeting(req.params.id, res.locals.user.id);
  if (!web) return renderError(res, { status: 404, title: 'Réunion introuvable', message: "Cette réunion ne vous appartient pas." });
  const publicAccess = req.body.public_access === '1';
  const waitingRoom = req.body.waiting_room === '1';
  try {
    await api.updateMeeting(web.api_meeting_id, { public_access: publicAccess, waiting_room: waitingRoom });
    db.prepare('UPDATE web_meetings SET public_access=?, waiting_room=? WHERE id=?')
      .run(publicAccess ? 1 : 0, waitingRoom ? 1 : 0, web.id);
  } catch (error) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', error.message));
  }
  return res.redirect(flashUrl(`/meetings/${web.id}`, 'notice', "Réglages d'accès mis à jour."));
}));

app.post('/meetings/:id/artifacts/:artifactId/delete', requireUser, asyncHandler(async (req, res) => {
  const web = managedMeeting(req.params.id, res.locals.user.id);
  if (!web) return renderError(res, { status: 404, title: 'Réunion introuvable', message: "Cette réunion ne vous appartient pas." });
  let artifacts;
  try { artifacts = await api.getArtifacts(web.api_meeting_id); } catch (error) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', error.message));
  }
  if (!artifacts.some((artifact) => artifact.id === req.params.artifactId)) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', 'Artefact introuvable.'));
  }
  try {
    await api.deleteArtifact(req.params.artifactId);
  } catch (error) {
    return res.redirect(flashUrl(`/meetings/${web.id}`, 'error', error.message));
  }
  return res.redirect(flashUrl(`/meetings/${web.id}`, 'notice', 'Artefact supprimé définitivement.'));
}));

app.get('/meetings/:id/attendance.json', requireUser, asyncHandler(async (req, res) => {
  const web = managedMeeting(req.params.id, res.locals.user.id);
  if (!web) return renderError(res, { status: 404, title: 'Réunion introuvable', message: "Cette réunion ne vous appartient pas." });
  try {
    const attendance = await api.getAttendance(web.api_meeting_id);
    res.attachment('presence.json');
    return res.type('application/json').send(JSON.stringify(attendance, null, 2));
  } catch (error) {
    return renderError(res, { status: 502, title: 'Export impossible', message: error.message });
  }
}));

app.get('/meetings/:id/chat.json', requireUser, asyncHandler(async (req, res) => {
  const web = managedMeeting(req.params.id, res.locals.user.id);
  if (!web) return renderError(res, { status: 404, title: 'Réunion introuvable', message: "Cette réunion ne vous appartient pas." });
  try {
    const chat = await api.getChat(web.api_meeting_id);
    res.attachment('chat.json');
    return res.type('application/json').send(JSON.stringify(chat, null, 2));
  } catch (error) {
    return renderError(res, { status: 502, title: 'Export impossible', message: error.message });
  }
}));

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).send(views.errorPage({
    user: res.locals.user,
    csrf: res.locals.csrfToken,
    status: 404,
    title: 'Page introuvable',
    message: "La page demandée n'existe pas.",
  }));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const safePath = req.path.replace(/^\/m\/[^/]+/, '/m/[lien]');
  log.error('web.request_failed', {
    method: req.method,
    path: safePath,
    error: error.stack || error.message,
  });
  if (error instanceof ApiError) {
    return renderError(res, { status: error.status === 404 ? 404 : 502, title: 'Service indisponible', message: error.message });
  }
  return renderError(res, { status: 500, title: 'Erreur interne', message: 'Réessayez dans quelques instants.' });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  log.info('web.started', {
    base_url: config.baseUrl,
    port: config.port,
    api_internal_url: config.apiInternalUrl,
    client_id: config.clientId,
  });
  events.startEventStream();
});

function shutdown(signal) {
  log.info('web.stopping', { signal });
  events.stopEventStream();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app };
