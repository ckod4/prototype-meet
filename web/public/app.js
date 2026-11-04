(() => {
  'use strict';

  document.querySelectorAll('[data-copy-target]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.getAttribute('data-copy-target') || '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        const previous = button.textContent;
        button.textContent = 'Copié';
        window.setTimeout(() => { button.textContent = previous; }, 1600);
      } catch {
        // Fallback pour les navigateurs sans API clipboard en contexte non sécurisé.
        const input = button.closest('.copy-row')?.querySelector('input');
        if (input) {
          input.focus();
          input.select();
          document.execCommand('copy');
          button.textContent = 'Copié';
          window.setTimeout(() => { button.textContent = 'Copier'; }, 1600);
        }
      }
    });
  });

  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      const message = form.getAttribute('data-confirm') || 'Confirmer cette action ?';
      if (!window.confirm(message)) event.preventDefault();
    });
  });
})();
