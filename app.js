
/*
 * BPA Assembly Navigator
 * Stage 2D.3B.4 - Native Ghost Mode Diagnostics
 *
 * Functionality:
 * - Connect to Trimble Connect viewer
 * - Read selected objects
 * - Resolve Tekla assembly GUID to runtime ID
 * - Show Only Selected Objects
 * - Highlight selected assembly
 * - Zoom camera to selected assembly
 * - Automatically receive GUID from extension URL
 * - Automatically connect and navigate
 * - Retry navigation while IFC model loads
 * - Read native Trimble Connect Ghost Mode state
 *
 * Ghost Mode is diagnostic-only in this stage.
 * No access tokens or credentials are stored.
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

console.log('BPA Navigator - URL:', window.location.href);
console.log('BPA Navigator - Raw GUID:', JSON.stringify(rawIncomingGuid));
console.log('BPA Navigator - Cleaned GUID:', JSON.stringify(incomingGuid));
console.log('BPA Navigator - GUID length:', incomingGuid.length);
console.log('BPA Navigator - GUID valid:', validGuid(incomingGuid));


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
// STAGE 2D.3B.4 - NATIVE GHOST MODE DIAGNOSTICS
// ============================================================

async function inspectNativeGhostMode(
  label = 'Manual check'
) {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  status('Reading native viewer presentation...');

  const presentation =
    await api.viewer.getPresentation();

  const ghostState = presentation?.ghost;

  log('Native Ghost Mode diagnostics', {
    label: label,
    ghost: ghostState ?? 'Not reported',
    transparent:
      presentation?.transparent ?? 'Not reported',
    transparencyLevel:
      presentation?.transparencyLevel ?? 'Not reported',
    fullPresentation: presentation
  });

  if (typeof ghostState === 'boolean') {

    el('ghostMode').checked = ghostState;

  } else {

    el('ghostMode').checked = false;
  }

  status(
    'Native Ghost Mode: ' +
    (ghostState === true
      ? 'ON'
      : ghostState === false
        ? 'OFF'
        : 'Not reported')
  );

  return ghostState;
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

      },
      30000
    );
  }

  const project = await api.project.getProject();

  log('Connected to project', {
    id: project?.id,
    name: project?.name
  });

  // ==========================================================
  // READ AVAILABLE MODELS
  // ==========================================================

  const models = await api.viewer.getModels();

  const select = el('model');

  const previousModelId = select.value;

  select.replaceChildren();

  for (const model of models || []) {

    const id =
      model.id ||
      model.modelId ||
      model.versionId;

    if (!id) {
      continue;
    }

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

  log(
    'Available models (inspect identifiers and loading state)',
    models
  );

  status('Connected to Trimble Connect viewer.');

  // Read the native Ghost Mode state on connection.
  // Diagnostic failure must not block navigation.

  try {

    await inspectNativeGhostMode('After connection');

  }
  catch (error) {

    log(
      'Ghost Mode diagnostic unavailable on connection',
      error.message
    );
  }

  // ==========================================================
  // ATTEMPT AUTOMATIC NAVIGATION
  // ==========================================================

  if (autoNavigationPending) {

    await attemptAutoNavigation();
  }
}


// ============================================================
// READ CURRENTLY SELECTED OBJECT
// ============================================================

async function readSelected() {

  if (!api) {
    throw new Error('Connect first.');
  }

  const selection = await api.viewer.getSelection();

  log(
    'Current selection (modelId and objectRuntimeIds)',
    selection
  );

  status(
    'Selection read. Check diagnostics for model and runtime IDs.'
  );
}


// ============================================================
// SAFE NATIVE GHOST MODE DIAGNOSTICS
// ============================================================

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
// FIND, ISOLATE, SELECT AND ZOOM TO ASSEMBLY
// ============================================================

async function findAssembly() {

  if (!api) {
    throw new Error('Connect first.');
  }

  const guid = el('guid').value.trim().toLowerCase();

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
  // RESOLVE GUID TO RUNTIME ID
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
      'Assembly GUID not resolved in this model. ' +
      'Check model selection, IFC version and GUID.'
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
  // STAGE 2D.3B.4 - CHECK GHOST MODE BEFORE ISOLATION
  // ==========================================================

  await tryInspectNativeGhostMode(
    'Before isolation'
  );

  // ==========================================================
  // SHOW ONLY SELECTED OBJECTS
  // ==========================================================

  status('Showing only the selected assembly...');

  const isolated = await api.viewer.isolateEntities([
    {
      modelId: modelId,
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
  // CHECK GHOST MODE AFTER ISOLATION
  // ==========================================================

  await tryInspectNativeGhostMode(
    'After isolation'
  );

  // ==========================================================
  // SELECT AND HIGHLIGHT ASSEMBLY
  // ==========================================================

  status('Highlighting the assembly...');

  await api.viewer.setSelection(
    selector,
    'set'
  );

  // ==========================================================
  // ZOOM CAMERA
  // ==========================================================

  status('Zooming to the selected assembly...');

  await api.viewer.setCamera(selector);

  // ==========================================================
  // CHECK GHOST MODE AFTER SELECTION AND ZOOM
  // ==========================================================

  await tryInspectNativeGhostMode(
    'After selection and zoom'
  );

  // ==========================================================
  // NAVIGATION COMPLETE
  // ==========================================================

  status(
    'Assembly isolated, highlighted and zoomed. ' +
    'Use Trimble Connect toolbar to toggle native Ghost Mode.'
  );

  log('Assembly navigation completed', {
    modelId,
    guid,
    runtimeId: id
  });
}


// ============================================================
// STAGE 2D.3B - AUTOMATIC ASSEMBLY NAVIGATION
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
        attempt + ' of ' + AUTO_NAVIGATION_MAX_ATTEMPTS
      );

      try {

        // ====================================================
        // REFRESH AVAILABLE MODELS
        // ====================================================

        const models = await api.viewer.getModels();

        const modelSelect = el('model');

        const previousModelId = modelSelect.value;

        modelSelect.replaceChildren();

        for (const model of models || []) {

          const modelId =
            model.id ||
            model.modelId ||
            model.versionId;

          if (!modelId) {
            continue;
          }

          const option = document.createElement('option');

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

        // ====================================================
        // RUN EXISTING ASSEMBLY NAVIGATION
        // ====================================================

        await findAssembly();

        autoNavigationPending = false;

        status(
          'Automatic assembly navigation completed. ' +
          'Native Ghost Mode can be toggled in the viewer toolbar.'
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
// STAGE 2D.3B.4 - NATIVE GHOST MODE INSPECTION
// ============================================================

// The checkbox displays the native Ghost Mode state.
// It cannot be clicked during this diagnostic stage.

el('ghostMode').checked = false;
el('ghostMode').disabled = true;

el('inspectGhost').addEventListener(
  'click',
  run(async () => {

    await inspectNativeGhostMode(
      'Manual toolbar check'
    );

  })
);


// ============================================================
// STAGE 2D.3B - INITIALISE AUTOMATIC NAVIGATION
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

    // Connect automatically.
    // connect() will then call attemptAutoNavigation().

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
