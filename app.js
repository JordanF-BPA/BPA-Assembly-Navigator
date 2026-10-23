
/*
 * BPA Assembly Navigator
 * Stage 2D.3B - Automatic Assembly GUID Navigation
 *
 * Existing functionality:
 * - Connect to Trimble Connect viewer
 * - Read selected objects
 * - Resolve Tekla GUID to runtime ID
 * - Select assembly
 * - Zoom camera to assembly
 *
 * New functionality:
 * - Read teklaGuid from extension URL
 * - Automatically connect to viewer
 * - Automatically select and zoom to assembly
 *
 * No access tokens or credentials are stored.
 */

'use strict';

// ============================================================
// GLOBAL VARIABLES
// ============================================================

let api = null;

const el = id => document.getElementById(id);

const validGuid = value =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);



 // ============================================================
 // STAGE 2D.3B - AUTOMATIC NAVIGATION PARAMETERS
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

// Automatic navigation retry settings
const AUTO_NAVIGATION_MAX_ATTEMPTS = 15;
const AUTO_NAVIGATION_RETRY_DELAY = 2000;

const delay = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

// Diagnostic information for Stage 2D.3B
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

  log(
    'Available models (inspect identifiers and loading state)',
    models
  );

  status(
    'Connected. Choose the loaded IFC model, then Find, Select & Zoom.'
  );

  // ==========================================================
  // STAGE 2D.3B - ATTEMPT AUTOMATIC NAVIGATION
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
// FIND, SELECT AND ZOOM TO ASSEMBLY
// EXISTING WORKING FUNCTION - PRESERVED
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

  // ==========================================================
  // SELECT ASSEMBLY
  // ==========================================================

  await api.viewer.setSelection(
    selector,
    'set'
  );

  status('Object selected. Fitting camera...');

  // ==========================================================
  // ZOOM CAMERA
  // ==========================================================

  await api.viewer.setCamera(selector);

  status(
    'Selection and camera commands completed. ' +
    'Confirm the assembly is highlighted and visible.'
  );

  log('Selected and zoomed', {
    modelId,
    guid,
    runtimeId: id
  });
}


// ============================================================
// STAGE 2D.3B - AUTOMATIC ASSEMBLY NAVIGATION
// ============================================================


async function attemptAutoNavigation() {

  if (!autoNavigationPending || autoNavigationRunning || !api) {
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

        // Refresh available models.
        const models = await api.viewer.getModels();

        const modelSelect = el('model');

        // Preserve the selected model ID where possible.
        const previousModelId = modelSelect.value;

        modelSelect.replaceChildren();

        for (const model of models || []) {

          const modelId =
            model.id || model.modelId || model.versionId;

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
          throw new Error('No IFC model available yet.');
        }

        // Reuse the previously tested working function.
        await findAssembly();

        autoNavigationPending = false;

        status('Automatic assembly navigation completed.');

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

        if (attempt === AUTO_NAVIGATION_MAX_ATTEMPTS) {
          throw error;
        }

        await delay(AUTO_NAVIGATION_RETRY_DELAY);
      }
    }

  }
  catch (error) {

    autoNavigationPending = false;

    status(
      'Automatic navigation failed: ' + error.message
    );

    log('Automatic navigation failed', String(error));

  }
  finally {

    autoNavigationRunning = false;
  }
}


// ============================================================
// BUTTON EVENT LISTENERS
// EXISTING FUNCTIONALITY
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
// STAGE 2D.3B - INITIALISE AUTOMATIC NAVIGATION
// ============================================================

if (incomingGuid) {

  if (validGuid(incomingGuid)) {

    // Populate the input field.

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
