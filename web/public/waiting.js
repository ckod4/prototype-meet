(() => {
  'use strict';

  const openAt = new Date(document.body.dataset.openAt || Date.now()).getTime();
  const counter = document.getElementById('countdown');
  let reloaded = false;

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function reloadOnce() {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  }

  function tick() {
    const remaining = openAt - Date.now();
    if (remaining <= 0) {
      if (counter) counter.textContent = 'Ouverture en cours…';
      reloadOnce();
      return;
    }
    const totalSeconds = Math.ceil(remaining / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (counter) {
      counter.textContent = days > 0
        ? `Ouverture dans ${days} j ${pad(hours)} h ${pad(minutes)} min`
        : `Ouverture dans ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }
    window.setTimeout(tick, 1000);
  }

  tick();

  // Annulation, fin anticipée ou modification du créneau : le serveur pousse
  // l'événement, aucun intervalle HTTP n'est nécessaire.
  const source = new EventSource(`${window.location.pathname}/events`);
  source.addEventListener('meeting-event', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (['meeting.cancelled', 'meeting.ended', 'meeting.updated'].includes(payload.type)) {
        reloadOnce();
      }
    } catch {
      // ignore
    }
  });
  window.addEventListener('pagehide', () => source.close());
})();
