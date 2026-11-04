'use strict';

/**
 * Receveur de webhooks de démonstration.
 * Usage : node --env-file=.env scripts/webhook-receiver.js
 * Vérifie la signature HMAC et affiche l'événement en une ligne JSON.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const port = Number(process.env.WEBHOOK_PORT || 4555);
const secret = process.env.WEBHOOK_SECRET || '';

function verify(raw, header) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((part) => part.trim().split('=')));
  if (!parts.t || !parts.v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404);
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const valid = verify(raw, req.headers['x-webhook-signature']);
    let payload = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      // ignore
    }
    console.log(JSON.stringify({
      received_at: new Date().toISOString(),
      signature_valid: valid,
      event: payload.type,
      meeting_id: payload.meeting?.id,
      meeting_status: payload.meeting?.status,
      data: payload.data,
    }));
    res.writeHead(valid ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ received: true, signature_valid: valid }));
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[webhook] écoute sur http://0.0.0.0:${port}/webhook`);
  if (!secret) console.warn('[webhook] WEBHOOK_SECRET absent : les signatures seront invalides');
});
