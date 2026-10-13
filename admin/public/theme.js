// Loaded as a plain blocking script from index.html so a stored theme choice
// is on <html> before the first paint (no flash of the other theme). Without
// a stored choice nothing is set and the stylesheet follows the system.
(function () {
  try {
    var stored = localStorage.getItem('pokyh_admin_theme');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {
    // storage unavailable: keep following the system
  }
})();
