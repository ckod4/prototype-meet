'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS web_meetings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_meeting_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  early_join_minutes INTEGER NOT NULL DEFAULT 0,
  recording INTEGER NOT NULL DEFAULT 0,
  transcription INTEGER NOT NULL DEFAULT 0,
  chat INTEGER NOT NULL DEFAULT 1,
  public_access INTEGER NOT NULL DEFAULT 0,
  waiting_room INTEGER NOT NULL DEFAULT 0,
  recording_state TEXT NOT NULL DEFAULT 'idle',
  organizer_url_enc TEXT NOT NULL,
  participant_url_enc TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_meetings_user ON web_meetings(user_id, created_at);

CREATE TABLE IF NOT EXISTS meeting_organizers (
  id TEXT PRIMARY KEY,
  web_meeting_id TEXT NOT NULL REFERENCES web_meetings(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT,
  organizer_url_enc TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending')),
  invited_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(web_meeting_id, email)
);
CREATE INDEX IF NOT EXISTS idx_meeting_organizers_user ON meeting_organizers(user_id, status);
CREATE INDEX IF NOT EXISTS idx_meeting_organizers_meeting ON meeting_organizers(web_meeting_id);

CREATE TABLE IF NOT EXISTS meeting_consents (
  api_meeting_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (api_meeting_id, external_id)
);

CREATE TABLE IF NOT EXISTS web_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const meetingColumns = db.prepare('PRAGMA table_info(web_meetings)').all().map((column) => column.name);
const webMeetingMigrations = [
  ['chat', 'ALTER TABLE web_meetings ADD COLUMN chat INTEGER NOT NULL DEFAULT 1'],
  ['public_access', 'ALTER TABLE web_meetings ADD COLUMN public_access INTEGER NOT NULL DEFAULT 0'],
  ['waiting_room', 'ALTER TABLE web_meetings ADD COLUMN waiting_room INTEGER NOT NULL DEFAULT 0'],
  ['recording_state', "ALTER TABLE web_meetings ADD COLUMN recording_state TEXT NOT NULL DEFAULT 'idle'"],
];
for (const [column, sql] of webMeetingMigrations) {
  if (!meetingColumns.includes(column)) db.exec(sql);
}

// Backfill du créateur comme organisateur pour les bases existantes.
const creatorMeetings = db.prepare(`
  SELECT wm.*, u.email, u.name
  FROM web_meetings wm JOIN users u ON u.id = wm.user_id
  WHERE NOT EXISTS (SELECT 1 FROM meeting_organizers mo WHERE mo.web_meeting_id = wm.id AND mo.user_id = wm.user_id)
`).all();
for (const meeting of creatorMeetings) {
  db.prepare(`
    INSERT OR IGNORE INTO meeting_organizers
      (id, web_meeting_id, user_id, email, display_name, organizer_url_enc, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(crypto.randomUUID(), meeting.id, meeting.user_id, meeting.email, meeting.name,
    meeting.organizer_url_enc, new Date().toISOString());
}

module.exports = { db };
