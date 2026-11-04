'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
fs.mkdirSync(config.capturesDir, { recursive: true });

const db = new DatabaseSync(config.databasePath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  early_join_minutes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled',
  recording INTEGER NOT NULL DEFAULT 0,
  transcription INTEGER NOT NULL DEFAULT 0,
  chat INTEGER NOT NULL DEFAULT 1,
  public_access INTEGER NOT NULL DEFAULT 0,
  waiting_room INTEGER NOT NULL DEFAULT 0,
  recording_state TEXT NOT NULL DEFAULT 'idle',
  recording_started_at TEXT,
  recording_last_attempt_at TEXT,
  recording_error TEXT,
  recording_session_id TEXT,
  client_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  cancelled_at TEXT,
  finalized_at TEXT
);

CREATE TABLE IF NOT EXISTS access_tokens (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('organizer','participant')),
  kind TEXT NOT NULL CHECK (kind IN ('named','generic')),
  display_name TEXT,
  external_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_meeting ON access_tokens(meeting_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  token_id TEXT REFERENCES access_tokens(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  display_name TEXT NOT NULL,
  external_id TEXT,
  session_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  joined_at TEXT,
  left_at TEXT,
  last_seen_at TEXT,
  user_agent TEXT,
  admission_status TEXT NOT NULL DEFAULT 'admitted',
  admitted_at TEXT,
  excluded_at TEXT,
  media_audio_allowed INTEGER NOT NULL DEFAULT 1,
  media_video_allowed INTEGER NOT NULL DEFAULT 1,
  media_screen_allowed INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_sessions_meeting ON sessions(meeting_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(meeting_id, left_at);

CREATE TABLE IF NOT EXISTS attendance_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  session_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('joined','left')),
  display_name TEXT NOT NULL,
  external_id TEXT,
  role TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attendance_meeting ON attendance_events(meeting_id, at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  session_id TEXT,
  author_name TEXT NOT NULL,
  external_id TEXT,
  role TEXT,
  text TEXT NOT NULL,
  jitsi_message_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_unique ON chat_messages(meeting_id, jitsi_message_id) WHERE jitsi_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_meeting ON chat_messages(meeting_id, created_at);

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  external_id TEXT,
  role TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime TEXT,
  started_at TEXT NOT NULL,
  chunks INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  mute_intervals TEXT NOT NULL DEFAULT '[]',
  complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(meeting_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_captures_meeting ON captures(meeting_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  filename TEXT NOT NULL,
  s3_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifacts_meeting ON artifacts(meeting_id, type);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  meeting_id TEXT,
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhooks_meeting ON webhook_deliveries(meeting_id, created_at);

CREATE TABLE IF NOT EXISTS transcription_jobs (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  heartbeat_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_bans (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  session_id TEXT,
  token_id TEXT,
  external_id TEXT,
  display_name TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bans_meeting ON meeting_bans(meeting_id, created_at);

CREATE TABLE IF NOT EXISTS recording_uploads (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(meeting_id, file_name)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  client_id TEXT,
  meeting_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_meeting_seq ON events(meeting_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_client_seq ON events(client_id, seq);
`);

// Migration douce pour les bases créées avant l'option chat.
const meetingColumns = db.prepare('PRAGMA table_info(meetings)').all().map((column) => column.name);
const meetingMigrations = [
  ['chat', 'ALTER TABLE meetings ADD COLUMN chat INTEGER NOT NULL DEFAULT 1'],
  ['public_access', 'ALTER TABLE meetings ADD COLUMN public_access INTEGER NOT NULL DEFAULT 0'],
  ['waiting_room', 'ALTER TABLE meetings ADD COLUMN waiting_room INTEGER NOT NULL DEFAULT 0'],
  ['recording_state', "ALTER TABLE meetings ADD COLUMN recording_state TEXT NOT NULL DEFAULT 'idle'"],
  ['recording_started_at', 'ALTER TABLE meetings ADD COLUMN recording_started_at TEXT'],
  ['recording_last_attempt_at', 'ALTER TABLE meetings ADD COLUMN recording_last_attempt_at TEXT'],
  ['recording_error', 'ALTER TABLE meetings ADD COLUMN recording_error TEXT'],
  ['recording_session_id', 'ALTER TABLE meetings ADD COLUMN recording_session_id TEXT'],
  ['client_id', 'ALTER TABLE meetings ADD COLUMN client_id TEXT'],
];
for (const [column, sql] of meetingMigrations) {
  if (!meetingColumns.includes(column)) db.exec(sql);
}
const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
const sessionMigrations = [
  ['admission_status', "ALTER TABLE sessions ADD COLUMN admission_status TEXT NOT NULL DEFAULT 'admitted'"],
  ['admitted_at', 'ALTER TABLE sessions ADD COLUMN admitted_at TEXT'],
  ['excluded_at', 'ALTER TABLE sessions ADD COLUMN excluded_at TEXT'],
  ['media_audio_allowed', 'ALTER TABLE sessions ADD COLUMN media_audio_allowed INTEGER NOT NULL DEFAULT 1'],
  ['media_video_allowed', 'ALTER TABLE sessions ADD COLUMN media_video_allowed INTEGER NOT NULL DEFAULT 1'],
  ['media_screen_allowed', 'ALTER TABLE sessions ADD COLUMN media_screen_allowed INTEGER NOT NULL DEFAULT 1'],
];
for (const [column, sql] of sessionMigrations) {
  if (!sessionColumns.includes(column)) db.exec(sql);
}
const jobColumns = db.prepare('PRAGMA table_info(transcription_jobs)').all().map((column) => column.name);
if (!jobColumns.includes('heartbeat_at')) {
  db.exec('ALTER TABLE transcription_jobs ADD COLUMN heartbeat_at TEXT');
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { db, tx };
