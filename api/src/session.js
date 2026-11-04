'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { z } = require('zod');
const config = require('./config');
const { db } = require('./db');
const {
  getMeeting,
  meetingState,
  markJoined,
  markLeft,
  activeOrganizerCount,
  waitingSessions,
  admitWaitingSessions,
  rejectWaitingSession,
} = require('./meetings');
const { requireSession } = require('./auth');
const { finalizeMeeting } = require('./finalize');
const { emit } = require('./webhooks');
const { HttpError, asyncHandler, nowIso, randomId } = require('./util');

const router = express.Router();

function requireOperationalMeeting(req) {
  const meeting = getMeeting(req.session.meeting_id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  return meeting;
}

function assertOrganizer(req) {
  if (req.session.role !== 'organizer') {
    throw new HttpError(403, 'Rôle organisateur requis');
  }
  if (!req.session.joined_at || req.session.left_at) {
    throw new HttpError(409, "L'organisateur doit être présent dans la réunion");
  }
}

function mediaJson(session) {
  return {
    audio_allowed: Boolean(session.media_audio_allowed),
    video_allowed: Boolean(session.media_video_allowed),
    screen_allowed: Boolean(session.media_screen_allowed),
  };
}

function participantJson(session) {
  return {
    session_id: session.id,
    role: session.role,
    display_name: session.display_name,
    external_id: session.external_id || null,
    admission_status: session.admission_status,
    joined_at: session.joined_at || null,
    media: mediaJson(session),
  };
}

function parseModeration(body) {
  const schema = z.discriminatedUnion('action', [
    z.object({
      action: z.literal('set_media'),
      target_session_id: z.string().min(1).max(64),
      media: z.enum(['audio', 'video', 'screen']),
      allowed: z.boolean(),
    }).strict(),
    z.object({
      action: z.literal('mute_all'),
      media: z.enum(['audio', 'video', 'screen']).optional().default('audio'),
    }).strict(),
    z.object({
      action: z.literal('exclude'),
      target_session_id: z.string().min(1).max(64),
      reason: z.string().trim().max(300).optional().default(''),
    }).strict(),
    z.object({
      action: z.literal('admit'),
      all: z.boolean().optional().default(false),
      session_ids: z.array(z.string().min(1).max(64)).max(100).optional().default([]),
    }).strict(),
    z.object({
      action: z.literal('reject'),
      target_session_id: z.string().min(1).max(64),
    }).strict(),
    z.object({
      action: z.literal('chat'),
      enabled: z.boolean(),
    }).strict(),
    z.object({
      action: z.literal('end'),
    }).strict(),
  ]);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(422, 'Action de modération invalide', parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })));
  }
  return parsed.data;
}

router.get('/api/session/status', requireSession, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const meeting = requireOperationalMeeting(req);
  if (req.session.excluded_at) {
    throw new HttpError(403, 'Vous avez été exclu de cette réunion.', { code: 'excluded' });
  }
  if (req.session.admission_status === 'rejected') {
    throw new HttpError(410, "Votre demande d'admission a été refusée.", { code: 'rejected' });
  }
  if (req.session.left_at) {
    throw new HttpError(410, 'Session de réunion terminée.', { code: 'session_ended' });
  }
  if (!meeting.waiting_room && req.session.admission_status === 'waiting') {
    const at = nowIso();
    db.prepare("UPDATE sessions SET admission_status='admitted', admitted_at=? WHERE id=? AND admission_status='waiting'")
      .run(at, req.session.id);
    req.session.admission_status = 'admitted';
    emit('admission.updated', meeting.id, { session_id: req.session.id, status: 'admitted' });
  }
  const fresh = db.prepare('SELECT * FROM sessions WHERE id=?').get(req.session.id);
  res.json({
    ...meetingState(meeting),
    meeting_id: meeting.id,
    session_id: fresh.id,
    title: meeting.title,
    role: fresh.role,
    display_name: fresh.display_name,
    external_id: fresh.external_id || null,
    recording: Boolean(meeting.recording),
    transcription: Boolean(meeting.transcription),
    chat: Boolean(meeting.chat),
    public_access: Boolean(meeting.public_access),
    waiting_room: Boolean(meeting.waiting_room),
    admission_status: fresh.admission_status,
    excluded: Boolean(fresh.excluded_at),
    media: mediaJson(fresh),
    recording_state: meeting.recording_state || 'idle',
    recording_error: meeting.recording_error || null,
    server_now: nowIso(),
  });
});

router.post('/api/session/events', requireSession, asyncHandler(async (req, res) => {
  const session = req.session;
  const meeting = requireOperationalMeeting(req);
  if (session.excluded_at) throw new HttpError(403, 'Vous avez été exclu de cette réunion.', { code: 'excluded' });
  if (session.admission_status === 'rejected') throw new HttpError(410, "Votre demande d'admission a été refusée.", { code: 'rejected' });
  const type = String(req.body?.type || '');
  const state = meetingState(meeting);
  if (session.left_at && type !== 'left') throw new HttpError(410, 'Session déjà terminée');

  if (type === 'joined') {
    if (state.phase !== 'open') throw new HttpError(410, 'Le créneau est fermé');
    if (session.admission_status !== 'admitted') throw new HttpError(403, "En attente d'admission");
    const result = markJoined({ id: session.id, meeting_id: session.meeting_id });
    if (result.joined) {
      emit('session.joined', meeting.id, {
        session_id: session.id,
        role: session.role,
        display_name: session.display_name,
        external_id: session.external_id || null,
      });
      emit('waiting.updated', meeting.id, { action: 'left_waiting', session_id: session.id });
    }
    if (result.started) {
      emit('meeting.started', meeting.id, { started_at: result.meeting.started_at });
    }
    return res.json({ ok: true, joined: result.joined, phase: meetingState(result.meeting).phase });
  }

  if (type === 'heartbeat') {
    db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(nowIso(), session.id);
    return res.json({
      ok: true,
      phase: state.phase,
      ends_at: state.ends_at,
      server_now: nowIso(),
      media: mediaJson(db.prepare('SELECT * FROM sessions WHERE id=?').get(session.id)),
    });
  }

  if (type === 'left') {
    const existed = db.prepare('SELECT * FROM sessions WHERE id=?').get(session.id);
    const changed = markLeft(session.id, 'client_leave');
    if (changed && existed?.joined_at) {
      emit('session.left', meeting.id, {
        session_id: session.id,
        role: session.role,
        display_name: session.display_name,
        external_id: session.external_id || null,
      });
    }
    return res.json({ ok: true });
  }

  if (type === 'capture_complete') {
    const raw = Array.isArray(req.body?.mute_intervals) ? req.body.mute_intervals : [];
    const intervals = raw.slice(0, 500).map((interval) => ({
      start: Math.max(0, Number(interval.start) || 0),
      end: Math.max(0, Number(interval.end) || 0),
    })).filter((interval) => interval.end > interval.start);
    db.prepare('UPDATE captures SET mute_intervals=?, complete=1 WHERE meeting_id=? AND session_id=?')
      .run(JSON.stringify(intervals), session.meeting_id, session.id);
    return res.json({ ok: true });
  }

  if (type === 'chat') {
    if (state.phase !== 'open') throw new HttpError(410, 'Le créneau est fermé');
    if (!meeting.chat) throw new HttpError(403, 'Le chat est désactivé pour cette réunion');
    if (session.admission_status !== 'admitted') throw new HttpError(403, "En attente d'admission");
    const text = String(req.body?.text || '').trim();
    if (!text || text.length > 2000) throw new HttpError(422, 'Message vide ou trop long (2000 caractères max)');
    if (req.body?.private === true) return res.json({ ok: true, ignored: true });
    const nick = String(req.body?.nick || '').trim().slice(0, 80);
    const messageId = String(req.body?.message_id || '').trim().slice(0, 200) || null;
    let author = null;
    if (nick) {
      author = db.prepare(`
        SELECT * FROM sessions WHERE meeting_id=? AND display_name=? AND joined_at IS NOT NULL
        ORDER BY joined_at DESC LIMIT 1
      `).get(session.meeting_id, nick);
    }
    if (!author) author = session;
    const recent = db.prepare(`
      SELECT * FROM chat_messages
      WHERE meeting_id=? AND author_name=? AND text=? AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(session.meeting_id, author.display_name, text,
      new Date(Date.now() - 15000).toISOString());
    if (recent && messageId && !recent.jitsi_message_id) {
      db.prepare('UPDATE chat_messages SET jitsi_message_id=? WHERE id=?').run(messageId, recent.id);
      return res.status(200).json({ ok: true, deduplicated: true });
    }
    if (recent && !messageId) return res.status(200).json({ ok: true, deduplicated: true });
    let insertedId = null;
    try {
      const result = db.prepare(`
        INSERT INTO chat_messages (meeting_id, session_id, author_name, external_id, role, text, jitsi_message_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(session.meeting_id, session.id, author.display_name, author.external_id, author.role,
        text, messageId, nowIso());
      insertedId = Number(result.lastInsertRowid);
    } catch (error) {
      if (!/UNIQUE/i.test(String(error.message))) throw error;
    }
    if (insertedId) {
      emit('chat.message', meeting.id, {
        message_id: insertedId,
        author: {
          display_name: author.display_name,
          external_id: author.external_id || null,
          role: author.role,
        },
        text,
        created_at: nowIso(),
      });
    }
    return res.status(201).json({ ok: true });
  }

  throw new HttpError(400, `Type d'événement inconnu: ${type}`);
}));

const captureRaw = express.raw({ type: () => true, limit: '12mb' });

router.post('/api/session/capture', requireSession, captureRaw, asyncHandler(async (req, res) => {
  const session = req.session;
  const meeting = requireOperationalMeeting(req);
  if (meeting.status === 'cancelled') throw new HttpError(410, 'Réunion annulée');
  if (meetingState(meeting).phase !== 'open') throw new HttpError(410, 'Le créneau est fermé');
  if (session.left_at) throw new HttpError(410, 'Session de réunion terminée.');
  if (session.excluded_at) throw new HttpError(403, 'Vous avez été exclu de cette réunion.', { code: 'excluded' });
  if (session.admission_status !== 'admitted') throw new HttpError(403, "En attente d'admission");
  if (!meeting.transcription) throw new HttpError(404, 'Transcription désactivée pour cette réunion');
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(422, 'Chunk audio vide');
  const index = Number.parseInt(req.get('x-capture-index') || '0', 10);
  if (!Number.isFinite(index) || index < 0 || index > 100000) throw new HttpError(422, 'Index de capture invalide');
  const mime = String(req.get('x-capture-mime') || req.get('content-type') || 'audio/webm').slice(0, 100);
  if (!/^audio\/|^video\/|^application\/octet-stream/.test(mime)) {
    throw new HttpError(415, 'Type de capture non supporté');
  }
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';
  const relative = path.join(meeting.id, `${session.id}.${ext}`);
  const absolute = path.join(config.capturesDir, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });

  let capture = db.prepare('SELECT * FROM captures WHERE meeting_id=? AND session_id=?')
    .get(meeting.id, session.id);

  if (!capture) {
    const startedAtHeader = req.get('x-capture-started-at');
    let startedAt = nowIso();
    if (startedAtHeader) {
      const parsed = new Date(startedAtHeader);
      if (!Number.isNaN(parsed.getTime()) && Math.abs(Date.now() - parsed.getTime()) < 6 * 3600_000) {
        startedAt = parsed.toISOString();
      }
    }
    const id = randomId(16);
    db.prepare(`
      INSERT INTO captures (id, meeting_id, session_id, display_name, external_id, role, file_path, mime,
        started_at, chunks, bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    `).run(id, meeting.id, session.id, session.display_name, session.external_id, session.role,
      relative, mime, startedAt, nowIso());
    capture = db.prepare('SELECT * FROM captures WHERE id=?').get(id);
  }

  if (index < capture.chunks) return res.json({ ok: true, duplicate: true, chunks: capture.chunks });
  if (index > capture.chunks) throw new HttpError(409, `Chunk attendu ${capture.chunks}, reçu ${index}`);
  await fs.promises.appendFile(absolute, req.body);
  db.prepare('UPDATE captures SET chunks=chunks+1, bytes=bytes+?, mime=? WHERE id=?')
    .run(req.body.length, mime, capture.id);
  const updated = db.prepare('SELECT chunks, bytes FROM captures WHERE id=?').get(capture.id);
  return res.status(201).json({ ok: true, chunks: updated.chunks, bytes: updated.bytes });
}));

// ---------------------------------------------------------------------------
// Modération : toutes les décisions sont prises avec la session organisateur,
// jamais avec la clé maître. Le rôle vient donc du lien utilisé.
// ---------------------------------------------------------------------------

router.get('/api/session/waiting', requireSession, (req, res) => {
  assertOrganizer(req);
  const meeting = requireOperationalMeeting(req);
  res.set('Cache-Control', 'no-store');
  res.json({
    meeting_id: meeting.id,
    waiting_room: Boolean(meeting.waiting_room),
    organizer_present: activeOrganizerCount(meeting.id) > 0,
    waiting: waitingSessions(meeting.id).map((session) => ({
      session_id: session.id,
      display_name: session.display_name,
      external_id: session.external_id,
      waiting_since: session.created_at,
    })),
  });
});

router.get('/api/session/participants', requireSession, (req, res) => {
  assertOrganizer(req);
  const meeting = requireOperationalMeeting(req);
  const participants = db.prepare(`
    SELECT * FROM sessions
    WHERE meeting_id=? AND role='participant' AND left_at IS NULL AND admitted_at IS NOT NULL
    ORDER BY joined_at ASC, created_at ASC
  `).all(meeting.id);
  const bans = db.prepare(`
    SELECT id, display_name, external_id, created_at FROM meeting_bans
    WHERE meeting_id=? ORDER BY created_at DESC LIMIT 200
  `).all(meeting.id);
  res.set('Cache-Control', 'no-store');
  res.json({
    meeting_id: meeting.id,
    chat: Boolean(meeting.chat),
    waiting_room: Boolean(meeting.waiting_room),
    participants: participants.map(participantJson),
    waiting: waitingSessions(meeting.id).map((session) => ({
      session_id: session.id,
      display_name: session.display_name,
      external_id: session.external_id,
      waiting_since: session.created_at,
    })),
    banned: bans.map((ban) => ({
      id: ban.id,
      display_name: ban.display_name,
      external_id: ban.external_id,
      created_at: ban.created_at,
    })),
  });
});

router.post('/api/session/moderation', requireSession, asyncHandler(async (req, res) => {
  assertOrganizer(req);
  const meeting = requireOperationalMeeting(req);
  const input = parseModeration(req.body);
  const state = meetingState(meeting);

  if (['set_media', 'mute_all', 'admit', 'reject'].includes(input.action) && state.phase !== 'open') {
    throw new HttpError(410, 'Le créneau est fermé');
  }

  if (input.action === 'set_media') {
    const target = db.prepare(`
      SELECT * FROM sessions WHERE id=? AND meeting_id=? AND role='participant' AND left_at IS NULL
    `).get(input.target_session_id, meeting.id);
    if (!target) throw new HttpError(404, 'Participant introuvable');
    const column = {
      audio: 'media_audio_allowed',
      video: 'media_video_allowed',
      screen: 'media_screen_allowed',
    }[input.media];
    db.prepare(`UPDATE sessions SET ${column}=? WHERE id=?`).run(input.allowed ? 1 : 0, target.id);
    const fresh = db.prepare('SELECT * FROM sessions WHERE id=?').get(target.id);
    emit('media.policy', meeting.id, {
      session_id: fresh.id,
      media: input.media,
      allowed: input.allowed,
    });
    return res.json({ ok: true, participant: participantJson(fresh) });
  }

  if (input.action === 'mute_all') {
    const column = {
      audio: 'media_audio_allowed',
      video: 'media_video_allowed',
      screen: 'media_screen_allowed',
    }[input.media];
    const result = db.prepare(`
      UPDATE sessions SET ${column}=0
      WHERE meeting_id=? AND role='participant' AND left_at IS NULL AND admission_status='admitted'
    `).run(meeting.id);
    emit('media.broadcast', meeting.id, { media: input.media, allowed: false });
    return res.json({ ok: true, affected: Number(result.changes) });
  }

  if (input.action === 'exclude') {
    const target = db.prepare(`
      SELECT s.*, t.kind AS token_kind FROM sessions s
      LEFT JOIN access_tokens t ON t.id=s.token_id
      WHERE s.id=? AND s.meeting_id=? AND s.role='participant' AND s.left_at IS NULL
    `).get(input.target_session_id, meeting.id);
    if (!target) throw new HttpError(404, 'Participant introuvable');
    const at = nowIso();
    db.prepare(`
      UPDATE sessions SET excluded_at=?, left_at=?, last_seen_at=?, admission_status='rejected'
      WHERE id=? AND left_at IS NULL
    `).run(at, at, at, target.id);
    if (target.joined_at) {
      db.prepare(`
        INSERT INTO attendance_events (meeting_id, session_id, type, display_name, external_id, role, at)
        VALUES (?, ?, 'left', ?, ?, ?, ?)
      `).run(meeting.id, target.id, target.display_name, target.external_id, target.role, at);
    }
    db.prepare(`
      INSERT INTO meeting_bans (id, meeting_id, session_id, token_id, external_id, display_name, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomId(16),
      meeting.id,
      target.id,
      target.token_kind === 'named' ? target.token_id : null,
      target.external_id || null,
      target.display_name,
      input.reason || '',
      at,
    );
    emit('participant.excluded', meeting.id, {
      session_id: target.id,
      display_name: target.display_name,
      reason: input.reason || '',
    });
    emit('session.left', meeting.id, {
      session_id: target.id,
      role: target.role,
      display_name: target.display_name,
      external_id: target.external_id || null,
      reason: 'excluded',
    });
    emit('waiting.updated', meeting.id, { action: 'excluded', session_id: target.id });
    return res.json({ ok: true, excluded: target.id });
  }

  if (input.action === 'admit') {
    if (!input.all && input.session_ids.length === 0) {
      throw new HttpError(422, 'Sélectionnez au moins un participant');
    }
    const ids = admitWaitingSessions(meeting.id, { all: input.all, sessionIds: input.session_ids });
    for (const sessionId of ids) {
      emit('admission.updated', meeting.id, { session_id: sessionId, status: 'admitted' });
    }
    if (ids.length) emit('waiting.updated', meeting.id, { action: 'admitted', count: ids.length });
    return res.json({ ok: true, admitted: ids.length, session_ids: ids });
  }

  if (input.action === 'reject') {
    const session = rejectWaitingSession(meeting.id, input.target_session_id);
    if (!session) throw new HttpError(404, 'Participant en attente introuvable');
    emit('admission.updated', meeting.id, { session_id: session.id, status: 'rejected' });
    emit('waiting.updated', meeting.id, { action: 'rejected', session_id: session.id });
    return res.json({ ok: true, rejected: session.id });
  }

  if (input.action === 'chat') {
    if (meeting.status === 'ended' || meeting.status === 'cancelled') {
      throw new HttpError(409, 'Réunion terminée');
    }
    db.prepare('UPDATE meetings SET chat=? WHERE id=?').run(input.enabled ? 1 : 0, meeting.id);
    emit('meeting.updated', meeting.id, { chat: input.enabled });
    return res.json({ ok: true, chat: input.enabled });
  }

  if (input.action === 'end') {
    if (meeting.status === 'ended') return res.json({ ok: true, meeting: { id: meeting.id, status: 'ended' } });
    if (meeting.status === 'cancelled') throw new HttpError(409, 'Réunion annulée');
    await finalizeMeeting(meeting.id, 'organizer_end');
    return res.json({ ok: true, meeting: { id: meeting.id, status: 'ended' } });
  }

  throw new HttpError(400, 'Action inconnue');
}));

module.exports = { router };
