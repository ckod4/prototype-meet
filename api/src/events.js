'use strict';

const { EventEmitter } = require('node:events');
const express = require('express');
const { db } = require('./db');
const { requireAdmin } = require('./auth');
const { randomId, nowIso } = require('./util');

const bus = new EventEmitter();
bus.setMaxListeners(2000);

const RETENTION_EVENTS = 10000;
let publishedSinceCleanup = 0;

function parseRow(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = {};
  }
  return {
    seq: Number(row.seq),
    id: row.id,
    client_id: row.client_id || null,
    meeting_id: row.meeting_id || null,
    type: row.type,
    created_at: row.created_at,
    data: payload.data || {},
  };
}

/**
 * Publie un événement durable. Le flux SSE et les webhooks consomment la même
 * source : aucune boucle d'interrogation n'est nécessaire côté consommateur.
 */
function publish(type, meetingId, data = {}, clientId = null) {
  const id = randomId(12);
  const createdAt = nowIso();
  const raw = JSON.stringify({ id, type, meeting_id: meetingId, client_id: clientId, created_at: createdAt, data });
  const result = db.prepare(`
    INSERT INTO events (id, client_id, meeting_id, type, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, clientId, meetingId, type, raw, createdAt);
  const event = {
    seq: Number(result.lastInsertRowid),
    id,
    client_id: clientId,
    meeting_id: meetingId,
    type,
    created_at: createdAt,
    data,
  };
  bus.emit('event', event);

  publishedSinceCleanup += 1;
  if (publishedSinceCleanup >= 200) {
    publishedSinceCleanup = 0;
    try {
      db.prepare(`
        DELETE FROM events WHERE seq <= (
          SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?
        )
      `).run(RETENTION_EVENTS);
    } catch {
      // Le nettoyage est opportuniste, jamais bloquant.
    }
  }
  return event;
}

function subscribe(listener) {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

function replay({ afterSeq = 0, clientId = null, limit = 10000 } = {}) {
  const rows = clientId
    ? db.prepare(`
        SELECT * FROM events WHERE seq > ? AND client_id = ? ORDER BY seq ASC LIMIT ?
      `).all(afterSeq, clientId, limit)
    : db.prepare(`
        SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?
      `).all(afterSeq, limit);
  return rows.map(parseRow);
}

function latestSeq() {
  const row = db.prepare('SELECT MAX(seq) AS seq FROM events').get();
  return Number(row?.seq || 0);
}

const router = express.Router();

router.get('/api/v1/events/stream', requireAdmin, (req, res) => {
  const clientId = typeof req.query.client_id === 'string' && req.query.client_id
    ? req.query.client_id.slice(0, 128)
    : null;
  const afterSeq = Math.max(0, Number.parseInt(
    String(req.get('last-event-id') || req.query.last_event_id || '0'),
    10,
  ) || 0);

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let closed = false;
  let unsubscribe = null;
  let heartbeat = null;
  let replaying = true;
  let lastSentSeq = afterSeq;
  const pending = [];

  function cleanup() {
    if (closed) return;
    closed = true;
    if (unsubscribe) unsubscribe();
    if (heartbeat) clearInterval(heartbeat);
    res.end();
  }

  function send(event) {
    if (closed) return;
    if (clientId && event.client_id !== clientId) return;
    if (event.seq <= lastSentSeq) return;
    if (res.writableLength > 2 * 1024 * 1024) {
      cleanup();
      return;
    }
    lastSentSeq = event.seq;
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  function onLive(event) {
    if (replaying) {
      pending.push(event);
      return;
    }
    send(event);
  }

  res.write('retry: 3000\n\n');
  const latest = Number(db.prepare('SELECT MAX(seq) AS seq FROM events').get()?.seq || 0);
  res.write(`event: stream.ready\ndata: ${JSON.stringify({ latest_seq: latest, after_seq: afterSeq })}\n\n`);

  // S'abonner avant de rejouer évite de perdre un événement publié pendant
  // la lecture de l'historique. Les doublons sont écartés par lastSentSeq.
  unsubscribe = subscribe(onLive);
  for (const event of replay({ afterSeq, clientId })) send(event);
  replaying = false;
  pending.sort((a, b) => a.seq - b.seq).forEach(send);
  heartbeat = setInterval(() => {
    if (closed) return;
    res.write(`: keepalive ${nowIso()}\n\n`);
  }, 15000);
  heartbeat.unref();

  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('error', cleanup);
});

module.exports = {
  publish,
  subscribe,
  replay,
  latestSeq,
  router,
};
