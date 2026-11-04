'use strict';

const config = require('./config');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parisParts(date) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function parisOffsetMs(date) {
  const parts = parisParts(date);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(new Date(date).getTime() / 1000) * 1000;
}

function parisLocalToIso(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error('Date et heure locales invalides');
  const [, y, m, d, h, min] = match.map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59) throw new Error('Date et heure locales invalides');
  const guess = Date.UTC(y, m - 1, d, h, min, 0);
  const firstOffset = parisOffsetMs(new Date(guess));
  let timestamp = guess - firstOffset;
  const secondOffset = parisOffsetMs(new Date(timestamp));
  if (secondOffset !== firstOffset) timestamp = guess - secondOffset;
  const result = new Date(timestamp);
  if (Number.isNaN(result.getTime())) throw new Error('Date invalide');
  return result.toISOString();
}

function toParisInput(iso) {
  if (!iso) return '';
  const parts = parisParts(iso);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function parisDateTime(iso) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: config.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function parisDateLong(iso) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: config.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso));
}

function parisShortDateTime(iso) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: config.timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function parisTime(iso) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m} min`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} o`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} Ko`;
  return `${(value / 1024 / 1024).toFixed(1)} Mo`;
}

function statusInfo(meeting) {
  if (!meeting) return { key: 'unknown', label: 'Indisponible', tone: 'neutral' };
  if (meeting.status === 'cancelled') return { key: 'cancelled', label: 'Annulée', tone: 'danger' };
  if (meeting.status === 'ended') return { key: 'ended', label: 'Terminée', tone: 'neutral' };
  const phase = meeting.state?.phase;
  if (phase === 'waiting') return { key: 'waiting', label: 'En attente', tone: 'wait' };
  if (meeting.status === 'in_progress') return { key: 'live', label: 'En cours', tone: 'live' };
  if (phase === 'open') return { key: 'open', label: 'Ouverte', tone: 'open' };
  return { key: 'scheduled', label: 'Programmée', tone: 'open' };
}

function recordingStateLabel(state) {
  return {
    idle: 'en attente',
    pending: 'démarrage',
    active: 'en cours',
    failed: 'échec',
    stopped: 'terminé',
  }[state] || state;
}

function artifactLabel(type) {
  return {
    recording: 'Enregistrement vidéo (MP4)',
    transcript_json: 'Transcription JSON',
    transcript_txt: 'Transcription texte',
    transcript_srt: 'Sous-titres SRT',
    transcript_vtt: 'Sous-titres VTT',
    chat: 'Historique du chat (JSON)',
    attendance: 'Liste de présence (JSON)',
  }[type] || type;
}

module.exports = {
  escapeHtml,
  parisParts,
  parisOffsetMs,
  parisLocalToIso,
  toParisInput,
  parisDateTime,
  parisDateLong,
  parisShortDateTime,
  parisTime,
  formatDuration,
  formatBytes,
  statusInfo,
  artifactLabel,
  recordingStateLabel,
};
