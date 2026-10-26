
/*
 * BPA Assembly Navigator
 * Stage 2D.3B.6 - Ghost Mode Sequence Control
 *
 * Features:
 * - Connect to Trimble Connect
 * - Read selected objects
 * - Resolve Tekla assembly GUID
 * - Show Only Selected Objects
 * - Check native Ghost Mode before isolation
 * - Request native Ghost Mode after isolation
 * - Highlight and zoom to assembly
 * - Automatic URL GUID navigation
 * - Model loading retry
 * - Native Ghost Mode diagnostics
 * - Live presentation change detection
 *
 * Native Ghost Mode is controlled through the
 * Trimble Connect toolbar during this stage.
 */

'use strict';

// ============================================================
// GLOBAL VARIABLES
// ============================================================

let api = null;
let lastAssemblySelector = null;

const el = id => document.getElementById(id);

const validGuid = value =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// ============================================================
// AUTOMATIC NAVIGATION PARAMETERS
// ============================================================

const navigationParams = new URLSearchParams(
  window.location.search
);

const rawIncomingGuid =
  navigationParams.get('teklaGuid') || '';

const incomingGuid = rawIncomingGuid
  .trim()
  .replace(/^["'{\s]+|["'}\s]+$/g, '')
  .trim()
  .toLowerCase();

let autoNavigationPending = validGuid(incomingGuid);
let autoNavigationRunning = false;

const AUTO_NAVIGATION_MAX_ATTEMPTS = 15;
const AUTO_NAVIGATION_RETRY_DELAY = 2000;

const delay = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

// ============================================================
// LOGGING AND STATUS
// ============================================================

const log = (message, value) => {

  const line = message +
    (value === undefined
      ? ''
      : '\n' + JSON.stringify(value, null, 2));

  el('log').textContent =
    line + '\n\n' + el('log').textContent;
};

const status = message => {
  el('status').textContent = message;
};

const run = fn => async () => {

  try {
    await fn();
  }
  catch (error) {
    status('Error: ' + error.message);
    log('ERROR', String(error));
  }
};

// ============================================================
// NATIVE GHOST MODE DIAGNOSTICS
// ============================================================

async function inspectNativeGhostMode(
  label = 'Manual check'
) {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  const presentation =
    await api.viewer.getPresentation();

  const ghostState = presentation?.ghost;

  log('Native Ghost Mode diagnostics', {
    label,
    ghost: ghostState ?? 'Not reported',
    fullPresentation: presentation
  });

  el('ghostMode').checked =
    ghostState === true;

  return ghostState;
}

async function tryInspectNativeGhostMode(label) {

  try {
    return await inspectNativeGhostMode(label);
  }
  catch (error) {

    log('Native Ghost Mode diagnostic failed', {
      label,
      error: error.message
    });

    return undefined;
  }
}

// ============================================================
// CONNECT TO TRIMBLE CONNECT VIEWER
// ============================================================

async function connect() {

  status('Connecting to Trimble Connect viewer...');

  if (!window.TrimbleConnectWorkspace) {
    throw new Error(
      'Trimble Workspace API script did not load.'
    );
  }

  if (!api) {

    api = await window.TrimbleConnectWorkspace.connect(
      window.parent,
      (event, data) => {

        if (event === 'viewer.onSelectionChanged') {
          log('Viewer selection changed', data);
        }

        if (event === 'viewer.onPresentationChanged') {

          log('Viewer presentation changed', data);

          tryInspectNativeGhostMode(
            'Native presentation changed'
          );
        }

      },
      30000
    );
  }

  const project = await api.project.getProject();

  log('Connected to project', {
    id: project?.id,
    name: project?.name
  });

  const models = await api.viewer.getModels();

  const select = el('model');
  const previousModelId = select.value;

  select.replaceChildren();

  for (const model of models || []) {

    const id =
      model.id ||
      model.modelId ||
      model.versionId;

    if (!id) continue;

    const option = document.createElement('option');

    option.value = id;

    option.textContent =
      (model.name || model.fileName || id) +
      ' (' + id + ')';

    select.appendChild(option);
  }

  if (
    previousModelId &&
    Array.from(select.options).some(
      option => option.value === previousModelId
    )
  ) {
    select.value = previousModelId;
  }

  log('Available models', models);

  await tryInspectNativeGhostMode(
    'After connection'
  );

  status('Connected to Trimble Connect viewer.');

  if (autoNavigationPending) {
    await attemptAutoNavigation();
  }
}


 // ============================================================
 // STAGE 2D.3B.7A - GHOST MODE API CAPABILITY INVESTIGATION
 // ============================================================

 async function inspectGhostApiCapabilities() {

   if (!api) {
     throw new Error(
       'Connect to Trimble Connect before running diagnostics.'
     );
   }

   status('Inspecting available Ghost Mode API capabilities...');

   // Only inspect method names and read the presentation.
   // No viewer settings will be changed.

   const getMethodNames = object => {

     if (!object) return [];

     const names = new Set();
     let current = object;
     let depth = 0;

     while (current && depth < 5) {

       try {

         for (const name of Object.getOwnPropertyNames(current)) {

           if (name === 'constructor') continue;

           try {

             if (typeof object[name] === 'function') {
               names.add(name);
             }

           } catch (_) {
             // Ignore inaccessible properties.
           }
         }

       } catch (_) {
         // Ignore inaccessible objects.
       }

       current = Object.getPrototypeOf(current);
       depth++;
     }

     return Array.from(names).sort();
   };

   const viewerMethods = getMethodNames(api.viewer);
   const viewMethods = getMethodNames(api.view);

   const relevantPattern =
     /ghost|present|transparen|visual|display|render|state|command|mode|style/i;

   const relevantViewerMethods =
     viewerMethods.filter(name =>
       relevantPattern.test(name)
     );

   const relevantViewMethods =
     viewMethods.filter(name =>
       relevantPattern.test(name)
     );

   const candidateNames = [
     'setPresentation',
     'updatePresentation',
     'setGhostMode',
     'setGhost',
     'setViewerMode',
     'executeCommand',
     'runCommand',
     'setObjectState',
     'getPresentation'
   ];

   const candidates = candidateNames.map(name => ({
     method: name,
     available:
       typeof api.viewer?.[name] === 'function'
   }));

   let presentation = null;
   let presentationError = null;

   try {

     if (typeof api.viewer.getPresentation === 'function') {

       presentation =
         await api.viewer.getPresentation();

     }

   } catch (error) {

     presentationError = error.message;
   }

   const result = {
     stage: '2D.3B.7A',
     nativeGhostMode: presentation?.ghost ?? 'Not reported',
     candidateMethods: candidates,
     relevantViewerMethods,
     relevantViewMethods,
     allViewerMethods: viewerMethods,
     allViewMethods: viewMethods,
     presentationError
   };

   log('GHOST MODE API CAPABILITY REPORT', result);

   const availableCandidates =
     candidates.filter(item => item.available);

   const possibleSetters =
     availableCandidates.filter(item =>
       item.method !== 'getPresentation' &&
       item.method !== 'setObjectState'
     );

   if (possibleSetters.length > 0) {

     status(
       'Potential API methods detected. ' +
       'Review the diagnostic report before testing.'
     );

   } else {

     status(
       'API inspection complete. No named native Ghost Mode ' +
       'setter detected. Review the diagnostic report.'
     );
   }

   return result;
 }


 // ============================================================
 // STAGE 2D.3B.7B - VIEWER SETTINGS & OPACITY INVESTIGATION
 // READ-ONLY DIAGNOSTICS
 // ============================================================

 async function inspectViewerSettings() {

   if (!api) {
     throw new Error('Connect to Trimble Connect first.');
   }

   status('Reading Trimble Connect viewer settings...');

   const settings =
     await api.viewer.getSettings();

   const presentation =
     await api.viewer.getPresentation();

   const settingsKeys =
     settings && typeof settings === 'object'
       ? Object.keys(settings)
       : [];

   const ghostRelatedKeys =
     settingsKeys.filter(key =>
       /ghost|opacity|transparen|visual|render|display/i.test(key)
     );

   const report = {
     stage: '2D.3B.7B',
     test: 'Viewer Settings',
     nativeGhostMode: presentation?.ghost ?? 'Not reported',
     viewerSettings: settings,
     settingsKeys,
     ghostRelatedKeys,
     documentedSettings: [
       'assemblySelection',
       'zoomToFitRatio'
     ],
     getSettingsAvailable:
       typeof api.viewer.getSettings === 'function',
     setSettingsAvailable:
       typeof api.viewer.setSettings === 'function',
     settingsModified: false
   };

   log('VIEWER SETTINGS DIAGNOSTIC REPORT', report);

   status(
     'Viewer settings read successfully. ' +
     'Review the diagnostic report.'
   );

   return report;
 }

 async function inspectOpacitySupport() {

   if (!api) {
     throw new Error('Connect to Trimble Connect first.');
   }

   status('Inspecting opacity and object-state capabilities...');

   const presentation =
     await api.viewer.getPresentation();

   const settings =
     await api.viewer.getSettings();

   const viewer = api.viewer;

   const report = {
     stage: '2D.3B.7B',
     test: 'Opacity and Object State',
     nativeGhostMode: presentation?.ghost ?? 'Not reported',

     methods: {
       setOpacity:
         typeof viewer.setOpacity === 'function',
       setObjectState:
         typeof viewer.setObjectState === 'function',
       getPresentation:
         typeof viewer.getPresentation === 'function',
       getSettings:
         typeof viewer.getSettings === 'function'
     },

     documentedOpacityRange: {
       minimum: 0,
       maximum: 100,
       parameterName: 'transparency',
       scope: '3D viewer'
     },

     objectSpecificControl: {
       method: 'setObjectState',
       acceptsObjectSelector: true,
       requiresObjectState: true
     },

     presentationProperties:
       presentation && typeof presentation === 'object'
         ? Object.keys(presentation)
         : [],

     settingsProperties:
       settings && typeof settings === 'object'
         ? Object.keys(settings)
         : [],

     methodsInvoked: [
       'getPresentation',
       'getSettings'
     ],

     viewerModified: false
   };

   log('OPACITY SUPPORT DIAGNOSTIC REPORT', report);

   status(
     'Opacity investigation complete. ' +
     'No viewer appearance changes were made.'
   );

   return report;
 }


 // ============================================================
 // STAGE 2D.3B.7C - CONTROLLED TRANSPARENCY TEST
 // ============================================================

 let transparencyTestActive = false;
 let transparencyTestSelector = null;
 let transparencyTestBusy = false;

 async function testAssemblyTransparency() {

   if (!api) {
     throw new Error('Connect to Trimble Connect first.');
   }

   if (transparencyTestBusy) {
     throw new Error('A transparency operation is already running.');
   }

   if (transparencyTestActive) {
     throw new Error(
       'Restore the previous transparency test before starting another.'
     );
   }

   const guid = el('guid').value.trim().toLowerCase();
   const modelId = el('model').value;

   if (!validGuid(guid)) {
     throw new Error('Enter a valid Tekla assembly GUID.');
   }

   if (!modelId) {
     throw new Error('Select a loaded IFC model.');
   }

   transparencyTestBusy = true;

   try {

     status('Resolving assembly for transparency test...');

     const runtimeIds =
       await api.viewer.convertToObjectRuntimeIds(
         modelId,
         [guid]
       );

     const runtimeId = runtimeIds && runtimeIds[0];

     if (!Number.isInteger(runtimeId)) {
       throw new Error('Assembly GUID could not be resolved.');
     }

     const selector = {
       modelObjectIds: [
         {
           modelId,
           objectRuntimeIds: [runtimeId],
           recursive: true
         }
       ]
     };

     const presentationBefore =
       await api.viewer.getPresentation();

     log('TRANSPARENCY TEST - BEFORE', {
       modelId,
       guid,
       runtimeId,
       nativeGhostMode: presentationBefore?.ghost
     });

     // Do not call isolateEntities().
     // We need the surrounding objects to remain visible.

     status('Applying transparency to loaded objects...');

     // Record the test as active before the first appearance
     // change, so Restore remains available if a later call fails.
     transparencyTestActive = true;
     transparencyTestSelector = selector;

await api.viewer.setObjectState(
  undefined,
  {
    opacity: 50
  }
);

     status('Restoring selected assembly to full opacity...');

// Temporarily disabled for opacity testing.
// We first need to confirm that the viewer
// supports transparency through setObjectState().

// await api.viewer.setObjectState(
//   selector,
//   {
//     visible: true,
//     opacity: 1
//   }
// );

     await api.viewer.setSelection(selector, 'set');

     await api.viewer.setCamera(selector);

     const presentationAfter =
       await api.viewer.getPresentation();

     log('TRANSPARENCY TEST - AFTER', {
       modelId,
       guid,
       runtimeId,
       surroundingOpacity: 0.2,
       assemblyOpacity: 1,
       nativeGhostMode: presentationAfter?.ghost,
       testActive: transparencyTestActive
     });

     status(
       'Transparency test applied. Check the model appearance. ' +
       'Use Restore Appearance when finished.'
     );

   } finally {

     transparencyTestBusy = false;
   }
 }

 async function restoreAssemblyAppearance() {

   if (!api) {
     throw new Error('Connect to Trimble Connect first.');
   }

   if (transparencyTestBusy) {
     throw new Error('A transparency operation is already running.');
   }

   if (!transparencyTestActive) {
     status('No active transparency test to restore.');
     return;
   }

   transparencyTestBusy = true;

   try {

     status('Restoring model appearance...');

     // Reset test-wide opacity and visibility.
     // Existing custom appearance overrides may not be
     // recoverable using this generic reset.

     await api.viewer.setObjectState(
       undefined,
       {
         visible: 'reset',
         opacity: 1
       }
     );

     transparencyTestActive = false;
     transparencyTestSelector = null;

     log('TRANSPARENCY TEST - RESTORED', {
       opacityResetTo: 1,
       visibilityReset: true
     });

     status(
       'Test appearance reset. If the original model had ' +
       'custom appearance overrides, reload the viewer to ' +
       'recover those settings.'
     );

   } finally {

     transparencyTestBusy = false;
   }
 }



// ============================================================
// READ CURRENTLY SELECTED OBJECT
// ============================================================

async function readSelected() {

  if (!api) {
    throw new Error('Connect first.');
  }

  const selection =
    await api.viewer.getSelection();

  log('Current viewer selection', selection);

  status('Selection read.');
}

// ============================================================
// FIND, ISOLATE, SELECT AND ZOOM
// ============================================================

async function findAssembly() {

  if (!api) {
    throw new Error('Connect first.');
  }

  const guid =
    el('guid').value.trim().toLowerCase();

  if (!validGuid(guid)) {
    throw new Error(
      'Enter a valid 36-character Tekla assembly GUID.'
    );
  }

  const modelId = el('model').value;

  if (!modelId) {
    throw new Error(
      'Choose a model. Open the IFC in the 3D viewer first.'
    );
  }

  // ==========================================================
  // RESOLVE GUID
  // ==========================================================

  status('Resolving IFC object GUID...');

  const runtimeIds =
    await api.viewer.convertToObjectRuntimeIds(
      modelId,
      [guid]
    );

  log('GUID -> runtime ID result', {
    modelId,
    guid,
    runtimeIds
  });

  const id = runtimeIds && runtimeIds[0];

  if (!Number.isInteger(id)) {
    throw new Error(
      'Assembly GUID not resolved in this model.'
    );
  }

  const selector = {
    modelObjectIds: [
      {
        modelId,
        objectRuntimeIds: [id],
        recursive: true
      }
    ]
  };

  lastAssemblySelector = selector;

  // ==========================================================
  // STEP 1 - CHECK GHOST MODE BEFORE ISOLATION
  // ==========================================================

  const ghostBeforeIsolation =
    await tryInspectNativeGhostMode(
      'Before isolation'
    );

  if (ghostBeforeIsolation === true) {

    status(
      'Turn OFF native Ghost Mode in the ' +
      'Trimble Connect toolbar, then run ' +
      'Isolate, Select & Zoom again.'
    );

    log(
      'Navigation paused: Native Ghost Mode must be OFF'
    );

    return false;
  }

  // ==========================================================
  // STEP 2 - SHOW ONLY SELECTED OBJECTS
  // ==========================================================

  status('Showing only the selected assembly...');

  const isolated =
    await api.viewer.isolateEntities([
      {
        modelId,
        entityIds: [id]
      }
    ]);

  log('Show Only Selected Objects', {
    modelId,
    runtimeId: id,
    result: isolated
  });

  if (isolated !== true) {
    throw new Error(
      'Trimble Connect could not isolate the assembly.'
    );
  }

  // ==========================================================
  // STEP 3 - REQUEST NATIVE GHOST MODE
  // ==========================================================

  const ghostAfterIsolation =
    await tryInspectNativeGhostMode(
      'Immediately after isolation'
    );

  if (ghostAfterIsolation !== true) {

    status(
      'Assembly isolated successfully. ' +
      'Enable native Ghost Mode in the ' +
      'Trimble Connect toolbar.'
    );

    log(
      'Assembly isolated. Native Ghost Mode is OFF.'
    );
  }

  // ==========================================================
  // STEP 4 - HIGHLIGHT ASSEMBLY
  // ==========================================================

  status('Highlighting the assembly...');

  await api.viewer.setSelection(
    selector,
    'set'
  );

  // ==========================================================
  // STEP 5 - ZOOM TO ASSEMBLY
  // ==========================================================

  status('Zooming to the selected assembly...');

  await api.viewer.setCamera(selector);

  // ==========================================================
  // STEP 6 - FINAL GHOST MODE STATUS
  // ==========================================================

  const nativeGhostState =
    await tryInspectNativeGhostMode(
      'Navigation completed'
    );

  if (nativeGhostState === true) {

    status(
      'Assembly isolated, highlighted and zoomed. ' +
      'Native Ghost Mode is ON.'
    );

  } else {

    status(
      'Assembly isolated, highlighted and zoomed. ' +
      'Enable native Ghost Mode in the ' +
      'Trimble Connect toolbar.'
    );
  }

  log('Assembly navigation completed', {
    modelId,
    guid,
    runtimeId: id,
    nativeGhostState
  });

  return true;
}

// ============================================================
// AUTOMATIC ASSEMBLY NAVIGATION
// ============================================================

async function attemptAutoNavigation() {

  if (
    !autoNavigationPending ||
    autoNavigationRunning ||
    !api
  ) {
    return;
  }

  autoNavigationRunning = true;

  try {

    el('guid').value = incomingGuid;

    for (
      let attempt = 1;
      attempt <= AUTO_NAVIGATION_MAX_ATTEMPTS;
      attempt++
    ) {

      status(
        'Automatically locating assembly. Attempt ' +
        attempt + ' of ' +
        AUTO_NAVIGATION_MAX_ATTEMPTS
      );

      try {

        const models =
          await api.viewer.getModels();

        const modelSelect = el('model');
        const previousModelId = modelSelect.value;

        modelSelect.replaceChildren();

        for (const model of models || []) {

          const modelId =
            model.id ||
            model.modelId ||
            model.versionId;

          if (!modelId) continue;

          const option =
            document.createElement('option');

          option.value = modelId;

          option.textContent =
            (model.name || model.fileName || modelId) +
            ' (' + modelId + ')';

          modelSelect.appendChild(option);
        }

        if (
          previousModelId &&
          Array.from(modelSelect.options).some(
            option => option.value === previousModelId
          )
        ) {
          modelSelect.value = previousModelId;
        }

        if (!modelSelect.value) {
          throw new Error(
            'No IFC model available yet.'
          );
        }

        const completed =
          await findAssembly();

        // Ghost Mode was ON before isolation.
        // Stop retries until the user turns it OFF.

        if (completed === false) {

          autoNavigationPending = false;

          log(
            'Automatic navigation paused for Ghost Mode'
          );

          return;
        }

        autoNavigationPending = false;

        status(
          'Automatic assembly navigation completed. ' +
          'Enable native Ghost Mode if required.'
        );

        log('Automatic navigation successful', {
          teklaGuid: incomingGuid,
          modelId: modelSelect.value,
          attempt
        });

        return;

      }
      catch (error) {

        log('Automatic navigation retry', {
          attempt,
          error: error.message
        });

        if (
          attempt === AUTO_NAVIGATION_MAX_ATTEMPTS
        ) {
          throw error;
        }

        await delay(
          AUTO_NAVIGATION_RETRY_DELAY
        );
      }
    }

  }
  catch (error) {

    autoNavigationPending = false;

    status(
      'Automatic navigation failed: ' +
      error.message
    );

    log(
      'Automatic navigation failed',
      String(error)
    );

  }
  finally {

    autoNavigationRunning = false;
  }
}

// ============================================================
// BUTTON EVENT LISTENERS
// ============================================================

el('connect').addEventListener(
  'click',
  run(connect)
);

el('read').addEventListener(
  'click',
  run(readSelected)
);

el('find').addEventListener(
  'click',
  run(findAssembly)
);

// ============================================================
// NATIVE GHOST MODE STATUS INDICATOR
// ============================================================

el('ghostMode').checked = false;
el('ghostMode').disabled = true;

el('inspectGhost').addEventListener(
  'click',
  run(async () => {

    const ghostState =
      await inspectNativeGhostMode(
        'Manual toolbar check'
      );

    status(
      'Native Ghost Mode: ' +
      (ghostState === true
        ? 'ON'
        : ghostState === false
          ? 'OFF'
          : 'Not reported')
    );
  })
);

// ============================================================
// STAGE 2D.3B.7A - DIAGNOSTIC BUTTON
// ============================================================

el('inspectGhostApi').addEventListener(
  'click',
  run(inspectGhostApiCapabilities)
);

// ============================================================
// STAGE 2D.3B.7B - DIAGNOSTIC BUTTONS
// ============================================================

el('inspectViewerSettings').addEventListener(
  'click',
  run(inspectViewerSettings)
);

el('inspectOpacitySupport').addEventListener(
  'click',
  run(inspectOpacitySupport)
);

// ============================================================
// STAGE 2D.3B.7C - TRANSPARENCY TEST BUTTONS
// ============================================================

el('testTransparency').addEventListener(
  'click',
  run(testAssemblyTransparency)
);

el('restoreTransparency').addEventListener(
  'click',
  run(restoreAssemblyAppearance)
);

// ============================================================
// INITIALISE AUTOMATIC NAVIGATION
// ============================================================

if (incomingGuid) {

  if (validGuid(incomingGuid)) {

    el('guid').value = incomingGuid;

    status(
      'Assembly GUID received. Connecting to viewer...'
    );

    log('Navigation URL GUID detected', {
      teklaGuid: incomingGuid
    });

    run(connect)();

  }
  else {

    status(
      'Invalid assembly GUID in navigation URL.'
    );

    log('Invalid navigation GUID', {
      rawGuid: rawIncomingGuid,
      cleanedGuid: incomingGuid,
      guidLength: incomingGuid.length,
      isValid: validGuid(incomingGuid),
      fullUrl: window.location.href
    });
  }
}
