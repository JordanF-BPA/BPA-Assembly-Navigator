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
    // Reading/reloading window.top.location is blocked across origins. A user
    // click may navigate the top tab to its validated viewer URL instead. This
    // is a full document navigation, not an SDK/SPA route change.
    window.top.location.href = 'https://web.connect.trimble.com/projects/' +
      encodeURIComponent(projectId) + '/viewer/3d?modelId=' + encodeURIComponent(modelId);
  }
  window.bpaRefreshNavigation = {remember,read,refresh};
})();
