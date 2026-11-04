'use strict';

const { SignJWT } = require('jose');
const config = require('./config');
const { db } = require('./db');
const { HttpError, sha256, safeEqual, hmac } = require('./util');

const jwtKey = new TextEncoder().encode(config.jwtAppSecret);
const identityKey = config.jwtAppSecret;

function extractApiKey(req) {
  const header = req.get('x-api-key');
  if (header) return header.trim();
  const auth = req.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

function requireAdmin(req, res, next) {
  const key = extractApiKey(req);
  if (!key || !safeEqual(key, config.masterApiKey)) {
    return next(new HttpError(401, 'Clé API maître invalide ou absente'));
  }
  return next();
}

async function signJitsiJwt(meeting, identity) {
  const now = Math.floor(Date.now() / 1000);
  const expiration = Math.floor(new Date(meeting.ends_at).getTime() / 1000);
  if (expiration <= now) throw new HttpError(410, 'Le créneau est terminé');
  const moderator = identity.role === 'organizer';
  return new SignJWT({
    room: meeting.room,
    context: {
      user: {
        id: identity.external_id || identity.id,
        name: identity.display_name,
        moderator,
      },
      features: {
        recording: moderator && Boolean(meeting.recording),
        livestreaming: false,
        'screen-sharing': true,
      },
    },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(config.jwtAppId)
    .setAudience(config.jwtAudience)
    .setSubject(config.jwtSubject)
    .setIssuedAt(now)
    .setNotBefore(now - 60)
    .setExpirationTime(expiration)
    .setJti(sha256(`${meeting.id}:${identity.id}:${now}:${identity.role}`).slice(0, 32))
    .sign(jwtKey);
}

function signIdentity(tokenHash, data) {
  const payload = Buffer.from(JSON.stringify({ ...data, tokenHash }), 'utf8').toString('base64url');
  const signature = hmac(identityKey, payload);
  return `${payload}.${signature}`;
}

function verifyIdentity(tokenHash, value) {
  if (!value || typeof value !== 'string' || !value.includes('.')) return null;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = hmac(identityKey, payload);
  if (!safeEqual(signature, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.tokenHash !== tokenHash) return null;
    if (typeof data.display_name !== 'string' || typeof data.external_id !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

function requireSession(req, res, next) {
  try {
    const token = extractApiKey(req);
    if (!token) throw new HttpError(401, 'Session requise');
    const tokenHash = sha256(token);
    const session = db.prepare(`
      SELECT s.*, m.ends_at, m.starts_at, m.status, m.title, m.recording, m.transcription, m.chat, m.public_access, m.waiting_room, m.recording_state, m.room
      FROM sessions s JOIN meetings m ON m.id = s.meeting_id
      WHERE s.session_token_hash = ?
    `).get(tokenHash);
    if (!session) throw new HttpError(401, 'Session invalide');
    req.session = session;
    req.meeting = {
      id: session.meeting_id,
      ends_at: session.ends_at,
      starts_at: session.starts_at,
      status: session.status,
      title: session.title,
      recording: session.recording,
      transcription: session.transcription,
      chat: session.chat,
      public_access: session.public_access,
      waiting_room: session.waiting_room,
      recording_state: session.recording_state,
      room: session.room,
    };
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  requireAdmin,
  requireSession,
  signJitsiJwt,
  signIdentity,
  verifyIdentity,
  extractApiKey,
};
