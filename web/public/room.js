/* global JitsiMeetExternalAPI */
(() => {
  'use strict';

  const root = document.body;
  const data = root.dataset;
  const roomName = data.room;
  const sessionToken = data.sessionToken;
  const apiBase = data.apiBase || '/room-api';
  const jwt = data.jwt;
  const ownSessionId = data.sessionId || '';
  const warningMinutes = Number(data.warningMinutes || 3);
  const role = data.role;
  const displayName = data.displayName;
  const transcriptionEnabled = data.transcription === '1';
  const recordingEnabled = data.recording === '1';
  let endsAt = new Date(data.endsAt).getTime();
  let chatEnabled = data.chat === '1';
  let waitingMode = data.waitingRoom === '1';

  const warningEl = document.getElementById('end-warning');
  const captureNotice = document.getElementById('capture-notice');
  const leaveOverlay = document.getElementById('leave-overlay');
  const leaveMessage = document.getElementById('leave-message');
  const recordingChip = document.getElementById('recording-chip');
  const rejoinButton = document.getElementById('rejoin-button');

  const authHeaders = {
    authorization: `Bearer ${sessionToken}`,
    'content-type': 'application/json',
  };

  let api = null;
  let serverOffsetMs = 0;
  let ending = false;
  let left = false;
  let heartbeatTimer = null;
  let watchTimer = null;
  let warningShown = false;
  let streamController = null;
  let streamRetryTimer = null;
  let streamRetryDelay = 2000;
  let localAudioMuted = false;
  let localVideoMuted = false;
  let screenSharing = false;
  let chatOpen = false;
  let lastMediaNoticeAt = 0;
  let joinedConfirmed = false;

  let mediaPolicy = {
    audio_allowed: true,
    video_allowed: true,
    screen_allowed: true,
  };

  // Capture audio locale pour une transcription nominative fiable.
  let recorder = null;
  let mediaStream = null;
  let captureStartedAt = 0;
  let chunkIndex = 0;
  let uploadChain = Promise.resolve();
  let captureFailed = false;
  let captureMuted = false;
  let muteStartedAt = null;
  const muteIntervals = [];

  function serverNow() {
    return Date.now() + serverOffsetMs;
  }

  function notify(message, tone = 'info') {
    if (!captureNotice) return;
    captureNotice.hidden = false;
    captureNotice.dataset.tone = tone;
    captureNotice.textContent = message;
    window.setTimeout(() => {
      if (captureNotice.textContent === message) captureNotice.hidden = true;
    }, 8000);
  }

  function updateRecordingState(state) {
    if (!recordingChip) return;
    const label = recordingChip.lastChild;
    recordingChip.classList.remove('is-live');
    if (state === 'active') {
      recordingChip.classList.add('is-live');
      if (label) label.textContent = 'Enregistrement en cours';
    } else if (state === 'failed') {
      if (label) label.textContent = 'Enregistrement indisponible';
    } else if (state === 'pending') {
      if (label) label.textContent = 'Démarrage de l’enregistrement';
    } else if (state === 'stopped') {
      if (label) label.textContent = 'Enregistrement terminé';
    }
    if (!api) return;
    try {
      if (state === 'active') {
        api.executeCommand('showNotification', {
          title: 'Enregistrement en cours',
          description: 'Cette réunion est enregistrée. L’indicateur reste visible pendant toute la captation.',
          uid: 'pm-recording-indicator',
          type: 'warning',
          timeout: 'sticky',
        });
      } else if (state === 'pending') {
        api.executeCommand('showNotification', {
          title: 'Enregistrement',
          description: 'Démarrage de l’enregistrement de la réunion.',
          uid: 'pm-recording-indicator',
          type: 'normal',
          timeout: 'sticky',
        });
      } else {
        api.executeCommand('hideNotification', 'pm-recording-indicator');
      }
    } catch {
      // L'API Jitsi peut ne pas être encore prête.
    }
  }

  async function postEvent(payload) {
    try {
      const response = await fetch(`${apiBase}/session/events`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  }

  let leaveSent = false;
  function sendLeave() {
    if (leaveSent) return;
    leaveSent = true;
    const body = JSON.stringify({ type: 'left' });
    // sendBeacon ne permet pas d'en-tête d'autorisation. On garde fetch keepalive.
    fetch(`${apiBase}/session/events`, { method: 'POST', headers: authHeaders, body, keepalive: true }).catch(() => {});
    left = true;
  }

  function elapsedSeconds() {
    return Math.max(0, (Date.now() - captureStartedAt) / 1000);
  }

  function recordMuteState(isMuted) {
    if (!captureStartedAt) {
      captureMuted = isMuted;
      return;
    }
    if (isMuted && !captureMuted) {
      captureMuted = true;
      muteStartedAt = elapsedSeconds();
    } else if (!isMuted && captureMuted) {
      captureMuted = false;
      if (muteStartedAt !== null) {
        muteIntervals.push({ start: muteStartedAt, end: elapsedSeconds() });
        muteStartedAt = null;
      }
    }
  }

  async function uploadChunk(blob, index) {
    const headers = {
      authorization: `Bearer ${sessionToken}`,
      'content-type': blob.type || 'audio/webm',
      'x-capture-index': String(index),
      'x-capture-mime': blob.type || 'audio/webm',
    };
    if (index === 0) headers['x-capture-started-at'] = new Date(captureStartedAt).toISOString();
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`${apiBase}/session/capture`, {
          method: 'POST',
          headers,
          body: blob,
        });
        if (response.ok) return true;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
    }
    captureFailed = true;
    notify("La capture audio pour la transcription s'est interrompue.", 'warn');
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* ignore */ }
    }
    return false;
  }

  function flushMuteInterval() {
    if (captureMuted && muteStartedAt !== null) {
      muteIntervals.push({ start: muteStartedAt, end: elapsedSeconds() });
      muteStartedAt = null;
    }
  }

  async function completeCapture() {
    flushMuteInterval();
    const intervals = muteIntervals.slice(0, 500).map((interval) => ({
      start: Math.round(interval.start * 10) / 10,
      end: Math.round(interval.end * 10) / 10,
    }));
    await postEvent({ type: 'capture_complete', mute_intervals: intervals });
  }

  async function startCapture() {
    if (!transcriptionEnabled || recorder || captureFailed) return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      const mimeType = candidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || '';
      const options = { audioBitsPerSecond: 32000 };
      if (mimeType) options.mimeType = mimeType;
      recorder = new MediaRecorder(mediaStream, options);
      captureStartedAt = Date.now();
      chunkIndex = 0;
      notify("Capture audio active pour la transcription de la réunion.", 'info');
      recorder.addEventListener('dataavailable', (event) => {
        if (captureFailed || !event.data || event.data.size === 0) return;
        const index = chunkIndex;
        chunkIndex += 1;
        uploadChain = uploadChain.then(() => uploadChunk(event.data, index));
      });
      recorder.addEventListener('stop', () => {
        uploadChain = uploadChain.then(() => completeCapture()).catch(() => {});
      });
      recorder.start(20000);
      if (captureMuted) muteStartedAt = 0;
    } catch (error) {
      captureFailed = true;
      notify('Micro non accessible pour la transcription. Votre voix pourrait manquer dans le compte rendu.', 'warn');
      console.warn('Capture audio indisponible', error);
    }
  }

  function stopCapture() {
    if (!recorder) return;
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      // ignore
    }
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) track.stop();
    }
    recorder = null;
    mediaStream = null;
  }

  function updateWarning() {
    if (ending) return;
    const remaining = Math.max(0, endsAt - serverNow());
    const warnAt = warningMinutes * 60_000;
    if (remaining <= warnAt && remaining > 0) {
      warningShown = true;
      warningEl.hidden = false;
      const minutes = Math.ceil(remaining / 60_000);
      warningEl.textContent = minutes <= 1
        ? 'La réunion se termine dans moins d’une minute. Pensez à conclure.'
        : `La réunion se termine dans ${minutes} minutes. Pensez à conclure.`;
    }
    if (remaining <= 0) finish('ended');
  }

  function stopStream() {
    if (streamRetryTimer) {
      window.clearTimeout(streamRetryTimer);
      streamRetryTimer = null;
    }
    if (streamController) {
      streamController.abort();
      streamController = null;
    }
  }

  function finish(reason) {
    if (ending) return;
    ending = true;
    stopStream();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    stopCapture();
    sendLeave();
    if (leaveOverlay) leaveOverlay.hidden = true;
    warningEl.hidden = false;
    warningEl.textContent = {
      cancelled: 'La réunion a été annulée. La session va se fermer.',
      excluded: 'Un organisateur vous a exclu de cette réunion. La session va se fermer.',
      rejected: "Votre demande d'admission a été refusée. La session va se fermer.",
      session_replaced: 'Votre session a été remplacée par votre accès organisateur. La salle va se recharger.',
      ended: 'Le créneau est terminé. La session va se fermer.',
    }[reason] || 'La réunion se termine. La session va se fermer.';
    if (api) {
      try { api.executeCommand('hangup'); } catch { /* ignore */ }
      window.setTimeout(() => {
        try { api.dispose(); } catch { /* ignore */ }
        window.location.replace(window.location.pathname);
      }, 1500);
    } else {
      window.location.replace(window.location.pathname);
    }
  }

  function enforceMediaPolicy(source) {
    if (!api) return;
    const now = Date.now();
    if (!mediaPolicy.audio_allowed && !localAudioMuted) {
      try { api.executeCommand('toggleAudio'); } catch { /* ignore */ }
      if (now - lastMediaNoticeAt > 2000) {
        notify('Votre micro a été coupé par un organisateur.', 'warn');
        lastMediaNoticeAt = now;
      }
    }
    if (!mediaPolicy.video_allowed && !localVideoMuted) {
      try { api.executeCommand('toggleVideo'); } catch { /* ignore */ }
      if (now - lastMediaNoticeAt > 2000) {
        notify('Votre caméra a été coupée par un organisateur.', 'warn');
        lastMediaNoticeAt = now;
      }
    }
    if (!mediaPolicy.screen_allowed && screenSharing) {
      try { api.executeCommand('toggleShareScreen'); } catch { /* ignore */ }
      if (now - lastMediaNoticeAt > 2000) {
        notify('Votre partage d’écran a été arrêté par un organisateur.', 'warn');
        lastMediaNoticeAt = now;
      }
    }
    if (source === 'policy') {
      // Le message est déjà affiché par le bloc concerné.
    }
  }

  function applyChatPolicy() {
    const toggle = document.getElementById('chat-toggle');
    if (toggle) toggle.textContent = chatEnabled ? 'Désactiver le chat' : 'Activer le chat';
    if (!chatEnabled && chatOpen && api) {
      try { api.executeCommand('toggleChat'); } catch { /* ignore */ }
    }
  }

  function initJitsi() {
    const options = {
      roomName,
      parentNode: document.getElementById('jitsi-container'),
      jwt,
      lang: 'fr',
      configOverwrite: {
        prejoinConfig: { enabled: false },
        prejoinPageEnabled: false,
        requireDisplayName: false,
        disableDeepLinking: true,
        defaultLanguage: 'fr',
        startWithAudioMuted: false,
        startWithVideoMuted: false,
        channelLastN: 30,
        disableProfile: true,
        disablePrivateChat: true,
        disableChat: !chatEnabled,
        disableRemoteMute: false,
        disableGrantModerator: true,
        hideConferenceSubject: true,
        hideConferenceTimer: false,
        notifications: [],
        recordingService: {
          enabled: recordingEnabled,
          sharingEnabled: false,
          hideStorageWarning: true,
        },
        fileRecordingsEnabled: recordingEnabled,
        liveStreamingEnabled: false,
        toolbarButtons: [
          'microphone', 'camera', 'desktop', 'chat', 'raisehand', 'participants-pane',
          'tileview', 'fullscreen', 'hangup', 'settings', 'select-background',
          'noisesuppression', 'stats', 'shortcuts', 'filmstrip', 'toggle-camera',
        ].filter((button) => chatEnabled || button !== 'chat'),
      },
      interfaceConfigOverwrite: {
        SHOW_JITSI_WATERMARK: false,
        SHOW_WATERMARK_FOR_GUESTS: false,
        SHOW_BRAND_WATERMARK: false,
        MOBILE_APP_PROMO: false,
        DEFAULT_BACKGROUND: '#0b0d12',
        DISABLE_JOIN_LEAVE_NOTIFICATIONS: false,
        HIDE_INVITE_MORE_HEADER: true,
        TOOLBAR_BUTTONS: [
          'microphone', 'camera', 'closedcaptions', 'desktop', 'embedmeeting', 'fullscreen',
          'fodeviceselection', 'hangup', 'profile', 'chat', 'livestreaming',
          'etherpad', 'sharedvideo', 'settings', 'raisehand', 'videoquality', 'filmstrip',
          'invite', 'feedback', 'stats', 'shortcuts', 'tileview', 'select-background',
          'download', 'help', 'mute-everyone', 'security',
        ].filter((button) => chatEnabled || button !== 'chat'),
      },
    };
    api = new JitsiMeetExternalAPI(data.jitsiDomain, options);
    if (api.iframe) {
      api.iframe.allow = 'camera; microphone; display-capture; fullscreen; autoplay; clipboard-write';
      api.iframe.setAttribute('allowfullscreen', 'true');
    }

    api.addEventListener('videoConferenceJoined', async () => {
      const result = await postEvent({ type: 'joined' });
      if (!result) {
        notify("Impossible d'enregistrer votre présence. Vérifiez votre connexion.", 'warn');
        return;
      }
      if (result.phase && result.phase !== 'open') {
        finish(result.phase);
        return;
      }
      joinedConfirmed = true;
      await startCapture();
      updateRecordingState(data.recordingState || 'idle');
      enforceMediaPolicy('initial');
      if (role === 'organizer') loadModeration();
    });

    api.addEventListener('videoConferenceLeft', () => {
      if (ending) return;
      stopCapture();
      sendLeave();
      stopStream();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (leaveOverlay) leaveOverlay.hidden = false;
    });

    api.addEventListener('audioMuteStatusChanged', (event) => {
      localAudioMuted = Boolean(event?.muted);
      recordMuteState(localAudioMuted);
      if (!mediaPolicy.audio_allowed && !localAudioMuted) enforceMediaPolicy('audio-event');
    });

    api.addEventListener('videoMuteStatusChanged', (event) => {
      localVideoMuted = Boolean(event?.muted);
      if (!mediaPolicy.video_allowed && !localVideoMuted) enforceMediaPolicy('video-event');
    });

    api.addEventListener('screenSharingStatusChanged', (event) => {
      screenSharing = Boolean(event?.on);
      if (!mediaPolicy.screen_allowed && screenSharing) enforceMediaPolicy('screen-event');
    });

    api.addEventListener('chatUpdated', (event) => {
      chatOpen = Boolean(event?.isOpen);
      if (chatOpen && !chatEnabled) {
        try { api.executeCommand('toggleChat'); } catch { /* ignore */ }
        notify('Le chat est désactivé par un organisateur.', 'warn');
      }
    });

    api.addEventListener('incomingMessage', (event) => {
      if (!event || event.privateMessage || !chatEnabled) return;
      const text = String(event.message || '').trim();
      if (!text) return;
      const isOwnEcho = event.nick === displayName
        && recentOwn.some((own) => own.text === text && Date.now() - own.at < 15000);
      if (isOwnEcho) {
        recentOwn = recentOwn.filter((own) => !(own.text === text && Date.now() - own.at < 15000));
        return;
      }
      postEvent({
        type: 'chat',
        text,
        nick: event.nick || '',
        message_id: event.messageId || null,
        private: false,
      });
    });

    api.addEventListener('outgoingMessage', (event) => {
      if (!chatEnabled) {
        notify('Le chat est désactivé par un organisateur.', 'warn');
        return;
      }
      const text = String(event?.message || '').trim();
      if (!text) return;
      recentOwn.push({ text, at: Date.now() });
      if (recentOwn.length > 20) recentOwn.shift();
      postEvent({ type: 'chat', text, nick: displayName, private: false });
    });

    api.addEventListener('readyToClose', () => {
      if (!ending && leaveOverlay) leaveOverlay.hidden = false;
    });
  }

  let recentOwn = [];

  if (rejoinButton) rejoinButton.addEventListener('click', () => window.location.reload());

  window.addEventListener('pagehide', () => {
    stopStream();
    stopCapture();
    sendLeave();
  });

  window.addEventListener('beforeunload', () => {
    sendLeave();
  });

  // -------------------------------------------------------------------------
  // Flux d'événements (SSE via fetch pour conserver l'en-tête Authorization)
  // -------------------------------------------------------------------------

  async function readEventStream(response) {
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
            handleStreamEvent(eventName, JSON.parse(dataLines.join('\n')));
          } catch {
            // Un événement mal formé ne doit pas couper la salle.
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  async function connectStream() {
    if (ending || left) return;
    streamController = new AbortController();
    try {
      const response = await fetch(`${apiBase}/session/stream`, {
        headers: { authorization: `Bearer ${sessionToken}`, accept: 'text/event-stream' },
        signal: streamController.signal,
      });
      if (!response.ok) {
        if (response.status === 403) finish('excluded');
        else if (response.status === 410) finish('ended');
        else if ([401, 404].includes(response.status)) finish('ended');
        else throw new Error(`HTTP ${response.status}`);
        return;
      }
      streamRetryDelay = 2000;
      await readEventStream(response);
      if (!ending && !left) throw new Error('flux interrompu');
    } catch (error) {
      if (ending || left || error.name === 'AbortError') return;
      streamRetryTimer = window.setTimeout(connectStream, streamRetryDelay);
      streamRetryDelay = Math.min(streamRetryDelay * 2, 15000);
    }
  }

  function handleStreamEvent(name, payload) {
    if (name === 'ready') {
      const status = payload.status || {};
      if (status.server_now) serverOffsetMs = new Date(status.server_now).getTime() - Date.now();
      if (status.ends_at) endsAt = new Date(status.ends_at).getTime();
      if (status.media) {
        mediaPolicy = status.media;
        enforceMediaPolicy('initial');
      }
      if (typeof status.chat === 'boolean') {
        chatEnabled = status.chat;
        applyChatPolicy();
      }
      if (typeof status.waiting_room === 'boolean') waitingMode = status.waiting_room;
      if (status.recording_state) updateRecordingState(status.recording_state);
      if (status.phase && status.phase !== 'open') finish(status.phase);
      if (status.admission_status === 'rejected') finish('rejected');
      return;
    }
    if (name !== 'meeting-event') return;
    const { type, data: eventData = {} } = payload;
    if (type === 'meeting.ended') return finish('ended');
    if (type === 'meeting.cancelled') return finish('cancelled');
    if (type === 'meeting.updated') {
      if (typeof eventData.chat === 'boolean') {
        chatEnabled = eventData.chat;
        applyChatPolicy();
        if (!chatEnabled) notify('Le chat a été désactivé par un organisateur.', 'warn');
      }
      if (typeof eventData.waiting_room === 'boolean') waitingMode = eventData.waiting_room;
      if (role === 'organizer') scheduleModerationRefresh();
      return;
    }
    if (type === 'recording.updated') {
      updateRecordingState(eventData.state);
      if (eventData.state === 'failed') notify("L'enregistrement n'a pas pu démarrer.", 'warn');
      return;
    }
    if (type === 'media.policy' && eventData.session_id === ownSessionId) {
      if (role !== 'participant') return;
      mediaPolicy = { ...mediaPolicy, [`${eventData.media}_allowed`]: eventData.allowed };
      enforceMediaPolicy('policy');
      return;
    }
    if (type === 'media.broadcast') {
      if (role !== 'participant') return;
      mediaPolicy = { ...mediaPolicy, [`${eventData.media}_allowed`]: eventData.allowed };
      enforceMediaPolicy('broadcast');
      if (!eventData.allowed) {
        const labels = { audio: 'micros', video: 'caméras', screen: 'partages d’écran' };
        notify(`Un organisateur a coupé les ${labels[eventData.media] || 'médias'}.`, 'warn');
      }
      return;
    }
    if (type === 'participant.excluded' && eventData.session_id === ownSessionId) {
      return finish('excluded');
    }
    if (type === 'session.left' && eventData.session_id === ownSessionId) {
      return finish('session_replaced');
    }
    if (type === 'admission.updated' && eventData.session_id === ownSessionId && eventData.status === 'rejected') {
      return finish('rejected');
    }
    if (role === 'organizer') {
      if (['waiting.updated', 'session.joined', 'session.left', 'admission.updated', 'participant.excluded', 'media.policy'].includes(type)) {
        scheduleModerationRefresh();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Panneau de modération de l'organisateur
  // -------------------------------------------------------------------------

  const moderationPanel = document.getElementById('moderation-panel');
  const participantsList = document.getElementById('participants-list');
  const waitingList = document.getElementById('waiting-list');
  const waitingCount = document.getElementById('waiting-count');
  const waitingCountInline = document.getElementById('waiting-count-inline');
  const moderationMessage = document.getElementById('moderation-message');
  let moderationRefreshTimer = null;
  let moderationLoading = false;

  function moderationNotice(message) {
    if (moderationMessage) moderationMessage.textContent = message;
  }

  function personRow(person, kind) {
    const row = document.createElement('div');
    row.className = 'moderation-person';
    const identity = document.createElement('div');
    identity.className = 'moderation-person__identity';
    const name = document.createElement('strong');
    name.textContent = person.display_name;
    const id = document.createElement('small');
    id.textContent = person.external_id || 'sans identifiant';
    identity.append(name, id);

    const actions = document.createElement('div');
    actions.className = 'moderation-person__actions';
    const sessionId = person.session_id;

    if (kind === 'waiting') {
      const admit = document.createElement('button');
      admit.type = 'button';
      admit.className = 'button button--small';
      admit.textContent = 'Admettre';
      admit.dataset.action = 'admit';
      admit.dataset.sessionId = sessionId;
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'button button--quiet button--small';
      reject.textContent = 'Refuser';
      reject.dataset.action = 'reject';
      reject.dataset.sessionId = sessionId;
      actions.append(admit, reject);
    } else {
      const media = [
        ['audio', 'Micro', person.media?.audio_allowed],
        ['video', 'Caméra', person.media?.video_allowed],
        ['screen', 'Écran', person.media?.screen_allowed],
      ];
      for (const [mediaType, label, allowed] of media) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button button--quiet button--small';
        button.textContent = allowed ? `Couper ${label.toLowerCase()}` : `Autoriser ${label.toLowerCase()}`;
        button.dataset.action = 'set_media';
        button.dataset.sessionId = sessionId;
        button.dataset.media = mediaType;
        button.dataset.allowed = allowed ? '0' : '1';
        actions.append(button);
      }
    }

    const exclude = document.createElement('button');
    exclude.type = 'button';
    exclude.className = 'button button--danger button--small';
    exclude.textContent = 'Exclure';
    exclude.dataset.action = 'exclude';
    exclude.dataset.sessionId = sessionId;
    actions.append(exclude);
    row.append(identity, actions);
    return row;
  }

  function renderModeration(payload) {
    chatEnabled = Boolean(payload.chat);
    waitingMode = Boolean(payload.waiting_room);
    applyChatPolicy();
    const people = payload.participants || [];
    const waiting = payload.waiting || [];
    if (waitingCount) waitingCount.textContent = String(waiting.length);
    if (waitingCountInline) waitingCountInline.textContent = String(waiting.length);

    if (participantsList) {
      participantsList.replaceChildren();
      if (!people.length) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'Aucun participant connecté.';
        participantsList.appendChild(empty);
      } else {
        for (const person of people) participantsList.appendChild(personRow(person, 'active'));
      }
    }
    if (waitingList) {
      waitingList.replaceChildren();
      if (!waiting.length) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = waitingMode ? "Aucun participant en attente." : "La salle d'attente est désactivée.";
        waitingList.appendChild(empty);
      } else {
        for (const person of waiting) waitingList.appendChild(personRow(person, 'waiting'));
      }
    }
    if (payload.banned?.length) {
      const banned = document.createElement('p');
      banned.className = 'muted small';
      banned.textContent = `Exclus de cette réunion : ${payload.banned.map((item) => item.display_name).join(', ')}.`;
      waitingList?.appendChild(banned);
    }
  }

  async function loadModeration() {
    if (role !== 'organizer' || !joinedConfirmed || moderationLoading) return;
    moderationLoading = true;
    try {
      const response = await fetch(`${apiBase}/session/participants`, {
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      renderModeration(await response.json());
    } catch (error) {
      moderationNotice(`Modération indisponible : ${error.message}`);
    } finally {
      moderationLoading = false;
    }
  }

  function scheduleModerationRefresh() {
    if (role !== 'organizer') return;
    if (moderationRefreshTimer) window.clearTimeout(moderationRefreshTimer);
    moderationRefreshTimer = window.setTimeout(() => { loadModeration(); }, 250);
  }

  async function sendModeration(payload) {
    moderationNotice('Application…');
    try {
      const response = await fetch(`${apiBase}/session/moderation`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      moderationNotice('Modification appliquée.');
      await loadModeration();
      return body;
    } catch (error) {
      moderationNotice(error.message);
      return null;
    }
  }

  if (role === 'organizer' && moderationPanel) {
    const toggle = document.getElementById('moderation-toggle');
    const close = document.getElementById('moderation-close');
    const muteAll = document.getElementById('mute-all');
    const chatToggle = document.getElementById('chat-toggle');
    const endMeeting = document.getElementById('end-meeting');
    const admitAll = document.getElementById('waiting-admit-all');

    toggle?.addEventListener('click', () => {
      moderationPanel.hidden = !moderationPanel.hidden;
      if (!moderationPanel.hidden) loadModeration();
    });
    close?.addEventListener('click', () => { moderationPanel.hidden = true; });
    muteAll?.addEventListener('click', () => sendModeration({ action: 'mute_all', media: 'audio' }));
    admitAll?.addEventListener('click', () => sendModeration({ action: 'admit', all: true }));
    chatToggle?.addEventListener('click', () => sendModeration({ action: 'chat', enabled: !chatEnabled }));
    endMeeting?.addEventListener('click', async () => {
      if (!window.confirm('Terminer la réunion pour tous les participants maintenant ?')) return;
      const result = await sendModeration({ action: 'end' });
      if (result) finish('ended');
    });

    const handleAction = (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const sessionId = button.dataset.sessionId;
      const action = button.dataset.action;
      if (action === 'set_media') {
        sendModeration({
          action: 'set_media',
          target_session_id: sessionId,
          media: button.dataset.media,
          allowed: button.dataset.allowed === '1',
        });
      } else if (action === 'exclude') {
        if (!window.confirm('Exclure définitivement ce participant ? Il ne pourra pas revenir avec ce lien.')) return;
        sendModeration({ action: 'exclude', target_session_id: sessionId, reason: '' });
      } else if (action === 'admit') {
        sendModeration({ action: 'admit', session_ids: [sessionId] });
      } else if (action === 'reject') {
        sendModeration({ action: 'reject', target_session_id: sessionId });
      }
    };
    participantsList?.addEventListener('click', handleAction);
    waitingList?.addEventListener('click', handleAction);
  }

  initJitsi();
  connectStream();

  watchTimer = window.setInterval(() => {
    if (ending) return;
    updateWarning();
  }, 1000);

  heartbeatTimer = window.setInterval(() => {
    if (ending) return;
    postEvent({ type: 'heartbeat' }).then((result) => {
      if (!result) return;
      if (result.media) {
        mediaPolicy = result.media;
        enforceMediaPolicy('heartbeat');
      }
      if (result.phase && result.phase !== 'open') finish(result.phase);
    });
  }, 30000);

  void watchTimer;
})();
