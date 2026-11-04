'use strict';

const config = require('./config');
const { db } = require('./db');
const {
  HttpError,
  randomId,
  randomToken,
  sha256,
  nowIso,
  addMinutes,
  durationSeconds,
  iso,
} = require('./util');

function getMeeting(id) {
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
}

function opensAt(meeting) {
  return new Date(new Date(meeting.starts_at).getTime() - meeting.early_join_minutes * 60_000).toISOString();
}

function meetingState(meeting, at = new Date()) {
  const now = at instanceof Date ? at : new Date(at);
  const opens = new Date(opensAt(meeting));
  const starts = new Date(meeting.starts_at);
  const ends = new Date(meeting.ends_at);
  let phase = 'open';
  if (meeting.status === 'cancelled') phase = 'cancelled';
  else if (meeting.status === 'ended') phase = 'ended';
  else if (now >= ends) phase = 'ended';
  else if (now < opens) phase = 'waiting';
  return {
    phase,
    status: meeting.status,
    now: now.toISOString(),
    opens_at: opens.toISOString(),
    starts_at: starts.toISOString(),
    ends_at: ends.toISOString(),
    can_join: phase === 'open',
    seconds_until_open: Math.max(0, Math.round((opens.getTime() - now.getTime()) / 1000)),
    seconds_until_end: Math.max(0, Math.round((ends.getTime() - now.getTime()) / 1000)),
  };
}

function resolveAccessToken(rawToken) {
  const tokenHash = sha256(rawToken);
  return db.prepare(`
    SELECT t.*, m.id AS meeting_id, m.title, m.room, m.starts_at, m.ends_at,
           m.early_join_minutes, m.status, m.recording, m.transcription, m.chat,
           m.public_access, m.waiting_room, m.recording_state, m.recording_error,
           m.client_id, m.created_at AS meeting_created_at, m.started_at, m.ended_at, m.cancelled_at
    FROM access_tokens t JOIN meetings m ON m.id = t.meeting_id
    WHERE t.token_hash = ?
  `).get(tokenHash);
}

function sessionCookieName(meetingId) {
  return `pms_${meetingId}`;
}

function identityCookieName(tokenHash) {
  return `pmi_${tokenHash.slice(0, 24)}`;
}

function findReusableSession(cookieValue, meetingId, tokenId) {
  if (!cookieValue) return null;
  const session = db.prepare(`
    SELECT s.*, m.ends_at FROM sessions s JOIN meetings m ON m.id = s.meeting_id
    WHERE s.session_token_hash = ? AND s.meeting_id = ? AND s.token_id = ? AND s.left_at IS NULL
  `).get(sha256(cookieValue), meetingId, tokenId);
  return session || null;
}

function createSession({ meetingId, tokenId, role, displayName, externalId, userAgent, admissionStatus = 'admitted' }) {
  const id = randomId(16);
  const sessionToken = randomToken(32);
  const admittedAt = admissionStatus === 'admitted' ? nowIso() : null;
  db.prepare(`
    INSERT INTO sessions (id, meeting_id, token_id, role, display_name, external_id,
      session_token_hash, created_at, last_seen_at, user_agent, admission_status, admitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, meetingId, tokenId, role, displayName, externalId || null,
    sha256(sessionToken), nowIso(), nowIso(), String(userAgent || '').slice(0, 300),
    admissionStatus, admittedAt);
  return {
    id,
    sessionToken,
    meeting_id: meetingId,
    token_id: tokenId,
    role,
    display_name: displayName,
    external_id: externalId || null,
    admission_status: admissionStatus,
    media_audio_allowed: 1,
    media_video_allowed: 1,
    media_screen_allowed: 1,
  };
}

function activeParticipantCount(meetingId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM sessions
    WHERE meeting_id = ? AND joined_at IS NOT NULL AND left_at IS NULL
  `).get(meetingId).n;
}

function markJoined(session) {
  const meeting = getMeeting(session.meeting_id);
  const at = nowIso();
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  const state = meetingState(meeting);
  if (state.phase !== 'open') throw new HttpError(410, 'Le créneau est fermé');
  const fresh = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  if (fresh.left_at) throw new HttpError(410, 'Session terminée');
  if (fresh.admission_status !== 'admitted') throw new HttpError(403, "En attente d'admission");
  if (fresh.joined_at) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, session.id);
    return { joined: false, meeting, state };
  }
  if (activeParticipantCount(meeting.id) >= config.limits.maxParticipants) {
    throw new HttpError(409, 'Réunion complète (30 participants maximum)');
  }
  db.prepare('UPDATE sessions SET joined_at = ?, last_seen_at = ? WHERE id = ?').run(at, at, session.id);
  db.prepare(`
    INSERT INTO attendance_events (meeting_id, session_id, type, display_name, external_id, role, at)
    VALUES (?, ?, 'joined', ?, ?, ?, ?)
  `).run(meeting.id, session.id, fresh.display_name, fresh.external_id, fresh.role, at);
  let started = false;
  if (meeting.status === 'scheduled') {
    const result = db.prepare(`
      UPDATE meetings SET status='in_progress', started_at=? WHERE id=? AND status='scheduled'
    `).run(at, meeting.id);
    started = result.changes > 0;
  }
  return { joined: true, started, meeting: getMeeting(meeting.id), state };
}

function markLeft(sessionId, reason = 'left') {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session || session.left_at) return false;
  const at = nowIso();
  db.prepare('UPDATE sessions SET left_at = ?, last_seen_at = ? WHERE id = ?').run(at, at, sessionId);
  if (session.joined_at) {
    db.prepare(`
      INSERT INTO attendance_events (meeting_id, session_id, type, display_name, external_id, role, at)
      VALUES (?, ?, 'left', ?, ?, ?, ?)
    `).run(session.meeting_id, session.id, session.display_name, session.external_id, session.role, at);
  }
  return true;
}

function closeAllSessions(meetingId, at) {
  const open = db.prepare(`
    SELECT * FROM sessions WHERE meeting_id = ? AND left_at IS NULL
  `).all(meetingId);
  const update = db.prepare('UPDATE sessions SET left_at = ?, last_seen_at = ? WHERE id = ? AND left_at IS NULL');
  const event = db.prepare(`
    INSERT INTO attendance_events (meeting_id, session_id, type, display_name, external_id, role, at)
    VALUES (?, ?, 'left', ?, ?, ?, ?)
  `);
  for (const session of open) {
    update.run(at, at, session.id);
    if (session.joined_at) {
      event.run(meetingId, session.id, session.display_name, session.external_id, session.role, at);
    }
  }
  return open.length;
}

function attendanceReport(meetingId) {
  const meeting = getMeeting(meetingId);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  const sessions = db.prepare(`
    SELECT * FROM sessions WHERE meeting_id = ? AND joined_at IS NOT NULL ORDER BY joined_at ASC
  `).all(meetingId);
  const cap = Math.min(Date.now(), new Date(meeting.ends_at).getTime());
  const grouped = new Map();
  const organizerNames = new Map();
  for (const session of sessions) {
    if (session.role === 'organizer' && session.external_id) {
      organizerNames.set(session.external_id, session.display_name);
    }
    const key = session.external_id
      ? `id:${session.external_id}`
      : `name:${session.role}|${session.display_name}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        display_name: session.display_name,
        external_id: session.external_id,
        role: session.role,
        total_seconds: 0,
        sessions: [],
      });
    }
    const left = session.left_at ? new Date(session.left_at).getTime() : cap;
    const seconds = Math.max(0, Math.round((left - new Date(session.joined_at).getTime()) / 1000));
    const item = grouped.get(key);
    item.total_seconds += seconds;
    item.sessions.push({
      joined_at: session.joined_at,
      left_at: session.left_at,
      role: session.role,
      duration_seconds: seconds,
    });
  }
  for (const item of grouped.values()) {
    if (item.external_id && organizerNames.has(item.external_id)) {
      item.role = 'organizer';
      item.display_name = organizerNames.get(item.external_id);
    }
  }
  const events = db.prepare(`
    SELECT type, display_name, external_id, role, at FROM attendance_events
    WHERE meeting_id = ? ORDER BY at ASC, id ASC
  `).all(meetingId).map((event) => {
    if (event.external_id && organizerNames.has(event.external_id)) {
      return { ...event, role: 'organizer', display_name: organizerNames.get(event.external_id) };
    }
    return event;
  });
  return {
    meeting_id: meetingId,
    generated_at: nowIso(),
    participants: [...grouped.values()].sort((a, b) => b.total_seconds - a.total_seconds),
    entries: events,
  };
}

function chatReport(meetingId) {
  const meeting = getMeeting(meetingId);
  if (!meeting) throw new HttpError(404, 'Réunion introuvable');
  const messages = db.prepare(`
    SELECT id, author_name, external_id, role, text, created_at
    FROM chat_messages WHERE meeting_id = ? ORDER BY created_at ASC, id ASC
  `).all(meetingId).map((message) => ({
    id: message.id,
    author: {
      display_name: message.author_name,
      external_id: message.external_id,
      role: message.role,
    },
    timestamp: message.created_at,
    message: message.text,
  }));
  return { meeting_id: meetingId, generated_at: nowIso(), messages };
}

function meetingJson(meeting) {
  return {
    id: meeting.id,
    title: meeting.title,
    room: meeting.room,
    starts_at: meeting.starts_at,
    ends_at: meeting.ends_at,
    early_join_minutes: meeting.early_join_minutes,
    opens_at: opensAt(meeting),
    duration_minutes: Math.round(durationSeconds(meeting.starts_at, meeting.ends_at) / 60),
    status: meeting.status,
    recording: Boolean(meeting.recording),
    transcription: Boolean(meeting.transcription),
    chat: Boolean(meeting.chat),
    public_access: Boolean(meeting.public_access),
    waiting_room: Boolean(meeting.waiting_room),
    recording_state: meeting.recording_state || 'idle',
    recording_error: meeting.recording_error || null,
    client_id: meeting.client_id || null,
    created_at: meeting.created_at,
    started_at: meeting.started_at || null,
    ended_at: meeting.ended_at || null,
    cancelled_at: meeting.cancelled_at || null,
  };
}

function createAccessToken(meetingId, role, kind, displayName, externalId) {
  const raw = randomToken(32);
  const id = randomId(16);
  db.prepare(`
    INSERT INTO access_tokens (id, meeting_id, role, kind, display_name, external_id, token_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, meetingId, role, kind, displayName || null, externalId || null, sha256(raw), nowIso());
  return { id, raw };
}

function artifactJson(artifact) {
  return {
    id: artifact.id,
    meeting_id: artifact.meeting_id,
    type: artifact.type,
    filename: artifact.filename,
    mime: artifact.mime,
    size: artifact.size,
    status: artifact.status,
    metadata: safeJson(artifact.metadata),
    created_at: artifact.created_at,
    deleted_at: artifact.deleted_at || null,
    download_url: artifact.status === 'ready'
      ? `${config.appBaseUrl}/api/v1/artifacts/${artifact.id}/download`
      : null,
  };
}

function safeJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function activeOrganizerCount(meetingId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM sessions
    WHERE meeting_id=? AND role='organizer' AND joined_at IS NOT NULL AND left_at IS NULL
      AND admission_status='admitted'
  `).get(meetingId).n;
}

function waitingSessions(meetingId) {
  return db.prepare(`
    SELECT id, display_name, external_id, created_at
    FROM sessions
    WHERE meeting_id=? AND role='participant' AND admission_status='waiting' AND left_at IS NULL
    ORDER BY created_at ASC
  `).all(meetingId);
}

function admitWaitingSessions(meetingId, { all = false, sessionIds = [] } = {}) {
  const now = nowIso();
  const ids = [];
  if (all) {
    const rows = db.prepare(`
      SELECT id FROM sessions WHERE meeting_id=? AND admission_status='waiting' AND left_at IS NULL
    `).all(meetingId);
    if (rows.length) {
      db.prepare(`
        UPDATE sessions SET admission_status='admitted', admitted_at=?
        WHERE meeting_id=? AND admission_status='waiting' AND left_at IS NULL
      `).run(now, meetingId);
      ids.push(...rows.map((row) => row.id));
    }
    return ids;
  }
  const update = db.prepare(`
    UPDATE sessions SET admission_status='admitted', admitted_at=?
    WHERE id=? AND meeting_id=? AND admission_status='waiting' AND left_at IS NULL
  `);
  for (const id of sessionIds) {
    const result = update.run(now, id, meetingId);
    if (result.changes > 0) ids.push(id);
  }
  return ids;
}

function rejectWaitingSession(meetingId, sessionId) {
  const session = db.prepare(`
    SELECT * FROM sessions WHERE id=? AND meeting_id=? AND role='participant'
      AND admission_status='waiting' AND left_at IS NULL
  `).get(sessionId, meetingId);
  if (!session) return null;
  const at = nowIso();
  db.prepare(`
    UPDATE sessions SET admission_status='rejected', left_at=?, last_seen_at=?
    WHERE id=? AND admission_status='waiting' AND left_at IS NULL
  `).run(at, at, sessionId);
  return session;
}

function closeParticipantSessionsForIdentity(meetingId, externalId) {
  if (!externalId) return 0;
  const at = nowIso();
  const rows = db.prepare(`
    SELECT * FROM sessions
    WHERE meeting_id=? AND external_id=? AND role='participant' AND left_at IS NULL
  `).all(meetingId, externalId);
  for (const session of rows) {
    db.prepare('UPDATE sessions SET left_at=?, last_seen_at=? WHERE id=?').run(at, at, session.id);
    if (session.joined_at) {
      db.prepare(`
        INSERT INTO attendance_events (meeting_id, session_id, type, display_name, external_id, role, at)
        VALUES (?, ?, 'left', ?, ?, ?, ?)
      `).run(meetingId, session.id, session.display_name, session.external_id, session.role, at);
    }
  }
  return rows;
}

module.exports = {
  getMeeting,
  opensAt,
  meetingState,
  resolveAccessToken,
  sessionCookieName,
  identityCookieName,
  findReusableSession,
  createSession,
  activeParticipantCount,
  activeOrganizerCount,
  waitingSessions,
  admitWaitingSessions,
  rejectWaitingSession,
  closeParticipantSessionsForIdentity,
  markJoined,
  markLeft,
  closeAllSessions,
  attendanceReport,
  chatReport,
  meetingJson,
  createAccessToken,
  artifactJson,
  safeJson,
  durationSeconds,
  addMinutes,
  iso,
};
