'use strict';

const config = require('./config');
const { db } = require('./db');
const { emit } = require('./webhooks');
const { nowIso } = require('./util');
const log = require('./log');

const starting = new Set();
const stopping = new Set();

function recordingPayload(meeting) {
  return {
    sessionId: meeting.recording_session_id || meeting.id,
    callParams: {
      callUrlInfo: {
        baseUrl: config.jitsiPublicUrl,
        callName: meeting.room,
        tenant: '',
        urlParams: [],
      },
      email: '',
      passcode: null,
      callStatsUsernameOverride: '',
      displayName: '',
      extraUrlParams: [],
    },
    callLoginParams: {
      domain: config.jibri.callLoginDomain,
      username: config.jibri.recorderUser,
      password: config.jibri.recorderPassword,
      randomizeUsername: false,
    },
    sinkType: 'FILE',
  };
}

async function startRecording(meeting) {
  if (starting.has(meeting.id)) return;
  if (!config.jibri.recorderPassword) {
    db.prepare(`
      UPDATE meetings SET recording_state='failed', recording_last_attempt_at=?, recording_error=?
      WHERE id=?
    `).run(nowIso(), 'JIBRI_RECORDER_PASSWORD absent', meeting.id);
    emit('recording.updated', meeting.id, { state: 'failed', error: 'JIBRI_RECORDER_PASSWORD absent' });
    return;
  }
  starting.add(meeting.id);
  db.prepare(`
    UPDATE meetings SET recording_state='pending', recording_last_attempt_at=?, recording_error=NULL
    WHERE id=?
  `).run(nowIso(), meeting.id);
  try {
    const response = await fetch(`${config.jibri.apiUrl}/jibri/api/v1.0/startService`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(recordingPayload(meeting)),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Jibri HTTP ${response.status} ${detail.slice(0, 300)}`);
    }
    db.prepare(`
      UPDATE meetings SET recording_state='active', recording_started_at=?, recording_last_attempt_at=?,
        recording_error=NULL, recording_session_id=COALESCE(recording_session_id, ?)
      WHERE id=?
    `).run(nowIso(), nowIso(), meeting.recording_session_id || meeting.id, meeting.id);
    emit('recording.updated', meeting.id, { state: 'active', error: null });
    log.info('recording.started', { meeting_id: meeting.id });
  } catch (error) {
    db.prepare(`
      UPDATE meetings SET recording_state='failed', recording_last_attempt_at=?, recording_error=?
      WHERE id=?
    `).run(nowIso(), String(error.message).slice(0, 500), meeting.id);
    emit('recording.updated', meeting.id, { state: 'failed', error: String(error.message).slice(0, 500) });
    log.warn('recording.start_failed', { meeting_id: meeting.id, error: error.message });
  } finally {
    starting.delete(meeting.id);
  }
}

async function stopRecording(meeting) {
  if (stopping.has(meeting.id)) return;
  stopping.add(meeting.id);
  try {
    await fetch(`${config.jibri.apiUrl}/jibri/api/v1.0/stopService`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
  } finally {
    db.prepare("UPDATE meetings SET recording_state='stopped' WHERE id=?").run(meeting.id);
    emit('recording.updated', meeting.id, { state: 'stopped', error: null });
    stopping.delete(meeting.id);
  }
}

async function tickRecordings() {
  const now = Date.now();
  const meetings = db.prepare(`
    SELECT m.* FROM meetings m
    WHERE m.recording=1
      AND m.status IN ('scheduled','in_progress')
      AND (m.recording_state IN ('idle','failed') OR (m.recording_state='pending' AND m.recording_last_attempt_at < ?))
      AND m.starts_at <= ?
      AND m.ends_at > ?
      AND EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.meeting_id=m.id AND s.joined_at IS NOT NULL AND s.left_at IS NULL
          AND s.admission_status='admitted'
      )
  `).all(new Date(now - 30000).toISOString(), new Date(now).toISOString(), new Date(now).toISOString());
  for (const meeting of meetings) {
    const last = meeting.recording_last_attempt_at ? new Date(meeting.recording_last_attempt_at).getTime() : 0;
    if (now - last < 20000) continue;
    await startRecording(meeting);
  }

  const toStop = db.prepare(`
    SELECT * FROM meetings
    WHERE recording=1 AND recording_state IN ('active','pending')
      AND (status='ended' OR ends_at <= ?)
  `).all(new Date(now).toISOString());
  for (const meeting of toStop) {
    await stopRecording(meeting);
  }

  db.prepare(`
    UPDATE meetings SET recording_state='stopped', recording_error='Aucun participant n’a rejoint la salle'
    WHERE recording=1 AND status='ended' AND recording_state='idle'
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.meeting_id=meetings.id AND s.joined_at IS NOT NULL)
  `).run();
}

function startRecordingScheduler() {
  setInterval(() => tickRecordings().catch((error) => {
    log.error('recording.scheduler_failed', { error: error.message });
  }), 5000).unref();
  setTimeout(() => tickRecordings().catch(() => {}), 2000).unref();
}

module.exports = {
  startRecordingScheduler,
  startRecording,
  stopRecording,
  recordingPayload,
};
