
/*
 * BPA Assembly Navigator
 * Stage 2D.3B.7C.8A
 *
 * Production interface cleanup.
 *
 * Core functionality:
 * - Connect to Trimble Connect
 * - Refresh loaded IFC models
 * - Resolve Tekla assembly GUID
 * - Make surrounding IFC objects transparent
 * - Keep selected assembly fully opaque
 * - Preserve original IFC colours
 * - Select and zoom to assembly
 * - Switch between assemblies
 * - Restore model appearance
 * - Automatic URL GUID navigation
 */

'use strict';

// ============================================================
// STAGE 9D.5B.1 - STORAGE DIAGNOSTIC
// ============================================================

try {
    const storedGuid = localStorage.getItem(
        'BPA_NAVIGATOR_STORAGE_TEST'
    );

    console.log(
        '[BPA Storage Test] Origin:',
        window.location.origin
    );

    console.log(
        '[BPA Storage Test] Retrieved GUID:',
        storedGuid || 'NOT FOUND'
    );
} catch (error) {
    console.error(
        '[BPA Storage Test] Read failed:',
        error
    );
}

// ============================================================
// GLOBAL STATE
// ============================================================

let api = null;
let assemblyNavigationBusy = false;
let connectionBusy = false;

let fullTransparencyBusy = false;
let fullTransparencyActive = false;
let fullTransparencyModelId = null;
let fullTransparencyBatches = [];
let fullTransparencyDetails = null;

const FULL_TRANSPARENCY_BATCH_SIZE = 50;
const FULL_TRANSPARENCY_OPACITY = 0.2;

const AUTO_NAVIGATION_MAX_ATTEMPTS = 15;
const AUTO_NAVIGATION_RETRY_DELAY = 2000;

const el = id => document.getElementById(id);

const validGuid = value =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const delay = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

// ============================================================
// URL NAVIGATION
// ============================================================

const navigationParams = new URLSearchParams(
  window.location.search
);

const rawIncomingGuid =
  navigationParams.get('teklaGuid') || '';

let incomingGuid = rawIncomingGuid
  .trim()
  .replace(/^["'{\s]+|["'}\s]+$/g, '')
  .trim()
  .toLowerCase();

let autoNavigationPending = validGuid(incomingGuid);
let autoNavigationRunning = false;

// Stage 9D.6G.2G.10
const BPA_PENDING_NAVIGATION_KEY =
    "BPA_PENDING_ASSEMBLY_NAVIGATION";

const BPA_PENDING_MAX_AGE_MS = 5 * 60 * 1000;

function savePendingNavigation(guid, projectId, modelId) {
    if (!validGuid(guid)) {
        throw new Error("Invalid assembly GUID.");
    }

    localStorage.setItem(
        BPA_PENDING_NAVIGATION_KEY,
        JSON.stringify({
            guid: guid.toLowerCase(),
            projectId,
            modelId,
            createdAt: Date.now()
        })
    );
}

function readPendingNavigation() {
    const raw = localStorage.getItem(
        BPA_PENDING_NAVIGATION_KEY
    );

    if (!raw) return null;

    try {
        const request = JSON.parse(raw);

        if (
            !validGuid(request.guid) ||
            !Number.isFinite(request.createdAt) ||
            Date.now() - request.createdAt >
                BPA_PENDING_MAX_AGE_MS ||
            request.createdAt > Date.now()
        ) {
            return null;
        }

        return request;
    } catch (_) {
        return null;
    }
}

function clearPendingNavigation() {
    localStorage.removeItem(
        BPA_PENDING_NAVIGATION_KEY
    );
}

// ============================================================
// STATUS AND ACTIVITY LOG
// ============================================================

function status(message) {

  el('status').textContent = message;
}

function log(message, value) {

  const output = el('log');

  if (!output) return;

  let detail = '';

  if (value !== undefined) {

    try {
      detail = '\n' + JSON.stringify(value, null, 2);
    }
    catch (_) {
      detail = '\n' + String(value);
    }
  }

  const timestamp =
    new Date().toLocaleTimeString();

  output.textContent =
    '[' + timestamp + '] ' +
    message + detail +
    '\n\n' + output.textContent;
}

function reportError(error) {

  const message =
    error && error.message
      ? error.message
      : String(error);

  status('Error: ' + message);

  log('ERROR', message);
}

function run(fn) {

  return async () => {

    try {
      await fn();
    }
    catch (error) {
      reportError(error);
    }
  };
}

// ============================================================
// BUTTON STATE
// ============================================================

function updateButtons() {

  const busy =
    assemblyNavigationBusy ||
    fullTransparencyBusy ||
    connectionBusy ||
    autoNavigationRunning;

el('connect').disabled = busy;

el('pasteDrawingGuid').disabled = busy;

el('find').disabled =
  busy || !api;

  el('restoreNavigation').disabled =
    busy ||
    !api ||
    !fullTransparencyActive;

  el('guid').disabled = busy;
  el('model').disabled = busy;
}

// ============================================================
// MODEL DROPDOWN
// ============================================================

function populateModels(models) {

  const select = el('model');
  const previousModelId = select.value;

  select.replaceChildren();

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

  if (!select.options.length) {

    const option =
      document.createElement('option');

    option.value = '';
    option.textContent = 'No loaded IFC models';

    select.appendChild(option);
  }

  log('Loaded models refreshed', {
    count: Array.isArray(models)
      ? models.length
      : 0,
    selectedModelId: select.value
  });
}


 // ============================================================
 // STAGE 9D.6G.2G.1 - PROJECT EXPLORER MENU
 // ============================================================

const BPA_PROJECT_MENU = {
    title: "BPA Assembly Navigator",
    icon: "https://jordanf-bpa.github.io/favicon.ico",
    command: "BPA_NAVIGATOR",
    subMenus: []
};

let projectMenuRegistered = false;

async function registerProjectExplorerMenu() {

    if (!api || projectMenuRegistered) {
        return;
    }

 console.log(
    "[BPA Project Explorer] Menu request:",
    JSON.stringify(BPA_PROJECT_MENU, null, 2)
);

const menu = await api.ui.setMenu(
    BPA_PROJECT_MENU
);

console.log(
    "[BPA Project Explorer] setMenu result:",
    menu
);

if (menu === false || menu == null) {
    projectMenuRegistered = false;

    throw new Error(
        "Trimble Connect did not accept the Project Explorer menu."
    );
}

projectMenuRegistered = true;

console.log(
    "[BPA Project Explorer] Menu registered successfully."
);

log("Project Explorer menu registered.");

// Do not automatically activate the submenu.
// First verify that the navigation entry appears.
}

function handleProjectExplorerCommand(event, args) {

    if (event !== "extension.command") {
        return;
    }

    const command =
        typeof args?.data === "string"
            ? args.data
            : args?.data?.command || "";

    console.log(
        "[BPA Project Explorer] Command received:",
        command
    );

    if (
        command === "BPA_NAVIGATOR" ||
        command.startsWith("BPA_NAVIGATOR_OPEN")
    ) {
        log(
            "Project Explorer command received",
            command
        );

        status(
            "BPA Navigator opened from Project Explorer."
        );
    }
}


// ============================================================
// STAGE 9D.6G.2G.18 - LAUNCHER GUID HANDOFF
// ============================================================

let launcherRequestId = null;
let launcherHandoffStarted = false;
let launcherHandoffCompleted = false;

function requestGuidFromLauncher() {

    if (launcherHandoffStarted) {
        return;
    }

    if (!window.top.opener) {
        console.log(
            "[BPA Launcher] No opener available."
        );
        return;
    }

    launcherHandoffStarted = true;

    launcherRequestId =
        crypto.randomUUID();

    console.log(
        "[BPA Launcher] Requesting GUID:",
        launcherRequestId
    );

    window.top.opener.postMessage(
        {
            type: "BPA_GUID_REQUEST",
            requestId: launcherRequestId
        },
        "https://jordanf-bpa.github.io"
    );
}

window.addEventListener("message", async function (event) {

    if (
        event.origin !==
        "https://jordanf-bpa.github.io"
    ) {
        return;
    }

    if (
        !window.top.opener ||
        event.source !== window.top.opener
    ) {
        return;
    }

    const data = event.data;

    if (
        !data ||
        data.type !== "BPA_GUID_RESPONSE" ||
        data.requestId !== launcherRequestId ||
        launcherHandoffCompleted
    ) {
        return;
    }

    if (!validGuid(data.guid)) {
        console.warn(
            "[BPA Launcher] Invalid GUID received."
        );
        return;
    }

    launcherHandoffCompleted = true;

    console.log(
        "[BPA Launcher] GUID received:",
        data.guid
    );

    try {

        const host =
            await api.extension.getHost();

        if (host.name !== "project") {
            return;
        }

        const project =
            await api.project.getProject();

        if (project.id !== data.projectId) {
            throw new Error(
                "Launcher project does not match Trimble Connect."
            );
        }

        el("guid").value =
            data.guid.trim().toLowerCase();

        status(
            "GUID received. Opening assembly in 3D Viewer..."
        );

        await launchPendingAssemblyInViewer();

    } catch (error) {

        launcherHandoffCompleted = false;

        console.error(
            "[BPA Launcher] Automatic navigation failed:",
            error
        );

        reportError(error);
    }
});

// ============================================================
// STAGE 9D.6G.2G.10 - PROJECT EXPLORER HANDOFF
// ============================================================

async function launchPendingAssemblyInViewer() {

    if (!api) {
        await connect();
    }

    const host = await api.extension.getHost();

    if (host.name !== "project") {
        throw new Error(
            "Launch this operation from Project Explorer."
        );
    }

    const guid = el("guid").value
        .trim()
        .toLowerCase();

    if (!validGuid(guid)) {
        throw new Error(
            "Enter a valid Tekla assembly GUID."
        );
    }

    const project = await api.project.getProject();

    // Stage test: use the model ID confirmed in
    // your existing Trimble Connect project.
    const modelId = "LPDL2Rmxp1E";

    if (project.id !== "l7enVCZktZA") {
        throw new Error(
            "This stage is currently configured for the test project only."
        );
    }

    savePendingNavigation(
        guid,
        project.id,
        modelId
    );

    log("Pending assembly navigation saved", {
        guid,
        projectId: project.id,
        modelId
    });

    status("Opening 3D Viewer...");

    const result = await api.extension.goTo(
        "3dviewer",
        {
            projectId: project.id,
            modelId
        }
    );

    if (result === false) {
        throw new Error(
            "Trimble Connect rejected 3D Viewer navigation."
        );
    }
}

// ============================================================
// CONNECT TO TRIMBLE CONNECT
// ============================================================

async function connect() {

  if (connectionBusy || assemblyNavigationBusy) {
    throw new Error(
      'Wait for the current operation to finish.'
    );
  }

  connectionBusy = true;
  updateButtons();

  try {

    status('Connecting to Trimble Connect...');

    if (!window.TrimbleConnectWorkspace) {
      throw new Error(
        'Trimble Connect Workspace API did not load.'
      );
    }

    if (!api) {

api = await window.TrimbleConnectWorkspace.connect(
    window.parent,
    (event, args) => {

        // Stage 9D.6G.2G.12F
        // Diagnostic only — do not trigger assembly navigation.
        if (event === "extension.broadcast") {
            console.log(
                "[BPA BROADCAST TEST] Message received:",
                args?.data
            );
        }

        handleProjectExplorerCommand(event, args);
    },
    30000
);
    }

// Stage 9D.6G.2G.1
// Identify the actual Trimble Connect extension host.

try {
    const host = await api.extension.getHost();

  console.log(
    "[BPA Project Explorer] Host details:",
    JSON.stringify(host, null, 2)
);

console.log(
    "[BPA Project Explorer] Host raw object:",
    host
);

    log("Trimble Connect extension host", host);

} catch (hostError) {
    console.warn(
        "[BPA Project Explorer] Host detection failed:",
        hostError
    );
}

// Register the Project Explorer menu.

try {
    await registerProjectExplorerMenu();
} catch (menuError) {
    console.warn(
        "[BPA Project Explorer] Menu registration failed:",
        menuError
    );

    log(
        "Project Explorer menu registration failed",
        menuError?.message || String(menuError)
    );
}

// Retrieve project details independently.
// Failure must not prevent the extension from loading.

try {
    const project =
        await api.project.getProject();

    log('Connected to Trimble Connect', {
        projectId: project?.id,
        projectName: project?.name
    });
} catch (projectError) {
    console.warn(
        "[BPA] Project information unavailable:",
        projectError
    );
}

// Project Explorer and 3D Viewer provide different
// capabilities. Try viewer functionality first.

let models = null;

try {
    models = await api.viewer.getModels();
} catch (viewerError) {
    console.log(
        "[BPA] Viewer API unavailable in this context.",
        viewerError
    );
}

if (models !== null) {
    populateModels(models);
}

// Project Explorer menu registration is already
// handled immediately after the Workspace API connection.

status('Connected to Trimble Connect.');

  } finally {

    connectionBusy = false;
    updateButtons();
  }

  // Stage 9D.6G.2G.10
  // Process a pending Project Explorer request
  // only when running inside the 3D Viewer.

  try {
    const host = await api.extension.getHost();

    if (host.name === "3dviewer") {

      const pending = readPendingNavigation();

      if (pending) {

        const project =
          await api.project.getProject();

        if (pending.projectId === project.id) {

          incomingGuid = pending.guid;
          autoNavigationPending = true;

          el("guid").value = pending.guid;

          log("Pending GUID retrieved from Project Explorer", {
            guid: pending.guid,
            modelId: pending.modelId
          });

          status(
            "Pending assembly GUID received. Locating assembly..."
          );
        }
      }
    }
  } catch (error) {
    log(
      "Pending navigation retrieval failed",
      error.message
    );
  }

   if (autoNavigationPending) {
    await attemptAutoNavigation();
  }

  // Stage 9D.6G.2G.18
  // Request a GUID only from Project Explorer,
  // after the Workspace API is connected.

  try {

    const host =
        await api.extension.getHost();

    if (
        host.name === "project" &&
        !launcherHandoffStarted
    ) {
        requestGuidFromLauncher();
    }

  } catch (error) {

    console.warn(
        "[BPA Launcher] GUID request unavailable:",
        error
    );
  }

  // Clear only after successful automatic navigation.
  if (
    !autoNavigationPending &&
    readPendingNavigation()?.guid === incomingGuid &&
    fullTransparencyActive
  ) {
    clearPendingNavigation();

    log("Pending assembly navigation completed and cleared.");
  }
}

// ============================================================
// OBJECT SELECTORS
// ============================================================

function createObjectSelector(modelId, ids, recursive) {

  return {
    modelObjectIds: [{
      modelId,
      objectRuntimeIds: ids,
      recursive
    }]
  };
}

function fullTransparencySelector(modelId, ids) {

  return createObjectSelector(
    modelId,
    ids,
    false
  );
}

// ============================================================
// IFC OBJECT RETRIEVAL
// ============================================================

function fullTransparencyIds(groups, modelId) {

  const group = Array.isArray(groups)
    ? groups.find(item => item.modelId === modelId)
    : null;

  if (!group || !Array.isArray(group.objects)) {
    throw new Error(
      'Could not retrieve IFC objects for model: ' +
      modelId
    );
  }

  if (
    group.objects.some(
      object => !Number.isInteger(object.id)
    )
  ) {
    throw new Error(
      'The viewer returned an unexpected IFC object ID format.'
    );
  }

  return [...new Set(
    group.objects.map(object => object.id)
  )];
}

function fullTransparencyParentIds(parents) {

  if (!Array.isArray(parents)) {
    throw new Error(
      'Unexpected IFC hierarchy parent response.'
    );
  }

  if (
    parents.some(parent =>
      !parent ||
      !Number.isInteger(parent.id)
    )
  ) {
    throw new Error(
      'Unexpected IFC parent object ID format.'
    );
  }

  return parents.map(parent => parent.id);
}

// ============================================================
// RESOLVE TEKLA ASSEMBLY GUID
// ============================================================

async function resolveAssembly(modelId, guid) {

  const runtimeIds =
    await api.viewer.convertToObjectRuntimeIds(
      modelId,
      [guid]
    );

  const runtimeId =
    runtimeIds && runtimeIds[0];

  if (!Number.isInteger(runtimeId)) {
    throw new Error(
      'Assembly GUID could not be resolved in the selected IFC model.'
    );
  }

  return {
    modelId,
    guid,
    runtimeId,
    selector: createObjectSelector(
      modelId,
      [runtimeId],
      true
    )
  };
}

// ============================================================
// FULL-MODEL TRANSPARENCY
// PROVEN STAGE 6D / 6E LOGIC
// ============================================================

async function applyFullModelTransparency(assembly) {

  if (!api) {
    throw new Error(
      'Connect to Trimble Connect first.'
    );
  }

  if (fullTransparencyBusy) {
    throw new Error(
      'A model appearance operation is already running.'
    );
  }

  if (fullTransparencyActive) {
    throw new Error(
      'Restore the previous model appearance first.'
    );
  }

  const modelId = assembly.modelId;
  const guid = assembly.guid;
  const selectedRuntimeId = assembly.runtimeId;
  const selectedSelector = assembly.selector;

  fullTransparencyBusy = true;
  updateButtons();

  try {

    // --------------------------------------------------------
    // STEP 1 - GET ALL IFC OBJECTS
    // --------------------------------------------------------

    status('Retrieving IFC model objects...');

    const allGroups =
      await api.viewer.getObjects();

    const selectedGroups =
      await api.viewer.getObjects(
        selectedSelector
      );

    const allIds =
      fullTransparencyIds(
        allGroups,
        modelId
      );

    const selectedIds =
      fullTransparencyIds(
        selectedGroups,
        modelId
      );

    if (!selectedIds.includes(selectedRuntimeId)) {
      throw new Error(
        'Selected assembly ID is missing from protected objects.'
      );
    }

    // --------------------------------------------------------
    // STEP 2 - PROTECT SELECTED ASSEMBLY
    // --------------------------------------------------------

    const protectedIds =
      new Set(selectedIds);

    protectedIds.add(selectedRuntimeId);

    const parents =
      await api.viewer.getHierarchyParents(
        modelId,
        [selectedRuntimeId]
      );

    const parentIds =
      fullTransparencyParentIds(parents);

    for (const id of parentIds) {
      protectedIds.add(id);
    }

    // --------------------------------------------------------
    // STEP 3 - FIND SURROUNDING OBJECTS
    // --------------------------------------------------------

    const surroundingIds =
      allIds.filter(
        id => !protectedIds.has(id)
      );

    if (surroundingIds.length === 0) {
      throw new Error(
        'No surrounding IFC objects were found.'
      );
    }

    if (
      surroundingIds.some(
        id => protectedIds.has(id)
      )
    ) {
      throw new Error(
        'Protected assembly objects were included in surrounding objects.'
      );
    }

    // --------------------------------------------------------
    // STEP 4 - CREATE 50-OBJECT BATCHES
    // --------------------------------------------------------

    const batches = [];

    for (
      let i = 0;
      i < surroundingIds.length;
      i += FULL_TRANSPARENCY_BATCH_SIZE
    ) {

      batches.push(
        surroundingIds.slice(
          i,
          i + FULL_TRANSPARENCY_BATCH_SIZE
        )
      );
    }

    // --------------------------------------------------------
    // STEP 5 - TRACK RESTORATION STATE
    // --------------------------------------------------------

    fullTransparencyModelId = modelId;
    fullTransparencyBatches = [];
    fullTransparencyActive = true;

    fullTransparencyDetails = {
      modelId,
      guid,
      selectedRuntimeId,
      totalObjectCount: allIds.length,
      protectedObjectCount: protectedIds.size,
      surroundingObjectCount: surroundingIds.length,
      totalBatches: batches.length,
      opacity: FULL_TRANSPARENCY_OPACITY
    };

    // --------------------------------------------------------
    // STEP 6 - APPLY TRANSPARENCY
    // --------------------------------------------------------

    let processed = 0;

    for (let i = 0; i < batches.length; i++) {

      const batchIds = batches[i];

      // Track before applying to allow recovery
      // if the API operation fails.

      fullTransparencyBatches.push(batchIds);

      status(
        'Applying transparency: ' +
        (i + 1) + ' of ' +
        batches.length + ' batches...'
      );

      await api.viewer.setObjectState(
        fullTransparencySelector(
          modelId,
          batchIds
        ),
        {
          opacity: FULL_TRANSPARENCY_OPACITY
        }
      );

      processed += batchIds.length;
    }

    // --------------------------------------------------------
    // STEP 7 - KEEP SELECTED ASSEMBLY SOLID
    // CRITICAL STAGE 6E FIX
    // --------------------------------------------------------

    status('Restoring selected assembly to full opacity...');

    await api.viewer.setObjectState(
      selectedSelector,
      {
        opacity: 1
      }
    );

    // No colour changes are applied.
    // Original IFC material colours remain intact.

    log('Assembly transparency applied', {
      ...fullTransparencyDetails,
      processedObjectCount: processed,
      selectedAssemblyOpacity: 1,
      originalIfcColoursPreserved: true
    });

    status(
      'Assembly transparency applied successfully.'
    );

  } catch (error) {

    if (fullTransparencyActive) {

      log('Transparency interrupted', {
        error: error.message,
        batchesToRestore:
          fullTransparencyBatches.length
      });
    }

    throw error;

  } finally {

    fullTransparencyBusy = false;
    updateButtons();
  }
}

// ============================================================
// RESTORE MODEL APPEARANCE
// ============================================================

async function restoreFullModelTransparency() {

  if (!api) {
    throw new Error(
      'Connect to Trimble Connect first.'
    );
  }

  if (fullTransparencyBusy) {
    throw new Error(
      'A model appearance operation is running.'
    );
  }

  if (!fullTransparencyActive) {
    status('Model appearance is already restored.');
    return;
  }

  fullTransparencyBusy = true;
  updateButtons();

  try {

    const modelId =
      fullTransparencyModelId;

    const batches =
      fullTransparencyBatches;

    let restored = 0;
    const totalBatches = batches.length;

    // Restore in reverse order.
    // Successfully restored batches are removed
    // so a failed restore can be retried.

    for (
      let i = batches.length - 1;
      i >= 0;
      i--
    ) {

      const ids = batches[i];

      status(
        'Restoring appearance: ' +
        (totalBatches - i) +
        ' of ' + totalBatches +
        ' batches...'
      );

      await api.viewer.setObjectState(
        fullTransparencySelector(
          modelId,
          ids
        ),
        {
          opacity: 1
        }
      );

      restored += ids.length;

      batches.splice(i, 1);
    }

    fullTransparencyActive = false;
    fullTransparencyModelId = null;
    fullTransparencyBatches = [];
    fullTransparencyDetails = null;

    log('Model appearance restored', {
      modelId,
      restoredObjectCount: restored
    });

    status('Model appearance restored successfully.');

  } catch (error) {

    log('Appearance restoration interrupted', {
      error: error.message,
      remainingBatches:
        fullTransparencyBatches.length
    });

    throw error;

  } finally {

    fullTransparencyBusy = false;
    updateButtons();
  }
}

// ============================================================
// MAIN ASSEMBLY NAVIGATION
// ============================================================

async function findAssembly() {

  if (!api) {
    throw new Error(
      'Connect to Trimble Connect first.'
    );
  }

  if (assemblyNavigationBusy || fullTransparencyBusy) {
    throw new Error(
      'Assembly navigation is already running.'
    );
  }

  const guid =
    el('guid').value.trim().toLowerCase();

  const modelId =
    el('model').value;

  if (!validGuid(guid)) {
    throw new Error(
      'Enter a valid 36-character Tekla assembly GUID.'
    );
  }

  if (!modelId) {
    throw new Error(
      'Select a loaded IFC model.'
    );
  }

  assemblyNavigationBusy = true;
  updateButtons();

  try {

    // --------------------------------------------------------
    // STEP 1 - RESOLVE ASSEMBLY
    // --------------------------------------------------------

    status('Finding Tekla assembly...');

    const assembly =
      await resolveAssembly(
        modelId,
        guid
      );

    // --------------------------------------------------------
    // STEP 2 - RESTORE PREVIOUS NAVIGATION
    // --------------------------------------------------------

    if (fullTransparencyActive) {

      status('Restoring previous model appearance...');

      await restoreFullModelTransparency();

      if (fullTransparencyActive) {
        throw new Error(
          'Previous model appearance could not be restored.'
        );
      }
    }

    // --------------------------------------------------------
    // STEP 3 - APPLY TRANSPARENCY
    // --------------------------------------------------------

    await applyFullModelTransparency(
      assembly
    );

    // --------------------------------------------------------
    // STEP 4 - SELECT ASSEMBLY
    // --------------------------------------------------------

    status('Selecting assembly...');

    await api.viewer.setSelection(
      assembly.selector,
      'set'
    );

    // --------------------------------------------------------
    // STEP 5 - ZOOM TO ASSEMBLY
    // --------------------------------------------------------

    status('Zooming to assembly...');

    await api.viewer.setCamera(
      assembly.selector
    );

    // --------------------------------------------------------
    // STEP 6 - COMPLETE
    // --------------------------------------------------------

    log('Assembly navigation completed', {
      modelId,
      guid,
      runtimeId: assembly.runtimeId,
      surroundingOpacity:
        FULL_TRANSPARENCY_OPACITY,
      selectedOpacity: 1
    });

    status(
      'Assembly found. Surrounding steelwork is transparent.'
    );

    return true;

  } catch (error) {

    log('Assembly navigation failed', {
      error: error.message,
      restorationAvailable:
        fullTransparencyActive
    });

    throw error;

  } finally {

    assemblyNavigationBusy = false;
    updateButtons();
  }
}

// ============================================================
// MANUAL RESTORE
// ============================================================

async function restoreNavigationAppearance() {

  if (assemblyNavigationBusy || fullTransparencyBusy) {
    throw new Error(
      'Wait for the current navigation to finish.'
    );
  }

  await restoreFullModelTransparency();

  updateButtons();
}

// ============================================================
// AUTOMATIC URL NAVIGATION
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
  updateButtons();

  try {

    el('guid').value = incomingGuid;

    for (
      let attempt = 1;
      attempt <= AUTO_NAVIGATION_MAX_ATTEMPTS;
      attempt++
    ) {

      status(
        'Locating assembly automatically: attempt ' +
        attempt + ' of ' +
        AUTO_NAVIGATION_MAX_ATTEMPTS
      );

      try {

        const models =
          await api.viewer.getModels();

        populateModels(models);

        if (!el('model').value) {
          throw new Error(
            'No IFC model is loaded yet.'
          );
        }

        const completed =
          await findAssembly();

        if (completed !== true) {
          throw new Error(
            'Automatic assembly navigation did not complete.'
          );
        }

        autoNavigationPending = false;

        log('Automatic navigation completed', {
          guid: incomingGuid,
          modelId: el('model').value,
          attempt
        });

        status(
          'Assembly located automatically. Surrounding steelwork is transparent.'
        );

        return;

      } catch (error) {

        log('Automatic navigation attempt failed', {
          attempt,
          error: error.message
        });

        // Prevent retries when the viewer has
        // partially modified appearance state.

        if (fullTransparencyActive) {
          throw new Error(
            'Automatic navigation stopped after an appearance error. ' +
            'Restore Model Appearance before trying again. ' +
            error.message
          );
        }

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

  } catch (error) {

    autoNavigationPending = false;

    reportError(error);

  } finally {

    autoNavigationRunning = false;
    updateButtons();
  }
}

// ============================================================
// STAGE 9D.6F.2A - DRAWING GUID CLIPBOARD NAVIGATION
// ============================================================

async function pasteDrawingGuidAndConnect() {

  if (
    connectionBusy ||
    assemblyNavigationBusy ||
    fullTransparencyBusy ||
    autoNavigationRunning
  ) {
    throw new Error(
      'Wait for the current operation to finish.'
    );
  }

  if (!navigator.clipboard ||
      !navigator.clipboard.readText) {
    throw new Error(
      'Clipboard access is unavailable. ' +
      'Paste the GUID manually instead.'
    );
  }

  let clipboardText;

  try {
    clipboardText = await navigator.clipboard.readText();
  } catch (error) {
    throw new Error(
      'Clipboard permission was denied. ' +
      'Allow clipboard access in Edge or paste manually.'
    );
  }

  const guid = clipboardText
    .trim()
    .replace(/^["'{\s]+|["'}\s]+$/g, '')
    .trim()
    .toLowerCase();

  if (!validGuid(guid)) {
    throw new Error(
      'The clipboard does not contain a valid ' +
      '36-character Tekla assembly GUID.'
    );
  }

  // Populate the existing Navigator field.
  el('guid').value = guid;

  log('Drawing assembly GUID received from clipboard', {
    guid
  });

  status('Drawing GUID received. Connecting to viewer...');

  // Connect and refresh available IFC models.
  await connect();

  if (!api) {
    throw new Error(
      'Could not connect to Trimble Connect.'
    );
  }

  if (!el('model').value) {
    throw new Error(
      'No IFC model is available. ' +
      'Load the required model in the 3D Viewer.'
    );
  }

  // Reuse the existing selection, transparency and zoom logic.
  const completed = await findAssembly();

  if (completed !== true) {
    throw new Error(
      'Assembly navigation did not complete.'
    );
  }

  status(
    'Drawing assembly located. ' +
    'Surrounding steelwork is transparent.'
  );
}

// ============================================================
// EVENT LISTENERS
// ============================================================



el('connect').addEventListener(
  'click',
  run(connect)
);

el('pasteDrawingGuid').addEventListener(
  'click',
  run(pasteDrawingGuidAndConnect)
);

el('find').addEventListener(
  'click',
  run(findAssembly)
);
el('restoreNavigation').addEventListener(
  'click',
  run(restoreNavigationAppearance)
);

// Allow Enter to find the assembly.

el('guid').addEventListener(
  'keydown',
  event => {

    if (event.key === 'Enter') {

      event.preventDefault();

      if (!el('find').disabled) {
        run(findAssembly)();
      }
    }
  }
);

// ============================================================
// STAGE 9D.6G.2D - CHROME BRIDGE GUID RECEIVER
// ============================================================

let bridgeNavigationGuid = "";

window.addEventListener("message", async (event) => {

    // Only accept messages from the Trimble Connect parent.
    if (
        event.origin !== "https://web.connect.trimble.com" ||
        event.source !== window.parent
    ) {
        return;
    }

    const message = event.data;

    if (
        !message ||
        message.type !== "BPA_NAVIGATE_ASSEMBLY"
    ) {
        return;
    }

    const guid = String(message.teklaGuid || "")
        .trim()
        .toLowerCase();

    if (!validGuid(guid)) {
        log("Chrome Bridge supplied an invalid GUID.");
        return;
    }

    // Acknowledge receipt so the Bridge can stop sending.
    window.parent.postMessage({
        type: "BPA_NAVIGATION_RECEIVED",
        teklaGuid: guid
    }, event.origin);

    // Ignore duplicate messages for the same request.
    if (bridgeNavigationGuid === guid) {
        return;
    }

    bridgeNavigationGuid = guid;

    incomingGuid = guid;
    autoNavigationPending = true;

    el("guid").value = guid;

    log("Assembly GUID received from Chrome Bridge", {
        guid
    });

    status(
        "Assembly GUID received. Starting automatic navigation..."
    );

    try {
        // Wait for any existing navigation to finish.
        while (
            connectionBusy ||
            assemblyNavigationBusy ||
            autoNavigationRunning
        ) {
            await delay(250);
        }

        // A newer drawing request may have superseded this one.
        if (bridgeNavigationGuid !== guid) {
            return;
        }

        if (!api) {
            await connect();
        } else {
            await attemptAutoNavigation();
        }

    } catch (error) {
        reportError(error);
    }

});

// ============================================================
// STAGE 9D.6G.2G.24A - LIVE VIEWER REGISTRATION
// ============================================================

const BPA_LAUNCHER_ORIGIN =
    "https://jordanf-bpa.github.io";

let liveViewerRegistered = false;

function registerLiveViewer() {

    if (liveViewerRegistered) {
        return;
    }

    // The launcher opened the Trimble Connect tab.
    // The embedded BPA iframe can access its opener reference.
    if (!window.top.opener) {
        return;
    }

    window.top.opener.postMessage(
        {
            type: "BPA_VIEWER_READY",
            projectId: "l7enVCZktZA"
        },
        BPA_LAUNCHER_ORIGIN
    );

    console.log(
        "[BPA Stage 24A] Viewer registration sent."
    );
}

window.addEventListener("message", function (event) {

    if (
        event.origin !== BPA_LAUNCHER_ORIGIN ||
        event.source !== window.top.opener
    ) {
        return;
    }

    const data = event.data;

    if (!data || data.type !== "BPA_VIEWER_REGISTERED") {
        return;
    }

    liveViewerRegistered = true;

    console.log(
        "[BPA Stage 24A] Live Viewer connected to launcher."
    );
});

// Only register from the 3D Viewer.
// Project Explorer must continue using its existing GUID handoff.
(async function () {

    try {
        if (!api) {
            await new Promise(resolve => {
                const check = setInterval(() => {
                    if (api) {
                        clearInterval(check);
                        resolve();
                    }
                }, 250);
            });
        }

        const host = await api.extension.getHost();

        if (host.name === "3dviewer") {
            registerLiveViewer();
        }

    } catch (error) {
        console.warn(
            "[BPA Stage 24A] Viewer registration failed:",
            error
        );
    }

})();

// ============================================================
// INITIALISATION
// ============================================================

updateButtons();

// Stage 9D.6G.2G.1
// Establish the connection on startup so a Project
// Explorer extension can register its navigation menu.

if (!incomingGuid) {
    run(connect)();
}

if (incomingGuid) {

  if (validGuid(incomingGuid)) {

    el('guid').value = incomingGuid;

    status(
      'Assembly GUID received. Connecting to viewer...'
    );

    log('Automatic navigation GUID received', {
      guid: incomingGuid
    });

    run(connect)();

  } else {

    status(
      'Invalid assembly GUID in navigation URL.'
    );

    log('Invalid incoming GUID', {
      rawGuid: rawIncomingGuid,
      cleanedGuid: incomingGuid
    });
  }
}

// ============================================================
// END - BPA ASSEMBLY NAVIGATOR
// STAGE 2D.3B.7C.8A
// ============================================================
