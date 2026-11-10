// Classic script, loaded before the stylesheets: sets data-theme before first paint
// so there is no flash. The same keys are used by lib/theme.js.
(function () {
  var theme = null;
  try { theme = localStorage.getItem('kosmos-review-theme'); } catch (e) { /* storage blocked */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
