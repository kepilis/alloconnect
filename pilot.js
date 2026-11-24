(() => {
  for (const popup of document.querySelectorAll('.pilot-profile')) {
    const summary = popup.querySelector('summary');
    popup.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !popup.open) return;
      event.stopPropagation();
      popup.open = false;
      summary.focus();
    });
    document.addEventListener('pointerdown', event => {
      if (popup.open && !popup.contains(event.target)) popup.open = false;
    });
  }
})();
