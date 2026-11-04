'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { db } = require('./db');

const encryptionKey = Buffer.from(config.encryptionKey, 'hex');

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sessionTokenHash(token) {
  return crypto.createHmac('sha256', config.sessionSecret).update(token).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    return safeEqual(hash, expectedHash);
  } catch {
    return false;
  }
}

function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

function decryptJson(value) {
  try {
    const [ivRaw, tagRaw, encryptedRaw] = String(value).split('.');
    if (!ivRaw || !tagRaw || !encryptedRaw) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64url')), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    return null;
  }
}

function createSession(userId) {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionDays * 86400_000);
  db.prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), userId, sessionTokenHash(token), now.toISOString(), expires.toISOString());
  return { token, expires };
}

function findUserBySessionToken(token) {
  if (!token) return null;
  const session = db.prepare(`
    SELECT s.*, u.id AS user_id, u.email, u.name
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sessionTokenHash(token));
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
    return null;
  }
  return {
    id: session.user_id,
    email: session.email,
    name: session.name,
    sessionId: session.id,
  };
}

function deleteSessionByToken(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sessionTokenHash(token));
}

module.exports = {
  randomToken,
  sha256,
  safeEqual,
  hashPassword,
  verifyPassword,
  encryptJson,
  decryptJson,
  createSession,
  findUserBySessionToken,
  deleteSessionByToken,
};
