(() => {
  'use strict';
  const panel = document.getElementById('helperInstall');
  const status = document.getElementById('helperInstallStatus');
  const recheck = document.getElementById('helperRecheck');
  if (!panel || !status || !recheck) return;
  let requestId, retry, timeout;
  let viewerApi = null, missing = false, focusRequested = false;
  async function revealInViewer() {
    if (!missing || !viewerApi || focusRequested) return;
    const connectedApi = viewerApi;
    focusRequested = true;
    try {
      const host = await connectedApi.extension.getHost();
      // Never activate Project Explorer or interrupt its handoff into the viewer.
      // Recheck after awaiting: a late helper response cancels the request.
      if (host.name !== '3dviewer' || !missing) {
        focusRequested = false;
        return;
      }
      await connectedApi.extension.requestFocus();
    } catch (_) {
      // A host that rejects focus must not affect assembly navigation.
      // Leave the notice available when Navigator is opened manually.
    }
  }
  // Called only once the app has finished its connection/startup navigation.
  // It does not return a promise for the drawing workflow to wait on.
  window.bpaHelperViewerReady = connectedApi => {
    viewerApi = connectedApi;
    void revealInViewer();
  };
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
    missing = false;
    panel.hidden = true;
    recheck.disabled = false;
  });
  function check() {
    clearTimers();
    missing = false;
    requestId = 'helper-install-' + crypto.randomUUID();
    recheck.disabled = true;
    status.textContent = 'Checking for the BPA Navigator helper…';
    retry = setTimeout(sendProbe, 800);
    timeout = setTimeout(() => {
      panel.hidden = false;
      missing = true;
      recheck.disabled = false;
      status.textContent = 'The helper hasn’t responded in this page. If it is installed and enabled, choose Refresh & check again. Otherwise, install it below.';
      void revealInViewer();
      // Keep listening so a late valid response also removes the notice.
    }, 3000);
    sendProbe();
  }
  recheck.addEventListener('click', () => {
    clearTimers();
    requestId = null;
    recheck.disabled = true;
    status.textContent = 'Refreshing Connect. Your last completed drawing selection will be restored…';
    try {
      if (typeof window.bpaRefreshConnect !== 'function') throw Error('Wait for Navigator to connect, then try again.');
      window.bpaRefreshConnect();
    } catch (error) {
      recheck.disabled = false;
      status.textContent = 'Connect could not refresh: ' + error.message;
    }
  });
  window.addEventListener('pagehide', clearTimers);
  window.addEventListener('pageshow', event => { if (event.persisted) check(); });
  check();
})();
