(() => {
  'use strict';
  const panel = document.getElementById('helperInstall');
  const status = document.getElementById('helperInstallStatus');
  const recheck = document.getElementById('helperRecheck');
  if (!panel || !status || !recheck) return;
  let requestId, retry, timeout;
  function clearTimers() {
    clearTimeout(retry);
    clearTimeout(timeout);
  }
  function sendProbe() {
    // Existing helpers (1.2.6+) answer this event after contacting their worker.
    // A null session is still a valid answer when outside a Connect frame.
    document.dispatchEvent(new CustomEvent('bpa-model-session-request', {detail: requestId}));
  }
  document.addEventListener('bpa-model-session-result', event => {
    let result;
    try { result = JSON.parse(event.detail); } catch (_) { return; }
    if (!requestId || result?.requestId !== requestId ||
        !Object.prototype.hasOwnProperty.call(result, 'session')) return;
    clearTimers();
    requestId = null;
    panel.hidden = true;
    recheck.disabled = false;
  });
  function check() {
    clearTimers();
    requestId = 'helper-install-' + crypto.randomUUID();
    recheck.disabled = true;
    status.textContent = 'Checking for the BPA Navigator helper…';
    retry = setTimeout(sendProbe, 800);
    timeout = setTimeout(() => {
      panel.hidden = false;
      recheck.disabled = false;
      status.textContent = 'The helper hasn’t responded in this browser. It may be missing, disabled, or need a refresh.';
      // Keep listening so a late valid response also removes the notice.
    }, 3000);
    sendProbe();
  }
  recheck.addEventListener('click', check);
  window.addEventListener('pagehide', clearTimers);
  window.addEventListener('pageshow', event => { if (event.persisted) check(); });
  check();
})();
