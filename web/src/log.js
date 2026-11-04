'use strict';

function write(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: 'prototype-meet-web',
    event,
    ...fields,
  })}\n`);
}

module.exports = {
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
};
