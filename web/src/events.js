'use strict';

const { EventEmitter } = require('node:events');
const config = require('./config');
const { db } = require('./db');
const log = require('./log');

const bus = new EventEmitter();
bus.setMaxListeners(2000);

let running = false;
let controller = null;
let retryDelayMs = 1000;
let lastSeq = Number.parseInt(
  db.prepare("SELECT value FROM web_state WHERE key='events.last_seq'").get()?.value || '0',
  10,
) || 0;

function saveLastSeq(value) {
  db.prepare(`
    INSERT INTO web_state (key, value) VALUES ('events.last_seq', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(String(value));
}

function rememberMeetingState(event) {
  if (!event.meeting_id) return;
  try {
    if (event.type === 'recording.updated' && event.data?.state) {
      db.prepare('UPDATE web_meetings SET recording_state=? WHERE api_meeting_id=?')
        .run(String(event.data.state), event.meeting_id);
    }
    if (event.type === 'meeting.updated') {
      const patches = [];
      const params = [];
      for (const [field, key] of [['chat', 'chat'], ['public_access', 'public_access'], ['waiting_room', 'waiting_room']]) {
        if (event.data && typeof event.data[key] === 'boolean') {
          patches.push(`${field}=?`);
          params.push(event.data[key] ? 1 : 0);
        }
      }
      if (patches.length) {
        params.push(event.meeting_id);
        db.prepare(`UPDATE web_meetings SET ${patches.join(', ')} WHERE api_meeting_id=?`).run(...params);
      }
    }
  } catch (error) {
    log.warn('events.local_state_failed', { error: error.message, type: event.type });
  }
}

function acceptEvent(event) {
  if (!event || !Number.isFinite(event.seq) || event.seq <= lastSeq) return;
  lastSeq = event.seq;
  try {
    saveLastSeq(lastSeq);
    rememberMeetingState(event);
  } catch (error) {
    log.warn('events.local_persist_failed', { error: error.message, seq: event.seq });
  }
  try {
    bus.emit('event', event);
  } catch (error) {
    log.warn('events.listener_failed', { error: error.message, type: event.type });
  }
}

async function connectOnce() {
  controller = new AbortController();
  const response = await fetch(
    `${config.apiInternalUrl}/api/v1/events/stream?last_event_id=${lastSeq}`,
    {
      headers: {
        'x-api-key': config.masterApiKey,
        'x-client-id': config.clientId,
        accept: 'text/event-stream',
      },
      signal: controller.signal,
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`flux API HTTP ${response.status} ${detail.slice(0, 200)}`);
  }
  log.info('events.connected', { after_seq: lastSeq });
  retryDelayMs = 1000;

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      let resetCursor = false;
      if (data) {
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed.latest_seq === 'number') {
            // La base API a pu être réinitialisée : le curseur local serait
            // alors définitivement en avance sur les nouveaux événements.
            // On repart de zéro et on reconnecte pour rejouer le journal neuf.
            if (parsed.latest_seq < lastSeq) {
              lastSeq = 0;
              saveLastSeq(0);
              resetCursor = true;
            }
          } else {
            acceptEvent(parsed);
          }
        } catch (error) {
          log.warn('events.invalid_payload', { error: error.message });
        }
      }
      if (resetCursor) {
        controller.abort();
        return;
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  throw new Error('flux API terminé');
}

async function loop() {
  while (running) {
    try {
      await connectOnce();
    } catch (error) {
      if (!running) return;
      log.warn('events.disconnected', { error: error.message, retry_ms: retryDelayMs });
    }
    if (!running) return;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    retryDelayMs = Math.min(retryDelayMs * 2, 30000);
  }
}

function startEventStream() {
  if (running) return;
  running = true;
  loop().catch((error) => log.error('events.loop_failed', { error: error.message }));
}

function stopEventStream() {
  running = false;
  if (controller) controller.abort();
}

function onEvent(listener) {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

module.exports = {
  startEventStream,
  stopEventStream,
  onEvent,
  lastSeq: () => lastSeq,
};
