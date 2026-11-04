'use strict';

const path = require('node:path');

function required(name, fallback = '') {
  const value = process.env[name] ?? fallback;
  if (value === '') throw new Error(`Variable d'environnement manquante: ${name}`);
  return value;
}

const sessionSecret = required('WEB_SESSION_SECRET');
const encryptionKey = required('WEB_ENCRYPTION_KEY');

if (sessionSecret.length < 32) throw new Error('WEB_SESSION_SECRET doit contenir au moins 32 caractères');
if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
  throw new Error('WEB_ENCRYPTION_KEY doit être une clé hexadécimale de 32 octets (64 caractères)');
}

const webBaseUrl = required('WEB_BASE_URL', 'http://localhost:3090').replace(/\/$/, '');

module.exports = {
  port: Number.parseInt(process.env.WEB_PORT || '3090', 10),
  baseUrl: webBaseUrl,
  apiInternalUrl: required('API_INTERNAL_URL', 'http://api:3080').replace(/\/$/, ''),
  masterApiKey: required('MASTER_API_KEY'),
  clientId: (() => {
    const value = process.env.WEB_CLIENT_ID || 'web';
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
      throw new Error('WEB_CLIENT_ID doit contenir uniquement lettres, chiffres, point, deux-points, tiret ou underscore');
    }
    return value;
  })(),
  jitsiPublicUrl: required('JITSI_PUBLIC_URL', 'https://meet.localhost:9443').replace(/\/$/, ''),
  jitsiDomain: new URL(required('JITSI_PUBLIC_URL', 'https://meet.localhost:9443')).host,
  jitsiOrigin: new URL(required('JITSI_PUBLIC_URL', 'https://meet.localhost:9443')).origin,
  sessionSecret,
  encryptionKey,
  dbPath: process.env.WEB_DB_PATH || path.join(process.cwd(), 'data', 'web.db'),
  timezone: process.env.DISPLAY_TIMEZONE || 'Europe/Paris',
  sessionDays: 7,
  cookieSecure: new URL(webBaseUrl).protocol === 'https:',
  branding: {
    name: process.env.BRAND_NAME || 'Visio Créneau',
    color: /^#[0-9a-fA-F]{6}$/.test(process.env.BRAND_COLOR || '') ? process.env.BRAND_COLOR : '#e11d48',
    logoUrl: process.env.BRAND_LOGO_URL || '',
    footer: process.env.BRAND_FOOTER || '',
  },
};
