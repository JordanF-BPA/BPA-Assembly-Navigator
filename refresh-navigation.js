(() => {
  'use strict';
  const KEY = 'BPA_VIEWER_REFRESH_V1';
  const MAX_AGE = 12 * 60 * 60 * 1000;
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  const target = value => typeof value === 'string' &&
    (/^pos-((?:[0-9a-f]{2}){1,316})-([1-9]\d{0,8})$/.test(value) ||
     /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
  function remember(projectId, modelId, guid) {
    if (!id(projectId) || !id(modelId) || !target(guid)) return false;
    try {
      const value = JSON.stringify({projectId, modelId, guid, savedAt:Date.now()});
      sessionStorage.setItem(KEY,value);
      return sessionStorage.getItem(KEY) === value;
    } catch (_) { return false; }
  }
  function read(projectId, models) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY));
      if (!saved || saved.projectId !== projectId || !id(saved.projectId) || !id(saved.modelId) ||
          !target(saved.guid) || !Number.isFinite(saved.savedAt) || saved.savedAt > Date.now() ||
          Date.now() - saved.savedAt > MAX_AGE) return null;
      // A different loaded model must not inherit this drawing's selection.
      // An empty list is allowed while Connect is still loading the saved model;
      // normal automatic navigation waits for that exact model to be available.
      if (Array.isArray(models) && models.length && !models.some(model =>
          (model.id || model.modelId || model.versionId) === saved.modelId)) return null;
      return saved;
    } catch (_) { return null; }
  }
  function refresh(projectId, modelId) {
    if (!id(projectId) || !id(modelId)) throw Error('Wait for the Connect model to finish loading, then try again.');
    const saved = read(projectId,[{id:modelId}]);
    if (saved && !remember(saved.projectId,saved.modelId,saved.guid))
      throw Error('The drawing could not be saved for refresh. Allow site storage and try again.');
    // Connect blocks top-frame navigation. Load a fresh, narrowly matched page
    // so a newly re-enabled helper can attach and reload its own tab via tabs API.
    return new Promise((resolve,reject) => {
      const requestId = crypto.randomUUID();
      const frame = document.createElement('iframe');
      const url = new URL('https://jordanf-bpa.github.io/BPA-Assembly-Navigator/helper-refresh.html');
      url.search = new URLSearchParams({requestId,projectId,modelId}).toString();
      frame.hidden = true;
      frame.title = 'BPA helper refresh connection';
      let timer, finished = false;
      function finish(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        window.removeEventListener('message',receive);
        frame.remove();
        if (error) reject(error); else resolve();
      }
      function receive(event) {
        if (event.origin !== url.origin || event.source !== frame.contentWindow ||
            event.data?.type !== 'bpa-refresh-result' || event.data.requestId !== requestId) return;
        finish(event.data.ok === true ? null : Error(event.data.error || 'The helper could not reload this tab.'));
      }
      window.addEventListener('message',receive);
      timer = setTimeout(() => finish(Error('Enable BPA Navigator helper version 1.3.0 or newer, then try again. If you still have an older version, update it or press F5; your saved drawing will be restored.')),8000);
      frame.onerror = () => finish(Error('The helper connection page could not load. Press F5 to refresh Connect and restore your saved drawing.'));
      frame.src = url.href;
      try { document.body.appendChild(frame); } catch (error) { finish(error); }
    });
  }
  window.bpaRefreshNavigation = {remember,read,refresh};
})();
