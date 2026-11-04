'use strict';

const config = require('./config');

class ApiError extends Error {
  constructor(status, message, details, cause) {
    super(message);
    this.status = status;
    this.details = details;
    this.cause = cause;
  }
}

async function request(path, options = {}) {
  const url = `${config.apiInternalUrl}${path}`;
  const headers = {};
  if (options.auth !== false) {
    headers['x-api-key'] = config.masterApiKey;
    headers['x-client-id'] = config.clientId;
  }
  if (options.body) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs || 15000),
    });
  } catch (error) {
    throw new ApiError(503, 'Service de réunion indisponible', null, error);
  }
  let data = null;
  const text = await response.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 500) }; }
  }
  if (!response.ok) {
    const details = data?.details ?? null;
    let message = data?.error || `Erreur API ${response.status}`;
    if (Array.isArray(details) && details.length) {
      message += ` (${details.map((d) => `${d.path ? `${d.path}: ` : ''}${d.message}`).join(' ; ')})`;
    }
    throw new ApiError(response.status, message, details);
  }
  return data;
}

const api = {
  async createMeeting(payload) {
    return request('/api/v1/meetings', { method: 'POST', body: payload });
  },
  async resolveAccess(token) {
    return request('/api/v1/links/resolve', { method: 'POST', body: { token }, auth: false });
  },
  async joinAccess(token, identity = {}, sessionToken = '') {
    return request('/api/v1/links/join', {
      method: 'POST',
      body: {
        token,
        display_name: identity.display_name,
        external_id: identity.external_id,
        session_token: sessionToken,
      },
      auth: false,
    });
  },
  async sessionStatus(meetingSessionToken) {
    const url = `${config.apiInternalUrl}/api/session/status`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${meetingSessionToken}` },
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      throw new ApiError(response.status, data?.error || 'Session de réunion invalide', data?.details);
    }
    return data;
  },
  async getMeeting(id) {
    return (await request(`/api/v1/meetings/${encodeURIComponent(id)}`)).meeting;
  },
  async addLink(id, payload) {
    return (await request(`/api/v1/meetings/${encodeURIComponent(id)}/links`, { method: 'POST', body: payload })).link;
  },
  async getWaiting(id) {
    return request(`/api/v1/meetings/${encodeURIComponent(id)}/waiting`);
  },
  async admitWaiting(id, payload) {
    return request(`/api/v1/meetings/${encodeURIComponent(id)}/waiting/admit`, { method: 'POST', body: payload });
  },
  async deleteArtifact(id) {
    return request(`/api/v1/artifacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async updateMeeting(id, payload) {
    return (await request(`/api/v1/meetings/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload })).meeting;
  },
  async cancelMeeting(id) {
    return (await request(`/api/v1/meetings/${encodeURIComponent(id)}/cancel`, { method: 'POST' })).meeting;
  },
  async endMeeting(id) {
    return (await request(`/api/v1/meetings/${encodeURIComponent(id)}/end`, { method: 'POST' })).meeting;
  },
  async getAttendance(id) {
    return request(`/api/v1/meetings/${encodeURIComponent(id)}/attendance`);
  },
  async getChat(id) {
    return request(`/api/v1/meetings/${encodeURIComponent(id)}/chat`);
  },
  async getArtifacts(id) {
    return (await request(`/api/v1/meetings/${encodeURIComponent(id)}/artifacts`)).artifacts;
  },
  async getArtifactUrl(id) {
    return request(`/api/v1/artifacts/${encodeURIComponent(id)}/url`);
  },
  async getProcessing(id) {
    return request(`/api/v1/meetings/${encodeURIComponent(id)}/processing`);
  },
  async retryProcessing(id, kind = 'all') {
    return request(`/api/v1/meetings/${encodeURIComponent(id)}/processing/retry`, {
      method: 'POST',
      body: { kind },
    });
  },
};

module.exports = { api, ApiError };
