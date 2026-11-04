'use strict';

const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');
const { db } = require('./db');
const { router: linksRouter } = require('./links');
const { router: sessionRouter } = require('./session');
const { router: eventsRouter } = require('./events');
const { router: adminRouter } = require('./admin');
const { startScheduler } = require('./finalize');
const { startRecordingScheduler } = require('./recording');
const s3 = require('./s3');
const { HttpError, nowIso } = require('./util');
const log = require('./log');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

app.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

function redactPath(urlPath) {
  return urlPath.replace(/^\/m\/[^/]+/, '/m/[lien]');
}

app.use((req, res, next) => {
  const started = Date.now();
  req.requestId = String(req.get('x-request-id') || '').slice(0, 100) || crypto.randomUUID();
  res.set('x-request-id', req.requestId);
  res.on('finish', () => {
    log.info('http.request', {
      request_id: req.requestId,
      method: req.method,
      path: redactPath(req.originalUrl.split('?')[0]),
      status: res.statusCode,
      duration_ms: Date.now() - started,
      ip: req.ip,
    });
  });
  next();
});

app.get('/health', (req, res) => {
  let database = 'ok';
  try {
    db.prepare('SELECT 1').get();
  } catch {
    database = 'unavailable';
  }
  const healthy = database === 'ok';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'prototype-meet-api',
    time: nowIso(),
    checks: { database },
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'prototype-meet-api',
    version: 1,
    headless: true,
    health: '/health',
    events: '/api/v1/events/stream',
    documentation: 'Voir README.md, section API.',
  });
});

app.use(linksRouter);
app.use(sessionRouter);
app.use(eventsRouter);
app.use(adminRouter);

app.use((req, res, next) => {
  next(new HttpError(404, 'Ressource introuvable'));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) {
    log.error('http.error', {
      request_id: req.requestId,
      method: req.method,
      path: redactPath(req.path),
      status,
      message: error.message,
      stack: error.stack,
    });
  }
  res.status(status).json({
    error: status >= 500 ? 'Erreur interne' : error.message,
    ...(error.details ? { details: error.details } : {}),
    request_id: req.requestId,
  });
});

async function ensureS3WithRetry() {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await s3.ensureBucket();
      log.info('s3.bucket_ready', { bucket: s3.bucket });
      return;
    } catch (error) {
      log.warn('s3.unavailable', { attempt, max_attempts: 20, error: error.message });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  log.error('s3.unreachable', { max_attempts: 20 });
}

const server = app.listen(config.port, '0.0.0.0', () => {
  log.info('api.started', {
    port: config.port,
    base_url: config.appBaseUrl,
    jitsi_url: config.jitsiPublicUrl,
    jitsi_domain: config.jitsiDomain,
  });
  ensureS3WithRetry();
  startScheduler();
  startRecordingScheduler();
});

function shutdown(signal) {
  log.info('api.stopping', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app };
