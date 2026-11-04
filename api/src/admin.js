'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { z } = require('zod');
const config = require('./config');
const { db, tx } = require('./db');
const {
  getMeeting,
  meetingJson,
  createAccessToken,
  meetingState,
  attendanceReport,
  chatReport,
  activeOrganizerCount,
  waitingSessions,
  admitWaitingSessions,
  artifactJson,
  safeJson,
} = require('./meetings');
const { requireAdmin } = require('./auth');
const { finalizeMeeting, insertArtifact, scanRecordings } = require('./finalize');
const { emit } = require('./webhooks');
const s3 = require('./s3');
const {
  HttpError,
  asyncHandler,
  randomId,
  parseOffsetDate,
  nowIso,
} = require('./util');

const router = express.Router();
router.use((req, res, next) => {
  if (req.path.startsWith('/api/v1') || req.path.startsWith('/internal')) {
    return requireAdmin(req, res, next);
  }
  return next();
});

const personSchema = z.object({
  display_name: z.string().trim().min(2).max(80),
  external_id: z.string().trim().min(1).max(128),
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  starts_at: z.string().min(10).max(64),
  ends_at: z.string().min(10).max(64),
  early_join_minutes: z.number().int().min(0).max(config.limits.maxEarlyJoinMinutes).optional(),
  recording: z.boolean().optional(),
  transcription: z.boolean().optional(),
  chat: z.boolean().optional(),
  public_access: z.boolean().optional(),
  waiting_room: z.boolean().optional(),
  organizers: z.array(personSchema).min(1).max(10),
  participants: z.array(personSchema).max(config.limits.maxParticipants).optional().default([]),
  generic_participant: z.boolean().optional().default(true),
}).strict();

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  starts_at: z.string().min(10).max(64).optional(),
  ends_at: z.string().min(10).max(64).optional(),
  early_join_minutes: z.number().int().min(0).max(config.limits.maxEarlyJoinMinutes).optional(),
  recording: z.boolean().optional(),
  transcription: z.boolean().optional(),
  chat: z.boolean().optional(),
  public_access: z.boolean().optional(),
  waiting_room: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'Aucun champ à modifier' });

function parseZod(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, 'Données invalides', parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })));
  }
  return parsed.data;
}

function validateWindow(startsAt, endsAt, earlyJoinMinutes) {
  const start = parseOffsetDate(startsAt);
  const end = parseOffsetDate(endsAt);
  const durationMinutes = (end.getTime() - start.getTime()) / 60_000;
  if (durationMinutes < config.limits.minDurationMinutes) {
    throw new HttpError(422, `La durée minimale est de ${config.limits.minDurationMinutes} minutes`);
  }
  if (durationMinutes > config.limits.maxDurationMinutes) {
    throw new HttpError(422, `La durée maximale est de ${config.limits.maxDurationMinutes} minutes`);
  }
  if (end.getTime() <= Date.now()) throw new HttpError(422, 'Le créneau est déjà terminé');
  if (earlyJoinMinutes < 0 || earlyJoinMinutes > config.limits.maxEarlyJoinMinutes) {
    throw new HttpError(422, `La marge d'ouverture doit être comprise entre 0 et ${config.limits.maxEarlyJoinMinutes} minutes`);
  }
  return { start, end };
}

function assertRecordingCapacity(startsAt, endsAt, recording, excludeId = null) {
  if (!recording) return;
  const query = excludeId
    ? `SELECT COUNT(*) AS n FROM meetings
       WHERE recording=1 AND status IN ('scheduled','in_progress') AND id <> ?
         AND starts_at < ? AND ends_at > ?`
    : `SELECT COUNT(*) AS n FROM meetings
       WHERE recording=1 AND status IN ('scheduled','in_progress')
         AND starts_at < ? AND ends_at > ?`;
  const params = excludeId ? [excludeId, endsAt, startsAt] : [endsAt, startsAt];
  const { n } = db.prepare(query).get(...params);
  if (n >= config.maxConcurrentRecordings) {
    throw new HttpError(409, `Capacité d'enregistrement atteinte sur ce créneau (${config.maxConcurrentRecordings} réunion(s) simultanée(s))`);
  }
}

function assertCapacity(startsAt, endsAt, excludeId = null) {
  const query = excludeId
    ? `SELECT COUNT(*) AS n FROM meetings
       WHERE status IN ('scheduled','in_progress') AND id <> ?
         AND starts_at < ? AND ends_at > ?`
    : `SELECT COUNT(*) AS n FROM meetings
       WHERE status IN ('scheduled','in_progress')
         AND starts_at < ? AND ends_at > ?`;
  const params = excludeId ? [excludeId, endsAt, startsAt] : [endsAt, startsAt];
  const { n } = db.prepare(query).get(...params);
  if (n >= config.limits.maxConcurrentMeetings) {
    throw new HttpError(409, `Limite de ${config.limits.maxConcurrentMeetings} réunions simultanées atteinte sur ce créneau`);
  }
}

function assertUniqueExternalIds(organizers, participants) {
  const ids = [...organizers, ...participants].map((person) => person.external_id);
  if (new Set(ids).size !== ids.length) {
    throw new HttpError(422, 'Les identifiants externes doivent être uniques dans une réunion');
  }
}

function requestClientId(req) {
  const raw = String(req.get('x-client-id') || '').trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(raw)) {
    throw new HttpError(422, 'En-tête x-client-id invalide');
  }
  return raw;
}

function linksForMeeting(meetingId) {
  const rows = db.prepare('SELECT * FROM access_tokens WHERE meeting_id=? ORDER BY created_at ASC').all(meetingId);
  return {
    count: rows.length,
    organizers: rows.filter((row) => row.role === 'organizer').length,
    participants: rows.filter((row) => row.role === 'participant' && row.kind === 'named').length,
    generic: rows.some((row) => row.kind === 'generic'),
  };
}

router.post('/api/v1/meetings', asyncHandler(async (req, res) => {
  const input = parseZod(createSchema, req.body);
  const early = input.early_join_minutes ?? 0;
  const { start, end } = validateWindow(input.starts_at, input.ends_at, early);
  assertUniqueExternalIds(input.organizers, input.participants);
  assertCapacity(start.toISOString(), end.toISOString());

  const id = randomId(16);
  const room = `pm${randomId(12)}`;
  const createdAt = nowIso();
  const clientId = requestClientId(req);
  const recording = input.recording ?? false;
  const transcription = input.transcription ?? recording;
  const chat = input.chat ?? true;
  const publicAccess = input.public_access ?? false;
  const waitingRoom = input.waiting_room ?? false;
  assertRecordingCapacity(start.toISOString(), end.toISOString(), recording);

  const result = tx(() => {
    db.prepare(`
      INSERT INTO meetings (id, room, title, starts_at, ends_at, early_join_minutes, status,
        recording, transcription, chat, public_access, waiting_room, client_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, room, input.title, start.toISOString(), end.toISOString(), early,
      recording ? 1 : 0, transcription ? 1 : 0, chat ? 1 : 0,
      publicAccess ? 1 : 0, waitingRoom ? 1 : 0, clientId, createdAt);

    const organizers = input.organizers.map((person) => {
      const token = createAccessToken(id, 'organizer', 'named', person.display_name, person.external_id);
      return { ...person, token: token.raw };
    });
    const participants = input.participants.map((person) => {
      const token = createAccessToken(id, 'participant', 'named', person.display_name, person.external_id);
      return { ...person, token: token.raw };
    });
    let generic = null;
    if (input.generic_participant) {
      const token = createAccessToken(id, 'participant', 'generic', null, null);
      generic = { token: token.raw };
    }
    return { organizers, participants, generic };
  });

  const meeting = getMeeting(id);
  emit('meeting.created', id, { starts_at: meeting.starts_at, ends_at: meeting.ends_at });
  return res.status(201).json({
    meeting: { ...meetingJson(meeting), links: linksForMeeting(id) },
    links: {
      organizers: result.organizers,
      participants: result.participants,
      generic_participant: result.generic,
    },
  });
}));

router.get('/api/v1/meetings', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const clientId = typeof req.query.client_id === 'string' && req.query.client_id ? req.query.client_id.slice(0, 128) : null;
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  const filters = [];
  const params = [];
  if (status) {
    filters.push('status=?');
    params.push(status);
  }
  if (clientId) {
    filters.push('client_id=?');
    params.push(clientId);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM meetings ${where} ORDER BY starts_at DESC LIMIT ?`).all(...params, limit);
  res.json({
    meetings: rows.map((meeting) => ({
      ...meetingJson(meeting),
      links: linksForMeeting(meeting.id),
      active_sessions: db.prepare(`
        SELECT COUNT(*) AS n FROM sessions WHERE meeting_id=? AND joined_at IS NOT NULL AND left_at IS NULL
      `).get(meeting.id).n,
    })),
  });
});

router.get('/api/v1/meetings/:id', (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  res.json({
    meeting: {
      ...meetingJson(meeting),
      links: linksForMeeting(meeting.id),
      active_sessions: db.prepare(`
        SELECT COUNT(*) AS n FROM sessions WHERE meeting_id=? AND joined_at IS NOT NULL AND left_at IS NULL
      `).get(meeting.id).n,
      state: meetingState(meeting),
    },
  });
});

router.patch('/api/v1/meetings/:id', (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  const input = parseZod(patchSchema, req.body);
  if (meeting.status !== 'scheduled' || meeting.started_at) {
    const allowed = Object.keys(input).every((key) => ['waiting_room', 'public_access', 'chat'].includes(key));
    if (!allowed || !['scheduled', 'in_progress'].includes(meeting.status)) {
      throw new HttpError(409, "La réunion a déjà commencé : seuls le chat et les réglages d'accès peuvent encore changer");
    }
    const waitingRoom = input.waiting_room ?? Boolean(meeting.waiting_room);
    const publicAccess = input.public_access ?? Boolean(meeting.public_access);
    const chat = input.chat ?? Boolean(meeting.chat);
    db.prepare('UPDATE meetings SET waiting_room=?, public_access=?, chat=? WHERE id=?')
      .run(waitingRoom ? 1 : 0, publicAccess ? 1 : 0, chat ? 1 : 0, meeting.id);
    let admitted = [];
    if (!waitingRoom) {
      admitted = admitWaitingSessions(meeting.id, { all: true });
    }
    const updated = getMeeting(meeting.id);
    emit('meeting.updated', meeting.id, {
      waiting_room: Boolean(updated.waiting_room),
      public_access: Boolean(updated.public_access),
      chat: Boolean(updated.chat),
    });
    for (const sessionId of admitted) {
      emit('admission.updated', meeting.id, { session_id: sessionId, status: 'admitted' });
    }
    if (admitted.length) emit('waiting.updated', meeting.id, { action: 'admitted_all', count: admitted.length });
    return res.json({ meeting: meetingJson(updated) });
  }
  const startsAt = input.starts_at ?? meeting.starts_at;
  const endsAt = input.ends_at ?? meeting.ends_at;
  const early = input.early_join_minutes ?? meeting.early_join_minutes;
  const { start, end } = validateWindow(startsAt, endsAt, early);
  assertCapacity(start.toISOString(), end.toISOString(), meeting.id);

  const title = input.title ?? meeting.title;
  const recording = input.recording ?? Boolean(meeting.recording);
  const transcription = input.transcription ?? Boolean(meeting.transcription);
  const chat = input.chat ?? Boolean(meeting.chat);
  const publicAccess = input.public_access ?? Boolean(meeting.public_access);
  const waitingRoom = input.waiting_room ?? Boolean(meeting.waiting_room);
  assertRecordingCapacity(start.toISOString(), end.toISOString(), recording, meeting.id);
  db.prepare(`
    UPDATE meetings SET title=?, starts_at=?, ends_at=?, early_join_minutes=?, recording=?, transcription=?, chat=?, public_access=?, waiting_room=?
    WHERE id=? AND status='scheduled' AND started_at IS NULL
  `).run(title, start.toISOString(), end.toISOString(), early, recording ? 1 : 0, transcription ? 1 : 0, chat ? 1 : 0, publicAccess ? 1 : 0, waitingRoom ? 1 : 0, meeting.id);
  let admitted = [];
  if (!waitingRoom) {
    admitted = admitWaitingSessions(meeting.id, { all: true });
  }
  const updated = getMeeting(meeting.id);
  emit('meeting.updated', meeting.id, {
    starts_at: updated.starts_at,
    ends_at: updated.ends_at,
    chat: Boolean(updated.chat),
    waiting_room: Boolean(updated.waiting_room),
  });
  for (const sessionId of admitted) {
    emit('admission.updated', meeting.id, { session_id: sessionId, status: 'admitted' });
  }
  res.json({ meeting: meetingJson(updated) });
});

router.post('/api/v1/meetings/:id/cancel', (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  if (meeting.status === 'cancelled') return res.json({ meeting: meetingJson(meeting) });
  if (meeting.status !== 'scheduled' || meeting.started_at) {
    throw new HttpError(409, "Impossible d'annuler une réunion déjà commencée");
  }
  const joined = db.prepare(`
    SELECT COUNT(*) AS n FROM sessions WHERE meeting_id=? AND joined_at IS NOT NULL
  `).get(meeting.id).n;
  if (joined > 0) throw new HttpError(409, 'Des participants ont déjà rejoint la réunion');
  db.prepare("UPDATE meetings SET status='cancelled', cancelled_at=? WHERE id=? AND status='scheduled'")
    .run(nowIso(), meeting.id);
  const updated = getMeeting(meeting.id);
  emit('meeting.cancelled', meeting.id, { cancelled_at: updated.cancelled_at });
  res.json({ meeting: meetingJson(updated) });
});

router.post('/api/v1/meetings/:id/end', asyncHandler(async (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  if (meeting.status === 'cancelled') throw new HttpError(409, 'Réunion annulée');
  if (meeting.status === 'ended') return res.json({ meeting: meetingJson(meeting) });
  await finalizeMeeting(meeting.id, 'api_end');
  res.json({ meeting: meetingJson(getMeeting(meeting.id)) });
}));

router.post('/api/v1/meetings/:id/links', (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  if (meeting.status !== 'scheduled' || meeting.started_at) {
    throw new HttpError(409, 'Les liens ne peuvent plus être créés après le début de la réunion');
  }
  const schema = z.object({
    role: z.enum(['organizer', 'participant']),
    kind: z.enum(['named', 'generic']).optional().default('named'),
    display_name: z.string().trim().min(2).max(80).optional(),
    external_id: z.string().trim().min(1).max(128).optional(),
  }).strict();
  const input = parseZod(schema, req.body);
  if (input.kind === 'generic' && input.role !== 'participant') {
    throw new HttpError(422, 'Seuls les participants peuvent avoir un lien générique');
  }
  if (input.kind === 'generic' && db.prepare(
    "SELECT 1 FROM access_tokens WHERE meeting_id=? AND kind='generic'",
  ).get(meeting.id)) {
    throw new HttpError(409, 'Un lien participant générique existe déjà');
  }
  if (input.kind === 'named' && (!input.display_name || !input.external_id)) {
    throw new HttpError(422, 'display_name et external_id sont requis pour un lien nominatif');
  }
  if (input.role === 'participant') {
    const named = db.prepare(`
      SELECT COUNT(*) AS n FROM access_tokens WHERE meeting_id=? AND role='participant' AND kind='named'
    `).get(meeting.id).n;
    if (named >= config.limits.maxParticipants) {
      throw new HttpError(409, 'Nombre maximal de participants nominatifs atteint');
    }
  }
  const token = createAccessToken(meeting.id, input.role, input.kind,
    input.display_name || null, input.external_id || null);
  res.status(201).json({
    link: {
      role: input.role,
      kind: input.kind,
      display_name: input.display_name || null,
      external_id: input.external_id || null,
      token: token.raw,
    },
  });
});

router.get('/api/v1/meetings/:id/waiting', (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  const waiting = waitingSessions(meeting.id);
  res.json({
    meeting_id: meeting.id,
    waiting_room: Boolean(meeting.waiting_room),
    organizer_present: activeOrganizerCount(meeting.id) > 0,
    waiting: waiting.map((session) => ({
      session_id: session.id,
      display_name: session.display_name,
      external_id: session.external_id,
      waiting_since: session.created_at,
    })),
  });
});

router.post('/api/v1/meetings/:id/waiting/admit', (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  if (activeOrganizerCount(meeting.id) === 0) {
    throw new HttpError(409, "Aucun organisateur présent dans la réunion");
  }
  const schema = z.object({
    all: z.boolean().optional().default(false),
    session_ids: z.array(z.string().min(1).max(64)).max(100).optional().default([]),
  }).strict();
  const input = parseZod(schema, req.body);
  if (!input.all && input.session_ids.length === 0) {
    throw new HttpError(422, 'Sélectionnez au moins un participant');
  }
  const ids = admitWaitingSessions(meeting.id, { all: input.all, sessionIds: input.session_ids });
  for (const sessionId of ids) {
    emit('admission.updated', meeting.id, { session_id: sessionId, status: 'admitted' });
  }
  if (ids.length) emit('waiting.updated', meeting.id, { action: input.all ? 'admitted_all' : 'admitted', count: ids.length });
  res.json({ admitted: ids.length, session_ids: ids });
});

router.get('/api/v1/meetings/:id/attendance', (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  res.json(attendanceReport(meeting.id));
});

router.get('/api/v1/meetings/:id/chat', (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  res.set('Cache-Control', 'no-store');
  res.json(chatReport(meeting.id));
});

router.get('/api/v1/meetings/:id/artifacts', (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  const rows = db.prepare('SELECT * FROM artifacts WHERE meeting_id=? AND status=? ORDER BY created_at ASC')
    .all(meeting.id, 'ready');
  res.json({ artifacts: rows.map(artifactJson) });
});

router.get('/api/v1/meetings/:id/webhooks', (req, res) => {
  const rows = db.prepare('SELECT * FROM webhook_deliveries WHERE meeting_id=? ORDER BY created_at DESC LIMIT 200')
    .all(req.params.id);
  res.json({
    deliveries: rows.map((row) => ({
      id: row.id,
      event: row.event,
      status: row.status,
      attempts: row.attempts,
      response_code: row.response_code,
      error: row.error,
      created_at: row.created_at,
      delivered_at: row.delivered_at,
    })),
  });
});

router.get('/api/v1/meetings/:id/processing', (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  const job = db.prepare('SELECT * FROM transcription_jobs WHERE meeting_id=?').get(meeting.id) || null;
  const uploads = db.prepare(`
    SELECT * FROM recording_uploads WHERE meeting_id=? ORDER BY created_at ASC
  `).all(meeting.id);
  res.set('Cache-Control', 'no-store');
  res.json({
    meeting_id: meeting.id,
    meeting_status: meeting.status,
    recording: {
      enabled: Boolean(meeting.recording),
      state: meeting.recording_state || 'idle',
      error: meeting.recording_error || null,
      started_at: meeting.recording_started_at || null,
      last_attempt_at: meeting.recording_last_attempt_at || null,
      uploads: uploads.map((upload) => ({
        file_name: upload.file_name,
        status: upload.status,
        attempts: upload.attempts,
        error: upload.error,
        updated_at: upload.updated_at,
      })),
    },
    transcription: job ? {
      enabled: Boolean(meeting.transcription),
      status: job.status,
      attempts: job.attempts,
      error: job.error,
      available_at: job.available_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
    } : {
      enabled: Boolean(meeting.transcription),
      status: meeting.transcription ? 'not_queued' : 'disabled',
    },
  });
});

router.post('/api/v1/meetings/:id/processing/retry', asyncHandler(async (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  const schema = z.object({
    kind: z.enum(['recording', 'transcription', 'all']).optional().default('all'),
  }).strict();
  const input = parseZod(schema, req.body || {});
  const retried = [];
  const now = nowIso();

  if (['recording', 'all'].includes(input.kind) && meeting.recording) {
    const uploads = db.prepare(`
      UPDATE recording_uploads SET status='pending', error=NULL, updated_at=?
      WHERE meeting_id=? AND status='failed'
    `).run(now, meeting.id);
    if (uploads.changes > 0) retried.push('recording_uploads');
    if (['scheduled', 'in_progress'].includes(meeting.status) && meeting.recording_state === 'failed') {
      db.prepare(`
        UPDATE meetings SET recording_state='idle', recording_error=NULL, recording_last_attempt_at=NULL WHERE id=?
      `).run(meeting.id);
      retried.push('recording_start');
    }
    await scanRecordings();
  }

  if (['transcription', 'all'].includes(input.kind) && meeting.transcription) {
    const job = db.prepare('SELECT * FROM transcription_jobs WHERE meeting_id=?').get(meeting.id);
    if (job) {
      if (job.status !== 'completed') {
        db.prepare(`
          UPDATE transcription_jobs
          SET status='pending', available_at=?, attempts=0, error=NULL, started_at=NULL,
              heartbeat_at=NULL, completed_at=NULL
          WHERE id=?
        `).run(now, job.id);
        retried.push('transcription');
      }
    } else {
      db.prepare(`
        INSERT INTO transcription_jobs (id, meeting_id, status, available_at, created_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(randomId(12), meeting.id, now, now);
      retried.push('transcription');
    }
  }

  emit('processing.updated', meeting.id, { retried, kind: input.kind });
  res.json({ retried, processing: { meeting_id: meeting.id }, requested_at: now });
}));

router.get('/api/v1/artifacts/:id', (req, res) => {
  const artifact = db.prepare('SELECT * FROM artifacts WHERE id=?').get(req.params.id);
  if (!artifact) throw new HttpError(404, 'Artefact introuvable');
  res.json({ artifact: artifactJson(artifact) });
});

router.get('/api/v1/artifacts/:id/url', asyncHandler(async (req, res) => {
  const artifact = db.prepare('SELECT * FROM artifacts WHERE id=?').get(req.params.id);
  if (!artifact) throw new HttpError(404, 'Artefact introuvable');
  if (artifact.status !== 'ready') throw new HttpError(410, 'Artefact supprimé');
  const url = await s3.presignGet(artifact.s3_key, artifact.filename);
  res.set('Cache-Control', 'no-store');
  const expiresAt = new Date(Date.now() + config.s3.presignTtlSeconds * 1000).toISOString();
  res.json({
    url,
    expires_at: expiresAt,
    expires_in_seconds: config.s3.presignTtlSeconds,
  });
}));

router.get('/api/v1/artifacts/:id/download', asyncHandler(async (req, res) => {
  const artifact = db.prepare('SELECT * FROM artifacts WHERE id=?').get(req.params.id);
  if (!artifact) throw new HttpError(404, 'Artefact introuvable');
  if (artifact.status !== 'ready') throw new HttpError(410, 'Artefact supprimé');
  const url = await s3.presignGet(artifact.s3_key, artifact.filename);
  res.redirect(302, url);
}));

router.delete('/api/v1/artifacts/:id', asyncHandler(async (req, res) => {
  const artifact = db.prepare('SELECT * FROM artifacts WHERE id=?').get(req.params.id);
  if (!artifact) throw new HttpError(404, 'Artefact introuvable');
  if (artifact.status !== 'ready') throw new HttpError(410, 'Artefact déjà supprimé');
  await s3.deleteObject(artifact.s3_key);
  if (artifact.type === 'recording') {
    const localCopy = path.join(config.recordingsDir, path.basename(artifact.filename));
    try {
      fs.rmSync(localCopy, { force: true });
    } catch {
      // La copie locale a peut-être déjà été nettoyée.
    }
  }
  const deletedAt = nowIso();
  // Suppression définitive : l'objet S3 et la ligne de métadonnées disparaissent.
  db.prepare('DELETE FROM artifacts WHERE id=?').run(artifact.id);
  emit('artifact.deleted', artifact.meeting_id, { artifact_id: artifact.id, type: artifact.type });
  res.json({ deleted: true, id: artifact.id, deleted_at: deletedAt });
}));

// ---------------------------------------------------------------------------
// Endpoints internes destinés au worker de transcription
// ---------------------------------------------------------------------------

router.get('/internal/jobs/next', (req, res) => {
  const now = nowIso();
  db.prepare(`
    UPDATE transcription_jobs SET status='pending', started_at=NULL, heartbeat_at=NULL
    WHERE status='processing' AND COALESCE(heartbeat_at, started_at) < ?
  `).run(new Date(Date.now() - 5 * 60_000).toISOString());
  const job = db.prepare(`
    SELECT j.*, m.title, m.starts_at, m.ends_at, m.room
    FROM transcription_jobs j JOIN meetings m ON m.id=j.meeting_id
    WHERE j.status='pending' AND j.available_at <= ?
    ORDER BY j.available_at ASC LIMIT 1
  `).get(now);
  if (!job) return res.status(204).send();
  db.prepare(`
    UPDATE transcription_jobs SET status='processing', started_at=?, heartbeat_at=?, attempts=attempts+1 WHERE id=?
  `).run(now, now, job.id);
  const captures = db.prepare('SELECT * FROM captures WHERE meeting_id=? ORDER BY started_at ASC')
    .all(job.meeting_id);
  return res.json({
    job: {
      id: job.id,
      meeting_id: job.meeting_id,
      title: job.title,
      starts_at: job.starts_at,
      ends_at: job.ends_at,
      language: 'fr',
    },
    captures: captures.map((capture) => ({
      session_id: capture.session_id,
      display_name: capture.display_name,
      external_id: capture.external_id,
      role: capture.role,
      file_path: capture.file_path,
      mime: capture.mime,
      started_at: capture.started_at,
      bytes: capture.bytes,
      chunks: capture.chunks,
      complete: Boolean(capture.complete),
      mute_intervals: safeJson(capture.mute_intervals),
    })),
  });
});

router.post('/internal/jobs/:id/heartbeat', (req, res) => {
  const result = db.prepare(`
    UPDATE transcription_jobs SET heartbeat_at=? WHERE id=? AND status='processing'
  `).run(nowIso(), req.params.id);
  if (result.changes === 0) throw new HttpError(409, 'Job non actif');
  res.json({ ok: true });
});

router.post('/internal/jobs/:id/complete', (req, res) => {
  const job = db.prepare('SELECT * FROM transcription_jobs WHERE id=?').get(req.params.id);
  if (!job) throw new HttpError(404, 'Job introuvable');
  if (!['pending', 'processing'].includes(job.status)) throw new HttpError(409, 'Job déjà terminé');
  const schema = z.object({
    language: z.string().min(2).max(10).optional().default('fr'),
    segments: z.number().int().min(0).optional().default(0),
    artifacts: z.array(z.object({
      type: z.enum(['transcript_json', 'transcript_txt', 'transcript_srt', 'transcript_vtt']),
      filename: z.string().min(1).max(200),
      s3_key: z.string().min(1).max(500),
      mime: z.string().min(1).max(120),
      size: z.number().int().min(0),
      metadata: z.record(z.any()).optional().default({}),
    })).min(1).max(8),
  }).strict();
  const input = parseZod(schema, req.body);
  const meeting = getMeeting(job.meeting_id);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  const artifacts = input.artifacts.map((artifact) => insertArtifact({
    meetingId: job.meeting_id,
    type: artifact.type,
    filename: artifact.filename,
    key: artifact.s3_key,
    mime: artifact.mime,
    size: artifact.size,
    metadata: { ...artifact.metadata, language: input.language, segments: input.segments, source: 'participant_audio' },
  }));
  db.prepare(`
    UPDATE transcription_jobs SET status='completed', completed_at=?, error=NULL WHERE id=?
  `).run(nowIso(), job.id);
  // Les captures audio brutes ne sont plus nécessaires une fois la transcription produite.
  const captures = db.prepare('SELECT * FROM captures WHERE meeting_id=?').all(job.meeting_id);
  for (const capture of captures) {
    try {
      fs.rmSync(path.join(config.capturesDir, capture.file_path), { force: true });
    } catch {
      // Le fichier a peut-être déjà été supprimé par le worker.
    }
  }
  db.prepare('DELETE FROM captures WHERE meeting_id=?').run(job.meeting_id);
  emit('transcript.ready', job.meeting_id, {
    language: input.language,
    segments: input.segments,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id, type: artifact.type, filename: artifact.filename, size: artifact.size,
    })),
  });
  emit('processing.updated', job.meeting_id, { kind: 'transcription', status: 'completed' });
  res.json({ ok: true, artifacts: artifacts.map(artifactJson) });
});

router.post('/internal/jobs/:id/fail', (req, res) => {
  const job = db.prepare('SELECT * FROM transcription_jobs WHERE id=?').get(req.params.id);
  if (!job) throw new HttpError(404, 'Job introuvable');
  if (job.status === 'completed') throw new HttpError(409, 'Job déjà terminé');
  const message = String(req.body?.error || 'Erreur inconnue').slice(0, 2000);
  db.prepare("UPDATE transcription_jobs SET status='failed', completed_at=?, error=? WHERE id=?")
    .run(nowIso(), message, job.id);
  emit('transcript.failed', job.meeting_id, { error: message });
  emit('processing.updated', job.meeting_id, { kind: 'transcription', status: 'failed', error: message });
  res.json({ ok: true });
});

module.exports = { router };
