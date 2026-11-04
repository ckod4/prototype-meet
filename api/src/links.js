'use strict';

const express = require('express');
const config = require('./config');
const { db } = require('./db');
const {
  getMeeting,
  resolveAccessToken,
  meetingState,
  createSession,
  activeParticipantCount,
  closeParticipantSessionsForIdentity,
} = require('./meetings');
const { signJitsiJwt } = require('./auth');
const { emit } = require('./webhooks');
const { HttpError, sha256, asyncHandler } = require('./util');
const log = require('./log');

const router = express.Router();
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function configuredTrustedProxies() {
  return new Set(
    String(process.env.TRUSTED_PROXIES || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}
const trustedProxies = configuredTrustedProxies();

/**
 * L'adresse IP ne sert qu'au limiteur de débit des liens publics.
 * Elle n'est jamais utilisée comme identité de réunion.
 */
function clientAddress(req) {
  const remote = req.socket?.remoteAddress || '';
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  if (forwarded && (trustedProxies.has(remote) || LOOPBACK.has(remote) || process.env.TRUST_PROXY === '1')) {
    return forwarded;
  }
  return remote;
}

const windows = new Map();
function linkRateLimit(req, res, next) {
  const key = clientAddress(req);
  const now = Date.now();
  if (windows.size > 5000) {
    for (const [address, entry] of windows) {
      if (now - entry.startedAt > 60_000) windows.delete(address);
    }
  }
  let entry = windows.get(key);
  if (!entry || now - entry.startedAt >= 60_000) {
    entry = { startedAt: now, count: 0 };
    windows.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > 600) {
    return next(new HttpError(429, 'Trop de tentatives. Réessayez dans une minute.'));
  }
  return next();
}

function accessJson(access) {
  return {
    role: access.role,
    kind: access.kind,
    display_name: access.display_name || null,
    external_id: access.external_id || null,
  };
}

function meetingInfo(meeting) {
  return {
    id: meeting.id,
    title: meeting.title,
    starts_at: meeting.starts_at,
    ends_at: meeting.ends_at,
    early_join_minutes: meeting.early_join_minutes,
    status: meeting.status,
    recording: Boolean(meeting.recording),
    transcription: Boolean(meeting.transcription),
    chat: Boolean(meeting.chat),
    public_access: Boolean(meeting.public_access),
    waiting_room: Boolean(meeting.waiting_room),
    recording_state: meeting.recording_state || 'idle',
    recording_error: meeting.recording_error || null,
  };
}

function isBanned(meetingId, access, externalId) {
  if (access.role !== 'participant') return false;
  const rows = db.prepare('SELECT * FROM meeting_bans WHERE meeting_id=?').all(meetingId);
  return rows.some((ban) => {
    if (ban.external_id && externalId && ban.external_id === externalId) return true;
    if (ban.token_id && access.kind === 'named' && ban.token_id === access.id) return true;
    return false;
  });
}

function throwIfBanned(meetingId, access, externalId) {
  if (isBanned(meetingId, access, externalId)) {
    throw new HttpError(403, 'Vous avez été exclu de cette réunion.', { code: 'excluded' });
  }
}

function sessionJson(session) {
  return {
    id: session.id,
    role: session.role,
    display_name: session.display_name,
    external_id: session.external_id || null,
    admission_status: session.admission_status,
    media: {
      audio_allowed: Boolean(session.media_audio_allowed),
      video_allowed: Boolean(session.media_video_allowed),
      screen_allowed: Boolean(session.media_screen_allowed),
    },
  };
}

router.use(['/api/v1/links'], linkRateLimit);

router.post('/api/v1/links/resolve', (req, res) => {
  const rawToken = String(req.body?.token || '');
  if (!rawToken || rawToken.length > 256) throw new HttpError(422, 'Jeton manquant');
  const access = resolveAccessToken(rawToken);
  if (!access) throw new HttpError(404, 'Lien de réunion invalide');
  const meeting = getMeeting(access.meeting_id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  if (isBanned(meeting.id, access, access.external_id || null)) {
    throw new HttpError(403, 'Vous avez été exclu de cette réunion.', { code: 'excluded' });
  }
  const state = meetingState(meeting);
  res.json({
    access: accessJson(access),
    meeting: meetingInfo(meeting),
    state,
  });
});

router.post('/api/v1/links/join', asyncHandler(async (req, res) => {
  const rawToken = String(req.body?.token || '');
  if (!rawToken || rawToken.length > 256) throw new HttpError(422, 'Jeton manquant');
  const access = resolveAccessToken(rawToken);
  if (!access) throw new HttpError(404, 'Lien de réunion invalide');
  const meeting = getMeeting(access.meeting_id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  const state = meetingState(meeting);
  if (state.phase !== 'open') {
    throw new HttpError(410, state.phase === 'cancelled' ? 'Réunion annulée' : 'Le créneau est fermé', {
      code: state.phase,
      phase: state.phase,
      meeting: meetingInfo(meeting),
      state,
    });
  }

  let displayName;
  let externalId;
  if (access.kind === 'generic') {
    displayName = String(req.body?.display_name || '').trim();
    externalId = String(req.body?.external_id || '').trim();
    if (displayName.length < 2 || displayName.length > 80) {
      throw new HttpError(422, 'Nom affiché invalide');
    }
    if (externalId.length < 1 || externalId.length > 128) {
      throw new HttpError(422, 'Identifiant externe invalide');
    }
  } else {
    displayName = access.display_name;
    externalId = access.external_id || null;
    if (!displayName) throw new HttpError(500, 'Identité du lien incomplète');
  }

  throwIfBanned(meeting.id, access, externalId);

  const providedSession = String(req.body?.session_token || '');
  let session = null;
  let sessionToken = null;
  if (providedSession) {
    const existing = db.prepare(`
      SELECT * FROM sessions
      WHERE session_token_hash=? AND meeting_id=? AND token_id=? AND left_at IS NULL AND excluded_at IS NULL
    `).get(sha256(providedSession), meeting.id, access.id);
    if (existing
      && existing.display_name === displayName
      && (existing.external_id || null) === (externalId || null)
      && existing.admission_status !== 'rejected') {
      session = existing;
      sessionToken = providedSession;
    }
  }

  if (!session) {
    if (access.role === 'participant' && activeParticipantCount(meeting.id) >= config.limits.maxParticipants) {
      throw new HttpError(409, 'Réunion complète (30 participants maximum)');
    }
    session = createSession({
      meetingId: meeting.id,
      tokenId: access.id,
      role: access.role,
      displayName,
      externalId,
      userAgent: req.get('user-agent'),
      admissionStatus: meeting.waiting_room && access.role === 'participant' ? 'waiting' : 'admitted',
    });
    sessionToken = session.sessionToken;
    if (session.admission_status === 'waiting') {
      emit('waiting.updated', meeting.id, { session_id: session.id, action: 'joined' });
    }
  }

  if (!meeting.waiting_room && session.admission_status === 'waiting') {
    const at = new Date().toISOString();
    db.prepare("UPDATE sessions SET admission_status='admitted', admitted_at=? WHERE id=? AND admission_status='waiting'")
      .run(at, session.id);
    session.admission_status = 'admitted';
    emit('admission.updated', meeting.id, { session_id: session.id, status: 'admitted' });
  }

  if (access.role === 'organizer') {
    const closedSessions = closeParticipantSessionsForIdentity(meeting.id, externalId);
    for (const closed of closedSessions) {
      emit('session.left', meeting.id, {
        session_id: closed.id,
        role: closed.role,
        display_name: closed.display_name,
        external_id: closed.external_id || null,
        reason: 'organizer_joined',
      });
    }
    if (closedSessions.length) {
      emit('waiting.updated', meeting.id, { action: 'organizer_join', count: closedSessions.length });
    }
  }

  if (access.role === 'participant' && session.admission_status === 'waiting') {
    return res.json({
      status: 'waiting',
      admission_status: 'waiting',
      access: {
        ...accessJson(access),
        display_name: displayName,
        external_id: externalId,
      },
      meeting: meetingInfo(meeting),
      state,
      session_id: session.id,
      session: sessionJson(session),
      session_token: sessionToken,
      warning_minutes: config.limits.endWarningMinutes,
    });
  }

  let jitsiJwt;
  try {
    jitsiJwt = await signJitsiJwt(meeting, {
      id: session.id,
      role: access.role,
      display_name: displayName,
      external_id: externalId,
    });
  } catch (error) {
    if (error.status === 410) {
      throw new HttpError(410, 'Le créneau est terminé', { phase: 'ended' });
    }
    throw error;
  }

  const fresh = db.prepare('SELECT * FROM sessions WHERE id=?').get(session.id);
  res.json({
    status: 'admitted',
    admission_status: fresh.admission_status,
    access: {
      ...accessJson(access),
      display_name: displayName,
      external_id: externalId,
    },
    meeting: {
      ...meetingInfo(meeting),
      room: meeting.room,
    },
    state,
    session_id: fresh.id,
    session: sessionJson(fresh),
    jitsi_jwt: jitsiJwt,
    session_token: sessionToken,
    warning_minutes: config.limits.endWarningMinutes,
  });
}));

router.use((error, req, res, next) => {
  log.warn('links.error', {
    path: req.path,
    status: error.status || 500,
    message: error.message,
    code: error.details?.code,
  });
  next(error);
});

module.exports = { router };
