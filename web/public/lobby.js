(() => {
  'use strict';

  const root = document.body;
  const sessionToken = root.dataset.sessionToken;
  const apiBase = root.dataset.apiBase || '/room-api';
  const statusEl = document.getElementById('lobby-status');
  let stopped = false;
  let controller = null;
  let retryDelay = 2000;

  function showTerminal(message) {
    stopped = true;
    if (controller) controller.abort();
    if (!statusEl) return;
    statusEl.textContent = message;
    const link = document.createElement('a');
    link.href = '/dashboard';
    link.className = 'button button--small';
    link.textContent = 'Retour à mes réunions';
    statusEl.insertAdjacentElement('afterend', link);
  }

  function handle(name, payload) {
    if (name === 'ready') {
      const status = payload.status || {};
      if (status.admission_status === 'admitted') {
        window.location.reload();
        return;
      }
      if (status.admission_status === 'rejected') {
        showTerminal("Votre demande d'admission a été refusée.");
        return;
      }
      if (status.phase && status.phase !== 'open') {
        window.location.reload();
      }
      return;
    }
    if (name !== 'meeting-event') return;
    const { type, data = {} } = payload;
    if (type === 'admission.updated') {
      if (data.status === 'admitted') {
        window.location.reload();
      } else if (data.status === 'rejected') {
        showTerminal("Votre demande d'admission a été refusée.");
      }
      return;
    }
    if (type === 'participant.excluded') {
      showTerminal('Vous avez été exclu de cette réunion.');
      return;
    }
    if (type === 'meeting.ended' || type === 'meeting.cancelled') {
      window.location.reload();
    }
  }

  async function readStream(response) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let eventName = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length) {
          try {
            handle(eventName, JSON.parse(dataLines.join('\n')));
          } catch {
            // ignore payload mal formé
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  async function connect() {
    if (stopped) return;
    controller = new AbortController();
    try {
      const response = await fetch(`${apiBase}/session/stream`, {
        headers: { authorization: `Bearer ${sessionToken}`, accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (response.status === 403) {
        showTerminal('Vous avez été exclu de cette réunion.');
        return;
      }
      if (response.status === 410) {
        showTerminal("Votre demande d'admission a été refusée.");
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      retryDelay = 2000;
      await readStream(response);
      if (!stopped) throw new Error('flux interrompu');
    } catch (error) {
      if (stopped || error.name === 'AbortError') return;
      if (statusEl) statusEl.textContent = 'Connexion momentanément indisponible. Reconnexion…';
      window.setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    }
  }

  connect();
  window.addEventListener('pagehide', () => {
    stopped = true;
    if (controller) controller.abort();
  });
})();
