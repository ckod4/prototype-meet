'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { db } = require('./db');
const { getMeeting, closeAllSessions, attendanceReport, chatReport, safeJson } = require('./meetings');
const { emit } = require('./webhooks');
const s3 = require('./s3');
const { randomId, nowIso } = require('./util');
const log = require('./log');

const finalizing = new Set();
const recordingBusy = new Set();
const recordingStable = new Map();
const recordingKnown = new Set();

function insertArtifact({ meetingId, type, filename, key, mime, size, metadata }) {
  const existing = db.prepare('SELECT * FROM artifacts WHERE s3_key = ?').get(key);
  if (existing) return existing;
  const id = randomId(16);
  db.prepare(`
    INSERT INTO artifacts (id, meeting_id, type, filename, s3_key, mime, size, status, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
  `).run(id, meetingId, type, filename, key, mime, size, JSON.stringify(metadata || {}), nowIso());
  return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
}

async function publishJsonArtifact(meeting, type, filename, payload, metadata) {
  const key = `meetings/${meeting.id}/${type}/${filename}`;
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  const size = await s3.putBuffer(key, body, 'application/json; charset=utf-8');
  const artifact = insertArtifact({
    meetingId: meeting.id,
    type,
    filename,
    key,
    mime: 'application/json',
    size,
    metadata,
  });
  return artifact;
}

async function finalizeMeeting(meetingId, reason = 'api_end') {
  if (finalizing.has(meetingId)) return;
  finalizing.add(meetingId);
  try {
    let meeting = getMeeting(meetingId);
    if (!meeting) return;
    if (meeting.status === 'cancelled') return;
    if (meeting.finalized_at) return;

    let endedAt = meeting.ended_at;
    if (meeting.status !== 'ended') {
      const now = new Date();
      const slotEnd = new Date(meeting.ends_at);
      endedAt = reason === 'slot_end' || now > slotEnd ? slotEnd.toISOString() : now.toISOString();
      const changed = db.prepare(`
        UPDATE meetings SET status='ended', ended_at=? WHERE id=? AND status IN ('scheduled','in_progress')
      `).run(endedAt, meetingId);
      if (changed.changes === 0) return;
      meeting = getMeeting(meetingId);
    } else if (!endedAt) {
      endedAt = nowIso();
      db.prepare('UPDATE meetings SET ended_at=? WHERE id=?').run(endedAt, meetingId);
      meeting = getMeeting(meetingId);
    }

    closeAllSessions(meetingId, endedAt);
    meeting = getMeeting(meetingId);

    let attendanceArtifact = null;
    let chatArtifact = null;
    try {
      const attendance = attendanceReport(meetingId);
      attendanceArtifact = await publishJsonArtifact(
        meeting,
        'attendance',
        'attendance.json',
        attendance,
        { unique_participants: attendance.participants.length, entries: attendance.entries.length },
      );
    } catch (error) {
      log.error('finalize.attendance_failed', { meeting_id: meetingId, error: error.message });
    }
    try {
      const chat = chatReport(meetingId);
      chatArtifact = await publishJsonArtifact(
        meeting,
        'chat',
        'chat.json',
        chat,
        { messages: chat.messages.length },
      );
    } catch (error) {
      log.error('finalize.chat_failed', { meeting_id: meetingId, error: error.message });
    }

    if (meeting.transcription) {
      const availableAt = new Date(new Date(endedAt).getTime() + config.limits.transcriptionGraceSeconds * 1000).toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO transcription_jobs (id, meeting_id, status, available_at, created_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(randomId(12), meetingId, availableAt, nowIso());
    }

    db.prepare('UPDATE meetings SET finalized_at=? WHERE id=?').run(nowIso(), meetingId);
    meeting = getMeeting(meetingId);

    const attendance = attendanceReport(meetingId);
    emit('meeting.ended', meetingId, {
      reason,
      ended_at: meeting.ended_at,
      attendance_summary: {
        unique_participants: attendance.participants.length,
        entries: attendance.entries.length,
      },
      artifacts: [attendanceArtifact, chatArtifact].filter(Boolean).map((a) => ({
        id: a.id, type: a.type, filename: a.filename,
      })),
    });
    if (attendanceArtifact) emit('attendance.ready', meetingId, { artifact_id: attendanceArtifact.id });
    if (chatArtifact) emit('chat.ready', meetingId, { artifact_id: chatArtifact.id });
  } catch (error) {
    log.error('finalize.failed', { meeting_id: meetingId, error: error.stack || error.message });
  } finally {
    finalizing.delete(meetingId);
  }
}

function matchRecording(fileName) {
  const base = path.basename(fileName);
  const meetings = db.prepare('SELECT * FROM meetings').all();
  let match = null;
  for (const meeting of meetings) {
    if (base === `${meeting.room}.mp4` || base.startsWith(`${meeting.room}_`)) {
      if (!match || meeting.room.length > match.room.length) match = meeting;
    }
  }
  return match;
}

async function scanRecordings() {
  try {
    fs.mkdirSync(config.recordingsDir, { recursive: true });
    const entries = fs.readdirSync(config.recordingsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.mp4')) continue;
      const fullPath = path.join(config.recordingsDir, entry.name);
      if (recordingBusy.has(fullPath) || recordingKnown.has(fullPath)) continue;
      const meeting = matchRecording(entry.name);
      if (!meeting) continue;
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      const previous = recordingStable.get(fullPath);
      if (!previous || previous.size !== stat.size) {
        recordingStable.set(fullPath, { size: stat.size, stable: 0 });
        continue;
      }
      previous.stable += 1;
      if (previous.stable < 2 || stat.size === 0) continue;

      const key = `meetings/${meeting.id}/recording/${entry.name}`;
      if (db.prepare('SELECT 1 FROM artifacts WHERE s3_key = ?').get(key)) {
        recordingKnown.add(fullPath);
        db.prepare(`
          UPDATE recording_uploads SET status='completed', error=NULL, updated_at=?
          WHERE meeting_id=? AND file_name=?
        `).run(nowIso(), meeting.id, entry.name);
        continue;
      }
      const upload = db.prepare('SELECT * FROM recording_uploads WHERE meeting_id=? AND file_name=?')
        .get(meeting.id, entry.name);
      if (upload?.status === 'failed'
        && Date.now() - new Date(upload.updated_at).getTime() < 60_000) {
        continue;
      }
      recordingBusy.add(fullPath);
      const attempt = (upload?.attempts || 0) + 1;
      const at = nowIso();
      if (upload) {
        db.prepare(`
          UPDATE recording_uploads SET status='uploading', attempts=?, error=NULL, updated_at=? WHERE id=?
        `).run(attempt, at, upload.id);
      } else {
        db.prepare(`
          INSERT INTO recording_uploads (id, meeting_id, file_name, status, attempts, created_at, updated_at)
          VALUES (?, ?, ?, 'uploading', ?, ?, ?)
        `).run(randomId(12), meeting.id, entry.name, attempt, at, at);
      }
      try {
        const size = await s3.putFile(key, fullPath, 'video/mp4');
        const artifact = insertArtifact({
          meetingId: meeting.id,
          type: 'recording',
          filename: entry.name,
          key,
          mime: 'video/mp4',
          size,
          metadata: { source: 'jibri' },
        });
        recordingKnown.add(fullPath);
        db.prepare(`
          UPDATE recording_uploads SET status='completed', error=NULL, updated_at=?
          WHERE meeting_id=? AND file_name=?
        `).run(nowIso(), meeting.id, entry.name);
        emit('recording.ready', meeting.id, {
          artifact_id: artifact.id,
          filename: artifact.filename,
          size: artifact.size,
        });
        emit('processing.updated', meeting.id, { kind: 'recording', status: 'uploaded', file_name: entry.name });
        log.info('recording.uploaded', { meeting_id: meeting.id, file_name: entry.name, bytes: size });
      } catch (error) {
        db.prepare(`
          UPDATE recording_uploads SET status='failed', error=?, updated_at=?
          WHERE meeting_id=? AND file_name=?
        `).run(String(error.message).slice(0, 500), nowIso(), meeting.id, entry.name);
        emit('processing.updated', meeting.id, {
          kind: 'recording',
          status: 'failed',
          file_name: entry.name,
          error: String(error.message).slice(0, 500),
        });
        log.error('recording.upload_failed', {
          meeting_id: meeting.id,
          file_name: entry.name,
          error: error.message,
        });
      } finally {
        recordingBusy.delete(fullPath);
      }
    }
  } catch (error) {
    log.error('recording.scan_failed', { error: error.message });
  }
}

function recoverInterruptedTranscriptions() {
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const result = db.prepare(`
    UPDATE transcription_jobs
    SET status='pending', started_at=NULL, heartbeat_at=NULL, available_at=?,
        error=COALESCE(error, 'Traitement interrompu, reprise automatique')
    WHERE status='processing' AND COALESCE(heartbeat_at, started_at) < ?
  `).run(nowIso(), cutoff);
  if (result.changes > 0) {
    log.warn('transcription.recovered', { jobs: Number(result.changes) });
  }
}

function startScheduler() {
  const tick = async () => {
    try {
      const due = db.prepare(`
        SELECT id FROM meetings WHERE status IN ('scheduled','in_progress') AND ends_at <= ?
      `).all(nowIso());
      for (const row of due) await finalizeMeeting(row.id, 'slot_end');
      const unfinished = db.prepare(`
        SELECT id FROM meetings WHERE status='ended' AND finalized_at IS NULL
      `).all();
      for (const row of unfinished) await finalizeMeeting(row.id, 'recovery');
    } catch (error) {
      log.error('scheduler.failed', { error: error.message });
    }
  };
  setInterval(tick, config.schedulerMs).unref();
  setTimeout(tick, 1000).unref();

  setInterval(() => scanRecordings().catch(() => {}), config.recordingPollMs).unref();
  setTimeout(() => scanRecordings().catch(() => {}), 3000).unref();

  // Un worker interrompu (redémarrage, panne) ne doit jamais bloquer un job.
  recoverInterruptedTranscriptions();
  setInterval(recoverInterruptedTranscriptions, 5 * 60_000).unref();
}

module.exports = {
  finalizeMeeting,
  startScheduler,
  insertArtifact,
  scanRecordings,
  publishJsonArtifact,
};
