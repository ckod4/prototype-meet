'use strict';

const config = require('./config');
const { db } = require('./db');
const { publish } = require('./events');
const { randomId, nowIso, hmac } = require('./util');
const log = require('./log');

function meetingSummary(meeting) {
  return {
    id: meeting.id,
    title: meeting.title,
    starts_at: meeting.starts_at,
    ends_at: meeting.ends_at,
    early_join_minutes: meeting.early_join_minutes,
    status: meeting.status,
    recording: Boolean(meeting.recording),
    transcription: Boolean(meeting.transcription),
    chat: Boolean(meeting.chat),
    public_access: Boolean(meeting.public_access),
    waiting_room: Boolean(meeting.waiting_room),
    recording_state: meeting.recording_state || 'idle',
    recording_error: meeting.recording_error || null,
    client_id: meeting.client_id || null,
    created_at: meeting.created_at,
    started_at: meeting.started_at || null,
    ended_at: meeting.ended_at || null,
    cancelled_at: meeting.cancelled_at || null,
  };
}

/**
 * Point d'entrée unique des notifications sortantes.
 * - journal durable dans `events`, consommable par SSE avec reprise ;
 * - livraison webhook optionnelle, signée et historisée.
 */
function emit(event, meetingId, data = {}) {
  let eventRecord = null;
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
    if (!meeting) return null;
    eventRecord = publish(event, meetingId, data, meeting.client_id || null);
    if (!config.webhook.url) return eventRecord;
    const id = randomId(12);
    const createdAt = nowIso();
    const payload = {
      id,
      event_id: eventRecord.id,
      seq: eventRecord.seq,
      type: event,
      created_at: createdAt,
      meeting: meetingSummary(meeting),
      data,
    };
    const raw = JSON.stringify(payload);
    db.prepare(`
      INSERT INTO webhook_deliveries (id, meeting_id, event, url, payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, meetingId, event, config.webhook.url, raw, createdAt);
    queueMicrotask(() => deliver(id, raw).catch((error) => {
      log.error('webhook.delivery_failed', { event, delivery_id: id, error: error.message });
    }));
  } catch (error) {
    log.error('event.publish_failed', { event, meeting_id: meetingId, error: error.message });
  }
  return eventRecord;
}

async function deliver(id, raw) {
  const delivery = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id);
  if (!delivery || delivery.status === 'delivered') return;
  let lastError = '';
  let responseCode = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = hmac(config.webhook.secret, `${timestamp}.${raw}`);
    try {
      const response = await fetch(config.webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'prototype-meet-webhooks/1.0',
          'x-webhook-event': delivery.event,
          'x-webhook-timestamp': String(timestamp),
          'x-webhook-signature': `t=${timestamp},v1=${signature}`,
        },
        body: raw,
        signal: AbortSignal.timeout(8000),
      });
      responseCode = response.status;
      if (response.ok) {
        db.prepare(`
          UPDATE webhook_deliveries SET status='delivered', attempts=?, response_code=?, delivered_at=?, error=NULL WHERE id=?
        `).run(attempt, responseCode, nowIso(), id);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    db.prepare('UPDATE webhook_deliveries SET attempts=?, response_code=?, error=? WHERE id=?')
      .run(attempt, responseCode, lastError, id);
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
  db.prepare('UPDATE webhook_deliveries SET status=? WHERE id=?').run('failed', id);
}

module.exports = { emit, meetingSummary };
