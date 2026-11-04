'use strict';

function clean(fields = {}) {
  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value instanceof Error) {
      result[key] = value.message;
      continue;
    }
    result[key] = value;
  }
  return result;
}

function write(level, event, fields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...clean(fields),
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function info(event, fields) {
  write('info', event, fields);
}

function warn(event, fields) {
  write('warn', event, fields);
}

function error(event, fields) {
  write('error', event, fields);
}

module.exports = { info, warn, error };
