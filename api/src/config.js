'use strict';

const path = require('node:path');

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`Variable ${name} invalide: ${raw}`);
  return value;
}

function req(name, fallback = '') {
  const value = process.env[name] ?? fallback;
  if (value === '') throw new Error(`Variable d'environnement manquante: ${name}`);
  return value;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int('PORT', 3080),
  appBaseUrl: req('APP_BASE_URL', 'http://localhost:3080').replace(/\/$/, ''),
  masterApiKey: req('MASTER_API_KEY'),
  jwtAppId: process.env.JITSI_JWT_APP_ID || process.env.JWT_APP_ID || 'prototype-meet',
  jwtAppSecret: req('JITSI_JWT_APP_SECRET', process.env.JWT_APP_SECRET || ''),
  jwtAudience: process.env.JITSI_JWT_AUDIENCE || process.env.JWT_ACCEPTED_AUDIENCES || 'jitsi',
  jwtSubject: process.env.JITSI_JWT_SUB || 'meet.jitsi',
  jitsiPublicUrl: req('JITSI_PUBLIC_URL', process.env.PUBLIC_URL || 'https://meet.localhost:9443').replace(/\/$/, ''),
  jitsiDomain: new URL(req('JITSI_PUBLIC_URL', process.env.PUBLIC_URL || 'https://meet.localhost:9443')).host,
  databasePath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db'),
  capturesDir: process.env.CAPTURES_DIR || path.join(process.cwd(), 'data', 'captures'),
  recordingsDir: process.env.RECORDINGS_DIR || path.join(process.cwd(), 'data', 'recordings'),
  s3: {
    endpoint: req('S3_ENDPOINT'),
    publicEndpoint: req('S3_PUBLIC_ENDPOINT', req('S3_ENDPOINT')),
    region: process.env.S3_REGION || 'us-east-1',
    bucket: req('S3_BUCKET', 'prototype-meet'),
    accessKey: req('S3_ACCESS_KEY'),
    secretKey: req('S3_SECRET_KEY'),
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
    presignTtlSeconds: Math.min(int('S3_PRESIGN_TTL_SECONDS', 900), 900),
  },
  webhook: {
    url: process.env.WEBHOOK_URL || '',
    secret: process.env.WEBHOOK_SECRET || '',
  },
  branding: {
    name: process.env.BRAND_NAME || 'Visio Créneau',
    color: process.env.BRAND_COLOR || '#e11d48',
    logoUrl: process.env.BRAND_LOGO_URL || '',
    footer: process.env.BRAND_FOOTER || '',
  },
  timezone: process.env.DISPLAY_TIMEZONE || 'Europe/Paris',
  limits: {
    maxParticipants: int('MAX_PARTICIPANTS', 30),
    maxConcurrentMeetings: int('MAX_CONCURRENT_MEETINGS', 10),
    minDurationMinutes: int('MIN_MEETING_MINUTES', 30),
    maxDurationMinutes: int('MAX_MEETING_MINUTES', 480),
    maxEarlyJoinMinutes: int('MAX_EARLY_JOIN_MINUTES', 60),
    endWarningMinutes: int('END_WARNING_MINUTES', 3),
    transcriptionGraceSeconds: int('TRANSCRIPTION_GRACE_SECONDS', 120),
  },
  recordingPollMs: int('RECORDING_POLL_MS', 10000),
  jibri: {
    apiUrl: (process.env.JIBRI_HTTP_API_URL || 'http://jibri:2222').replace(/\/$/, ''),
    callLoginDomain: process.env.JIBRI_CALL_LOGIN_DOMAIN || 'hidden.meet.jitsi',
    recorderUser: process.env.JIBRI_RECORDER_USER || 'recorder',
    recorderPassword: process.env.JIBRI_RECORDER_PASSWORD || '',
  },
  maxConcurrentRecordings: int('MAX_CONCURRENT_RECORDINGS', 1),
  schedulerMs: int('SCHEDULER_MS', 5000),
};

if (config.jwtAppSecret.length < 32) {
  throw new Error('JITSI_JWT_APP_SECRET doit contenir au moins 32 caractères');
}
if (config.masterApiKey.length < 24) {
  throw new Error('MASTER_API_KEY doit contenir au moins 24 caractères');
}

module.exports = config;
