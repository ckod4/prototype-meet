'use strict';

const crypto = require('node:crypto');
const config = require('./config');

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function nowIso() {
  return new Date().toISOString();
}

function parseOffsetDate(value) {
  if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value)) {
    throw new HttpError(400, 'Date ISO 8601 avec décalage horaire requise (ex. 2026-11-05T14:00:00+01:00)');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `Date invalide: ${value}`);
  return date;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

function iso(date) {
  return new Date(date).toISOString();
}

function epochSeconds(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function parisDateTime(date) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: config.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

function parisTime(date) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

function parisOffsetLabel(date) {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: config.timezone,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(date));
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value || '';
  return tz.replace('UTC', 'UTC');
}

function durationSeconds(start, end) {
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${String(sec).padStart(2, '0')} s`;
}

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function publicOrigin() {
  return new URL(config.appBaseUrl).origin;
}

function isSecureBase() {
  return new URL(config.appBaseUrl).protocol === 'https:';
}

module.exports = {
  randomId,
  randomToken,
  sha256,
  hmac,
  safeEqual,
  nowIso,
  parseOffsetDate,
  addMinutes,
  iso,
  epochSeconds,
  parisDateTime,
  parisTime,
  parisOffsetLabel,
  durationSeconds,
  formatDuration,
  clock,
  escapeHtml,
  HttpError,
  asyncHandler,
  publicOrigin,
  isSecureBase,
};
