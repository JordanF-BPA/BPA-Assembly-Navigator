(() => {
  'use strict';
  const key = 'bpa-helper-reminder-v1';
  const memberLock = key + '-open';
  const listeners = new Set();
  let current = null, release = null, active = false, generation = 0;
  let dismissed = false;
  const read = () => {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return typeof value?.id === 'string' && typeof value.dismissed === 'boolean' ? value : null;
    } catch (_) { return null; }
  };
  function notify(value) {
    dismissed = value;
    for (const listener of listeners) listener(value);
  }
  const session = window.bpaHelperReminderSession = {
    ready: Promise.resolve(),
    get dismissed() { return dismissed; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async dismiss() {
      await session.ready;
      notify(true);
      if (!current) return;
      current = {...current, dismissed: true};
      try { localStorage.setItem(key, JSON.stringify(current)); } catch (_) { /* page-only fallback */ }
    }
  };
  async function join() {
    active = true;
    const ownGeneration = ++generation;
    try {
      if (!navigator.locks) return;
      // Serialize membership checks so simultaneous first tabs cannot reset one another.
      await navigator.locks.request(key + '-join', async () => {
        if (!active || generation !== ownGeneration) return;
        const locks = await navigator.locks.query();
        const anotherPage = locks.held.some(lock => lock.name === memberLock);
        let saved = read();
        // Carry dismissal through F5, but not a newly opened/restored browser session.
        const reload = performance.getEntriesByType('navigation')[0]?.type === 'reload';
        let sameReload = false;
        try { sameReload = reload && saved?.id === sessionStorage.getItem(key); } catch (_) { }
        if (!saved || (!anotherPage && !sameReload)) {
          saved = {id: crypto.randomUUID(), dismissed: false};
        }
        // Test storage before relying on it for cross-tab coordination.
        localStorage.setItem(key, JSON.stringify(saved));
        current = saved;
        try { sessionStorage.setItem(key, saved.id); } catch (_) { }
        await new Promise((resolve, reject) => {
          navigator.locks.request(memberLock, {mode: 'shared'}, () => {
            if (!active || generation !== ownGeneration) { resolve(); return; }
            return new Promise(done => { release = done; resolve(); });
          }).catch(reject);
        });
        if (active && generation === ownGeneration) {
          const latest = read();
          if (latest?.id === current.id) current = latest;
          notify(current.dismissed);
        }
      });
    } catch (_) {
      // Privacy restrictions must never block navigation or the local No button.
      current = null;
    }
  }
  window.addEventListener('storage', event => {
    if (event.key !== key || !active || !current) return;
    const saved = read();
    if (saved?.id === current.id) { current = saved; notify(saved.dismissed); }
  });
  window.addEventListener('pagehide', () => {
    active = false;
    generation++;
    release?.();
    release = null;
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) session.ready = join();
  });
  session.ready = join();
})();
