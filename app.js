
/*
 * BPA Assembly Navigator
 * Stage 2D.3B.7C.7
 *
 * Features:
 * - Connect to Trimble Connect
 * - Read selected objects
 * - Resolve Tekla assembly GUID
 * - Automatically make surrounding IFC objects transparent
 * - Keep selected assembly fully opaque
 * - Preserve original IFC colours
 * - Select and zoom to the assembly
 * - Restore model appearance
 * - Automatically restore when changing assemblies
 * - Automatic URL GUID navigation
 * - Model loading retry
 * - Native Ghost Mode diagnostics
 *
 * Stage 2D.3B.7C.7 integration:
 * The main navigation workflow will use the
 * successfully tested full-model transparency
 * functionality instead of isolateEntities().
 */

'use strict';

// ============================================================
// GLOBAL VARIABLES
// ============================================================

let api = null;
let lastAssemblySelector = null;

// Stage 2D.3B.7C.7
// Prevent simultaneous main navigation operations.
let assemblyNavigationBusy = false;

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
// STAGE 2D.3B.7A
// GHOST MODE API CAPABILITY INVESTIGATION
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
// STAGE 2D.3B.7B
// VIEWER SETTINGS & OPACITY INVESTIGATION
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
// STAGE 2D.3B.7C
// CONTROLLED TRANSPARENCY TEST
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
    // We need surrounding objects to remain visible.

    status('Applying transparency to loaded objects...');

    // Record the test before modifying appearance.
    transparencyTestActive = true;
    transparencyTestSelector = selector;

    // Original experimental test retained.
    // The main navigation will use Stage 6D/6E instead.

    await api.viewer.setObjectState(
      undefined,
      {
        opacity: 50
      }
    );

    status('Restoring selected assembly to full opacity...');

    // Original experimental assembly override remains
    // disabled. The proven fix is in Stage 6E.

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
// STAGE 2D.3B.7C.2 - SINGLE OBJECT APPEARANCE TEST
// ============================================================

let appearanceTestSelector = null;
let appearanceTestBusy = false;

async function getAppearanceTestSelector() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  const guid = el('guid').value.trim().toLowerCase();
  const modelId = el('model').value;

  if (!validGuid(guid)) {
    throw new Error('Enter a valid Tekla assembly GUID.');
  }

  if (!modelId) {
    throw new Error('Select a loaded IFC model.');
  }

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
    modelObjectIds: [{
      modelId,
      objectRuntimeIds: [runtimeId],
      recursive: true
    }]
  };

  appearanceTestSelector = selector;

  log('APPEARANCE TEST - OBJECT RESOLVED', {
    modelId,
    guid,
    runtimeId
  });

  return selector;
}

async function testAssemblyColour() {

  if (appearanceTestBusy) {
    throw new Error('An appearance test is already running.');
  }

  appearanceTestBusy = true;

  try {

    const selector = await getAppearanceTestSelector();

    status('Testing assembly colour...');

    await api.viewer.setObjectState(
      selector,
      {
        color: '#FF0000'
      }
    );

    log('APPEARANCE TEST - COLOUR', {
      stage: '2D.3B.7C.2',
      requestedColor: '#FF0000',
      operationCompleted: true
    });

    status(
      'Colour command completed. Check whether the assembly is red.'
    );

  } finally {
    appearanceTestBusy = false;
  }
}

async function testSingleObjectOpacity() {

  if (appearanceTestBusy) {
    throw new Error('An appearance test is already running.');
  }

  appearanceTestBusy = true;

  try {

    const selector = await getAppearanceTestSelector();

    status('Testing assembly opacity...');

    await api.viewer.setObjectState(
      selector,
      {
        opacity: 0.2
      }
    );

    log('APPEARANCE TEST - OPACITY', {
      stage: '2D.3B.7C.2',
      requestedOpacity: 0.2,
      operationCompleted: true
    });

    status(
      'Opacity command completed. Check whether the assembly is transparent.'
    );

  } finally {
    appearanceTestBusy = false;
  }
}

// ============================================================
// STAGE 2D.3B.7C.3 - COLOUR RESET INVESTIGATION
// ============================================================

async function resetSingleObjectAppearance() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (appearanceTestBusy) {
    throw new Error('An appearance test is already running.');
  }

  if (!appearanceTestSelector) {
    status('Run the colour test first.');
    return;
  }

  appearanceTestBusy = true;

  try {

    status('Testing original IFC colour restoration...');

    const result = await api.viewer.setObjectState(
      appearanceTestSelector,
      {
        color: 'reset'
      }
    );

    log('STAGE 2D.3B.7C.3 - COLOUR RESET', {
      method: 'setObjectState',
      requestedColor: 'reset',
      opacityModified: false,
      apiResult: result ?? 'No return value',
      test: 'Check whether original IFC colour returns'
    });

    status(
      'Colour reset command completed. ' +
      'Check whether the original IFC colour has returned.'
    );

  } finally {
    appearanceTestBusy = false;
  }
}

// ============================================================
// STAGE 2D.3B.7C.4 - GHOST-STYLE TRANSPARENCY TEST
// ============================================================

let ghostStyleTestActive = false;
let ghostStyleTestBusy = false;
let ghostStyleTestSelector = null;

async function testGhostStyleTransparency() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (ghostStyleTestBusy) {
    throw new Error('A Ghost-style operation is already running.');
  }

  if (ghostStyleTestActive) {
    throw new Error('Restore the previous Ghost-style test first.');
  }

  const guid = el('guid').value.trim().toLowerCase();
  const modelId = el('model').value;

  if (!validGuid(guid)) {
    throw new Error('Enter a valid Tekla assembly GUID.');
  }

  if (!modelId) {
    throw new Error('Select a loaded IFC model.');
  }

  ghostStyleTestBusy = true;

  try {

    status('Resolving assembly for Ghost-style test...');

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
      modelObjectIds: [{
        modelId,
        objectRuntimeIds: [runtimeId],
        recursive: true
      }]
    };

    ghostStyleTestActive = true;
    ghostStyleTestSelector = selector;

    status('Making surrounding model transparent...');

    // Original experimental test retained.
    await api.viewer.setObjectState(
      undefined,
      {
        opacity: 0.2
      }
    );

    status('Restoring selected assembly to solid...');

    await api.viewer.setObjectState(
      selector,
      {
        opacity: 1
      }
    );

    // Preserve original IFC material colours.
    await api.viewer.setSelection(selector, 'set');
    await api.viewer.setCamera(selector);

    log('GHOST-STYLE TRANSPARENCY TEST', {
      stage: '2D.3B.7C.4',
      modelId,
      guid,
      runtimeId,
      surroundingRequestedOpacity: 0.2,
      selectedRequestedOpacity: 1,
      selectedColourModified: false,
      active: true
    });

    status(
      'Ghost-style appearance requested. Check whether ' +
      'surrounding steel is transparent and the assembly is solid.'
    );

  } finally {
    ghostStyleTestBusy = false;
  }
}

async function restoreGhostStyleTransparency() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (ghostStyleTestBusy) {
    throw new Error('A Ghost-style operation is already running.');
  }

  if (!ghostStyleTestActive) {
    status('No active Ghost-style test to restore.');
    return;
  }

  ghostStyleTestBusy = true;

  try {

    status('Restoring model opacity...');

    await api.viewer.setObjectState(
      undefined,
      {
        opacity: 1
      }
    );

    await api.viewer.setObjectState(
      ghostStyleTestSelector,
      {
        color: 'reset'
      }
    );

    ghostStyleTestActive = false;
    ghostStyleTestSelector = null;

    log('GHOST-STYLE APPEARANCE RESTORE', {
      stage: '2D.3B.7C.4',
      requestedModelOpacity: 1,
      selectedColourReset: true
    });

    status(
      'Appearance restoration requested. ' +
      'Check that the original model colours and opacity have returned.'
    );

  } finally {
    ghostStyleTestBusy = false;
  }
}

// ============================================================
// STAGE 2D.3B.7C.5 - DOES NOT EQUAL TEST
// ============================================================

let doesNotEqualTestBusy = false;
let doesNotEqualTestSelector = null;
let doesNotEqualTestActive = false;

async function resolveDoesNotEqualAssembly(modelId, guid) {

  const runtimeIds =
    await api.viewer.convertToObjectRuntimeIds(
      modelId,
      [guid]
    );

  const runtimeId = runtimeIds && runtimeIds[0];

  if (!Number.isInteger(runtimeId)) {
    throw new Error(
      'Could not resolve assembly GUID: ' + guid
    );
  }

  return {
    runtimeId,
    selector: {
      modelObjectIds: [{
        modelId,
        objectRuntimeIds: [runtimeId],
        recursive: true
      }]
    }
  };
}

async function testDoesNotEqualTransparency() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (doesNotEqualTestBusy) {
    throw new Error('A Does Not Equal test is running.');
  }

  if (doesNotEqualTestActive) {
    throw new Error('Restore the previous test first.');
  }

  if (ghostStyleTestActive || transparencyTestActive) {
    throw new Error(
      'Restore the earlier transparency test before continuing.'
    );
  }

  const modelId = el('model').value;
  const selectedGuid = el('guid').value.trim().toLowerCase();
  const surroundingGuid =
    el('excludedTestGuid').value.trim().toLowerCase();

  if (!modelId) {
    throw new Error('Select a loaded IFC model.');
  }

  if (!validGuid(selectedGuid) ||
      !validGuid(surroundingGuid)) {
    throw new Error('Enter two valid assembly GUIDs.');
  }

  if (selectedGuid === surroundingGuid) {
    throw new Error(
      'The two assembly GUIDs must be different.'
    );
  }

  doesNotEqualTestBusy = true;

  try {

    status('Resolving both assemblies...');

    const selected =
      await resolveDoesNotEqualAssembly(
        modelId,
        selectedGuid
      );

    const surrounding =
      await resolveDoesNotEqualAssembly(
        modelId,
        surroundingGuid
      );

    if (selected.runtimeId === surrounding.runtimeId) {
      throw new Error(
        'Both GUIDs resolved to the same runtime object.'
      );
    }

    log('DOES NOT EQUAL - COMPARISON', {
      stage: '2D.3B.7C.5',
      selectedGuid,
      surroundingGuid,
      selectedRuntimeId: selected.runtimeId,
      surroundingRuntimeId: surrounding.runtimeId,
      doesNotEqual:
        surrounding.runtimeId !== selected.runtimeId
    });

    if (surrounding.runtimeId !== selected.runtimeId) {

      doesNotEqualTestSelector = surrounding.selector;
      doesNotEqualTestActive = true;

      status('Making the surrounding assembly transparent...');

      await api.viewer.setObjectState(
        surrounding.selector,
        {
          opacity: 0.2
        }
      );
    }

    // Do not modify the selected assembly's appearance.
    await api.viewer.setSelection(
      selected.selector,
      'set'
    );

    await api.viewer.setCamera(
      selected.selector
    );

    log('DOES NOT EQUAL - TEST COMPLETE', {
      stage: '2D.3B.7C.5',
      surroundingRequestedOpacity: 0.2,
      selectedAppearanceModified: false,
      testActive: doesNotEqualTestActive
    });

    status(
      'Does Not Equal test completed. ' +
      'Check that only the second assembly became transparent.'
    );

  } finally {
    doesNotEqualTestBusy = false;
  }
}

async function restoreDoesNotEqualTransparency() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (doesNotEqualTestBusy) {
    throw new Error('A Does Not Equal test is running.');
  }

  if (!doesNotEqualTestActive ||
      !doesNotEqualTestSelector) {
    status('No active Does Not Equal test to restore.');
    return;
  }

  doesNotEqualTestBusy = true;

  try {

    status('Restoring surrounding assembly opacity...');

    await api.viewer.setObjectState(
      doesNotEqualTestSelector,
      {
        opacity: 1
      }
    );

    doesNotEqualTestActive = false;
    doesNotEqualTestSelector = null;

    log('DOES NOT EQUAL - RESTORE', {
      stage: '2D.3B.7C.5',
      requestedOpacity: 1,
      completed: true
    });

    status(
      'Surrounding assembly opacity restored. ' +
      'Check its original appearance.'
    );

  } finally {
    doesNotEqualTestBusy = false;
  }
}

// ============================================================
// STAGE 2D.3B.7C.6A - IFC OBJECT DISCOVERY
// READ-ONLY DIAGNOSTICS
// ============================================================

let objectDiscoveryBusy = false;

async function inspectIfcObjectDiscovery() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (objectDiscoveryBusy) {
    throw new Error('Object discovery is already running.');
  }

  const modelId = el('model').value;
  const guid = el('guid').value.trim().toLowerCase();

  if (!modelId) {
    throw new Error('Select a loaded IFC model.');
  }

  if (!validGuid(guid)) {
    throw new Error('Enter a valid Tekla assembly GUID.');
  }

  objectDiscoveryBusy = true;

  try {

    status('Inspecting IFC object discovery capabilities...');

    function collectMethods(object) {

      const methods = new Set();
      let current = object;
      let depth = 0;

      while (current && depth < 5) {

        for (const name of Object.getOwnPropertyNames(current)) {

          if (name === 'constructor') continue;

          try {
            if (typeof object[name] === 'function') {
              methods.add(name);
            }
          } catch (_) {
            // Ignore inaccessible properties.
          }
        }

        current = Object.getPrototypeOf(current);
        depth++;
      }

      return Array.from(methods).sort();
    }

    const viewerMethods = collectMethods(api.viewer);

    const discoveryMethods = viewerMethods.filter(name =>
      /object|entity|hierarch|tree|child|parent|model|propert|assembl|guid/i
        .test(name)
    );

    const candidateNames = [
      'getObjects',
      'getObject',
      'getObjectTree',
      'getObjectHierarchy',
      'getModelObjects',
      'getModelObjectIds',
      'getObjectProperties',
      'getObjectChildren',
      'getChildren',
      'getEntities',
      'getModels',
      'getSelection',
      'getObjectData',
      'convertToObjectRuntimeIds',
      'convertToObjectIds'
    ];

    const candidateMethods = candidateNames.map(name => ({
      name,
      available: typeof api.viewer[name] === 'function'
    }));

    const models = await api.viewer.getModels();

    const runtimeIds =
      await api.viewer.convertToObjectRuntimeIds(
        modelId,
        [guid]
      );

    const selectedRuntimeId = runtimeIds && runtimeIds[0];

    if (!Number.isInteger(selectedRuntimeId)) {
      throw new Error(
        'Selected assembly GUID could not be resolved.'
      );
    }

    const selectedSelector = {
      modelObjectIds: [{
        modelId,
        objectRuntimeIds: [selectedRuntimeId],
        recursive: true
      }]
    };

    const report = {
      stage: '2D.3B.7C.6A',
      mode: 'Read-only',
      modelId,
      selectedGuid: guid,
      selectedRuntimeId,
      selectedSelector,
      loadedModelCount: Array.isArray(models)
        ? models.length
        : null,
      loadedModels: models,
      discoveryMethods,
      candidateMethods,
      apiNamespaces: Object.keys(api || {}),
      notes: [
        'No object appearance was modified.',
        'No isolation or camera operation was performed.',
        'Available method names do not confirm their signatures.',
        'Complete IFC hierarchy retrieval is not yet proven.',
        'Recursive selection does not provide child IDs directly.'
      ]
    };

    log('STAGE 2D.3B.7C.6A - OBJECT DISCOVERY', report);

    status(
      'Object discovery inspection completed. ' +
      'Copy the diagnostic report for review.'
    );

    return report;

  } finally {
    objectDiscoveryBusy = false;
  }
}

// ============================================================
// STAGE 2D.3B.7C.6B - IFC HIERARCHY RETRIEVAL
// READ-ONLY DIAGNOSTICS
// ============================================================

let hierarchyTestBusy = false;

async function inspectIfcHierarchy() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (hierarchyTestBusy) {
    throw new Error('Hierarchy inspection is already running.');
  }

  const modelId = el('model').value;
  const guid = el('guid').value.trim().toLowerCase();

  if (!modelId) {
    throw new Error('Select a loaded IFC model.');
  }

  if (!validGuid(guid)) {
    throw new Error('Enter a valid Tekla assembly GUID.');
  }

  hierarchyTestBusy = true;

  try {

    status('Resolving selected IFC assembly...');

    const runtimeIds =
      await api.viewer.convertToObjectRuntimeIds(
        modelId,
        [guid]
      );

    const runtimeId = runtimeIds && runtimeIds[0];

    if (!Number.isInteger(runtimeId)) {
      throw new Error('Assembly GUID could not be resolved.');
    }

    async function probe(name, callback) {

      try {

        const result = await callback();

        return {
          method: name,
          success: true,
          count: Array.isArray(result)
            ? result.length
            : null,
          sample: Array.isArray(result)
            ? result.slice(0, 5)
            : result
        };

      } catch (error) {

        return {
          method: name,
          success: false,
          error: error.message
        };
      }
    }

    status('Reading assembly children and parents...');

    const directChildren = await probe(
      'getHierarchyChildren - direct',
      () => api.viewer.getHierarchyChildren(
        modelId,
        [runtimeId]
      )
    );

    const recursiveChildren = await probe(
      'getHierarchyChildren - recursive',
      () => api.viewer.getHierarchyChildren(
        modelId,
        [runtimeId],
        undefined,
        true
      )
    );

    const directParents = await probe(
      'getHierarchyParents - direct',
      () => api.viewer.getHierarchyParents(
        modelId,
        [runtimeId]
      )
    );

    status('Reading IFC object information...');

    const selectedSelector = {
      modelObjectIds: [{
        modelId,
        objectRuntimeIds: [runtimeId],
        recursive: true
      }]
    };

    const selectedObjects = await probe(
      'getObjects - selected assembly',
      () => api.viewer.getObjects(selectedSelector)
    );

    const allObjects = await probe(
      'getObjects - all viewer objects',
      () => api.viewer.getObjects()
    );

    const report = {
      stage: '2D.3B.7C.6B',
      mode: 'Read-only',
      modelId,
      guid,
      selectedRuntimeId: runtimeId,
      tests: {
        directChildren,
        recursiveChildren,
        directParents,
        selectedObjects,
        allObjects
      },
      viewerAppearanceModified: false,
      notes: [
        'Only read-only API methods were called.',
        'Samples are limited to five entries per result.',
        'Object counts and identifier formats require review.',
        'All-viewer results may include other loaded models.'
      ]
    };

    log(
      'STAGE 2D.3B.7C.6B - IFC HIERARCHY REPORT',
      report
    );

    status(
      'Hierarchy inspection completed. ' +
      'Copy the diagnostic report for review.'
    );

    return report;

  } finally {
    hierarchyTestBusy = false;
  }
}

// ============================================================
// STAGE 2D.3B.7C.6C
// CONTROLLED AUTOMATIC SURROUNDING TRANSPARENCY
// ============================================================

let autoTransparencyBusy = false;
let autoTransparencyActive = false;
let autoTransparencySelector = null;
let autoTransparencyDetails = null;

const AUTO_TRANSPARENCY_BATCH_SIZE = 10;

async function testAutomaticTransparency() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (autoTransparencyBusy) {
    throw new Error('Automatic transparency test is running.');
  }

  if (autoTransparencyActive) {
    throw new Error('Restore the previous automatic test first.');
  }

  if (
    transparencyTestActive ||
    ghostStyleTestActive ||
    doesNotEqualTestActive
  ) {
    throw new Error(
      'Restore all earlier transparency tests before continuing.'
    );
  }

  const modelId = el('model').value;
  const guid = el('guid').value.trim().toLowerCase();

  if (!modelId) {
    throw new Error('Select a loaded IFC model.');
  }

  if (!validGuid(guid)) {
    throw new Error('Enter a valid Tekla assembly GUID.');
  }

  autoTransparencyBusy = true;

  try {

    status('Resolving selected assembly...');

    const runtimeIds =
      await api.viewer.convertToObjectRuntimeIds(
        modelId,
        [guid]
      );

    const selectedRuntimeId = runtimeIds && runtimeIds[0];

    if (!Number.isInteger(selectedRuntimeId)) {
      throw new Error('Assembly GUID could not be resolved.');
    }

    const selectedSelector = {
      modelObjectIds: [{
        modelId,
        objectRuntimeIds: [selectedRuntimeId],
        recursive: true
      }]
    };

    status('Retrieving IFC object hierarchy...');

    const allGroups = await api.viewer.getObjects();

    const protectedGroups =
      await api.viewer.getObjects(selectedSelector);

    const allGroup = allGroups.find(
      group => group.modelId === modelId
    );

    const protectedGroup = protectedGroups.find(
      group => group.modelId === modelId
    );

    if (!allGroup || !Array.isArray(allGroup.objects)) {
      throw new Error('Could not retrieve IFC model objects.');
    }

    if (
      !protectedGroup ||
      !Array.isArray(protectedGroup.objects)
    ) {
      throw new Error('Could not retrieve selected assembly objects.');
    }

    const allIds = allGroup.objects
      .map(object => object.id)
      .filter(Number.isInteger);

    const protectedIds = new Set(
      protectedGroup.objects
        .map(object => object.id)
        .filter(Number.isInteger)
    );

    protectedIds.add(selectedRuntimeId);

    const parents = await api.viewer.getHierarchyParents(
      modelId,
      [selectedRuntimeId]
    );

    const ancestorIds = [];

    for (const parent of parents || []) {
      if (Number.isInteger(parent.id)) {
        protectedIds.add(parent.id);
        ancestorIds.push(parent.id);
      }
    }

    const surroundingIds = Array.from(new Set(allIds))
      .filter(id => !protectedIds.has(id));

    const batchIds = surroundingIds.slice(
      0,
      AUTO_TRANSPARENCY_BATCH_SIZE
    );

    if (batchIds.length === 0) {
      throw new Error('No surrounding objects were found.');
    }

    const surroundingSelector = {
      modelObjectIds: [{
        modelId,
        objectRuntimeIds: batchIds,
        recursive: false
      }]
    };

    const details = {
      stage: '2D.3B.7C.6C',
      modelId,
      selectedGuid: guid,
      selectedRuntimeId,
      totalObjectIds: allIds.length,
      protectedObjectIds: Array.from(protectedIds).sort(
        (a, b) => a - b
      ),
      ancestorIds,
      surroundingObjectCount: surroundingIds.length,
      batchIds,
      requestedOpacity: 0.2,
      recursive: false
    };

    log('AUTOMATIC TRANSPARENCY - PREPARATION', details);

    autoTransparencySelector = surroundingSelector;
    autoTransparencyDetails = details;
    autoTransparencyActive = true;

    status(
      'Applying transparency to ' +
      batchIds.length +
      ' surrounding object IDs...'
    );

    await api.viewer.setObjectState(
      surroundingSelector,
      {
        opacity: 0.2
      }
    );

    log('AUTOMATIC TRANSPARENCY - APPLIED', {
      ...details,
      selectedAssemblyAppearanceModified: false,
      restoreAvailable: true
    });

    status(
      'Automatic transparency batch applied. ' +
      'Inspect the model and use Restore Automatic Transparency.'
    );

  } finally {
    autoTransparencyBusy = false;
  }
}

async function restoreAutomaticTransparency() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (autoTransparencyBusy) {
    throw new Error('Automatic transparency operation is running.');
  }

  if (!autoTransparencyActive || !autoTransparencySelector) {
    status('No active automatic transparency test to restore.');
    return;
  }

  autoTransparencyBusy = true;

  try {

    status('Restoring automatic transparency batch...');

    await api.viewer.setObjectState(
      autoTransparencySelector,
      {
        opacity: 1
      }
    );

    log('AUTOMATIC TRANSPARENCY - RESTORED', {
      stage: '2D.3B.7C.6C',
      modelId: autoTransparencyDetails.modelId,
      restoredIds: autoTransparencyDetails.batchIds,
      requestedOpacity: 1,
      completed: true
    });

    autoTransparencyActive = false;
    autoTransparencySelector = null;
    autoTransparencyDetails = null;

    status(
      'Automatic transparency batch restored. ' +
      'Check that original appearance has returned.'
    );

  } finally {
    autoTransparencyBusy = false;
  }
}


// ============================================================
// STAGE 2D.3B.7C.6D
// FULL-MODEL AUTOMATIC TRANSPARENCY
// ============================================================

let fullTransparencyBusy = false;
let fullTransparencyActive = false;
let fullTransparencyModelId = null;
let fullTransparencyBatches = [];
let fullTransparencyDetails = null;

const FULL_TRANSPARENCY_BATCH_SIZE = 50;
const FULL_TRANSPARENCY_OPACITY = 0.2;

function fullTransparencySelector(modelId, ids) {

  return {
    modelObjectIds: [{
      modelId,
      objectRuntimeIds: ids,
      recursive: false
    }]
  };
}

function fullTransparencyIds(groups, modelId) {

  const group = Array.isArray(groups)
    ? groups.find(item => item.modelId === modelId)
    : null;

  if (!group || !Array.isArray(group.objects)) {
    throw new Error(
      'Could not retrieve object IDs for model: ' + modelId
    );
  }

  if (group.objects.some(
    object => !Number.isInteger(object.id)
  )) {
    throw new Error(
      'The viewer returned an unexpected object ID format.'
    );
  }

  return [...new Set(
    group.objects.map(object => object.id)
  )];
}

function fullTransparencyParentIds(parents) {

  if (!Array.isArray(parents)) {
    throw new Error(
      'Unexpected hierarchy parent response.'
    );
  }

  if (parents.some(parent =>
    !parent || !Number.isInteger(parent.id)
  )) {
    throw new Error(
      'Unexpected parent ID format. Review hierarchy diagnostics.'
    );
  }

  return parents.map(parent => parent.id);
}

async function testFullModelTransparency() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (fullTransparencyBusy) {
    throw new Error('A full-model operation is already running.');
  }

  if (fullTransparencyActive) {
    throw new Error(
      'Restore the previous full-model transparency first.'
    );
  }

  if (
    autoTransparencyActive ||
    autoTransparencyBusy ||
    transparencyTestActive ||
    transparencyTestBusy ||
    ghostStyleTestActive ||
    ghostStyleTestBusy ||
    doesNotEqualTestActive ||
    doesNotEqualTestBusy ||
    appearanceTestBusy
  ) {
    throw new Error(
      'Finish or restore all other appearance tests first.'
    );
  }

  const modelId = el('model').value;
  const guid = el('guid').value.trim().toLowerCase();

  if (!modelId) {
    throw new Error('Select a loaded IFC model.');
  }

  if (!validGuid(guid)) {
    throw new Error('Enter a valid Tekla assembly GUID.');
  }

  fullTransparencyBusy = true;

  try {

    // --------------------------------------------------------
    // STEP 1 - RESOLVE ASSEMBLY
    // --------------------------------------------------------

    status('Resolving the selected assembly...');

    const runtimeIds =
      await api.viewer.convertToObjectRuntimeIds(
        modelId,
        [guid]
      );

    const selectedRuntimeId = runtimeIds && runtimeIds[0];

    if (!Number.isInteger(selectedRuntimeId)) {
      throw new Error(
        'Assembly GUID could not be resolved.'
      );
    }

    const selectedSelector = {
      modelObjectIds: [{
        modelId,
        objectRuntimeIds: [selectedRuntimeId],
        recursive: true
      }]
    };

    // --------------------------------------------------------
    // STEP 2 - RETRIEVE IFC OBJECTS
    // --------------------------------------------------------

    status('Retrieving all IFC objects...');

    const allGroups = await api.viewer.getObjects();

    const selectedGroups =
      await api.viewer.getObjects(selectedSelector);

    const allIds = fullTransparencyIds(
      allGroups,
      modelId
    );

    const selectedIds = fullTransparencyIds(
      selectedGroups,
      modelId
    );

    if (!selectedIds.includes(selectedRuntimeId)) {
      throw new Error(
        'Selected assembly ID missing from protected objects.'
      );
    }

    // --------------------------------------------------------
    // STEP 3 - PROTECT SELECTED ASSEMBLY
    // --------------------------------------------------------

    const protectedIds = new Set(selectedIds);

    protectedIds.add(selectedRuntimeId);

    // Protect the direct hierarchy parents.
    const parents =
      await api.viewer.getHierarchyParents(
        modelId,
        [selectedRuntimeId]
      );

    const parentIds = fullTransparencyParentIds(parents);

    for (const id of parentIds) {
      protectedIds.add(id);
    }

    // --------------------------------------------------------
    // STEP 4 - IDENTIFY SURROUNDING OBJECTS
    // --------------------------------------------------------

    const surroundingIds = allIds.filter(
      id => !protectedIds.has(id)
    );

    if (surroundingIds.length === 0) {
      throw new Error(
        'No surrounding IFC objects were found.'
      );
    }

    if (surroundingIds.some(
      id => protectedIds.has(id)
    )) {
      throw new Error(
        'Protected assembly IDs were included unexpectedly.'
      );
    }

    // --------------------------------------------------------
    // STEP 5 - CREATE BATCHES
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

    // Record restoration information before modifying
    // the appearance of any surrounding objects.

    fullTransparencyModelId = modelId;
    fullTransparencyBatches = [];
    fullTransparencyActive = true;

    fullTransparencyDetails = {
      stage: '2D.3B.7C.7',
      modelId,
      selectedGuid: guid,
      selectedRuntimeId,
      totalObjectCount: allIds.length,
      protectedObjectCount: protectedIds.size,
      protectedIds: [...protectedIds].sort(
        (a, b) => a - b
      ),
      surroundingObjectCount: surroundingIds.length,
      batchSize: FULL_TRANSPARENCY_BATCH_SIZE,
      totalBatches: batches.length,
      requestedOpacity: FULL_TRANSPARENCY_OPACITY,
      recursive: false
    };

    log(
      'FULL-MODEL TRANSPARENCY - PREPARATION',
      fullTransparencyDetails
    );

    // --------------------------------------------------------
    // STEP 6 - APPLY SURROUNDING TRANSPARENCY
    // --------------------------------------------------------

    let processed = 0;

    for (let i = 0; i < batches.length; i++) {

      const batchIds = batches[i];

      // Track each batch before applying appearance changes.
      // This allows restoration after a partial failure.

      fullTransparencyBatches.push(batchIds);

      status(
        'Applying full-model transparency: ' +
        (i + 1) + '/' + batches.length +
        ' batches (' + processed + '/' +
        surroundingIds.length + ' IDs processed)...'
      );

      await api.viewer.setObjectState(
        fullTransparencySelector(modelId, batchIds),
        {
          opacity: FULL_TRANSPARENCY_OPACITY
        }
      );

      processed += batchIds.length;

      log('FULL-MODEL TRANSPARENCY - BATCH', {
        batch: i + 1,
        totalBatches: batches.length,
        processed,
        total: surroundingIds.length,
        batchIds
      });
    }

    // ========================================================
    // STAGE 2D.3B.7C.6E
    // KEEP SELECTED ASSEMBLY FULLY OPAQUE
    // ========================================================

    // This is the successful correction from Stage 6E.
    // It must run AFTER all surrounding transparency batches.

    status('Restoring selected assembly to full opacity...');

    await api.viewer.setObjectState(
      selectedSelector,
      {
        opacity: 1
      }
    );

    // Do not modify the selected assembly's colour.
    // Its original IFC material colours must remain unchanged.

    log('FULL-MODEL TRANSPARENCY - COMPLETE', {
      ...fullTransparencyDetails,
      processed,
      selectedOpacityRequested: 1,
      selectedColourModified: false,
      restoreAvailable: true
    });

    status(
      'Full-model transparency applied to ' +
      processed +
      ' surrounding object IDs. Selected assembly is solid.'
    );

  } catch (error) {

    if (fullTransparencyActive) {

      log('FULL-MODEL TRANSPARENCY - INTERRUPTED', {
        error: error.message,
        batchesToRestore: fullTransparencyBatches.length,
        restoreAvailable: true
      });

      status(
        'Full-model transparency interrupted. ' +
        'Use Restore Model Appearance before trying again.'
      );
    }

    throw error;

  } finally {

    fullTransparencyBusy = false;
  }
}

// ============================================================
// RESTORE FULL-MODEL TRANSPARENCY
// ============================================================

async function restoreFullModelTransparency() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (fullTransparencyBusy) {
    throw new Error('A full-model operation is running.');
  }

  if (!fullTransparencyActive) {
    status('No active full-model transparency to restore.');
    return;
  }

  fullTransparencyBusy = true;

  try {

    const modelId = fullTransparencyModelId;
    const batches = fullTransparencyBatches;

    let restored = 0;

    // Restore in reverse order.
    // Keep any unsuccessful batches for a later retry.

    for (let i = batches.length - 1; i >= 0; i--) {

      const ids = batches[i];

      status(
        'Restoring full-model appearance: ' +
        (batches.length - i) + '/' +
        batches.length + ' batches...'
      );

      await api.viewer.setObjectState(
        fullTransparencySelector(modelId, ids),
        {
          opacity: 1
        }
      );

      restored += ids.length;

      batches.splice(i, 1);
    }

    log('FULL-MODEL TRANSPARENCY - RESTORED', {
      stage: '2D.3B.7C.7',
      modelId,
      restoredObjectCount: restored,
      completed: true
    });

    fullTransparencyActive = false;
    fullTransparencyModelId = null;
    fullTransparencyBatches = [];
    fullTransparencyDetails = null;

    status(
      'Full-model transparency restored. ' +
      'All surrounding objects should now be solid.'
    );

  } catch (error) {

    log('FULL-MODEL RESTORE - INTERRUPTED', {
      error: error.message,
      remainingBatches: fullTransparencyBatches.length
    });

    throw error;

  } finally {

    fullTransparencyBusy = false;
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
// STAGE 2D.3B.7C.7
// FIND ASSEMBLY WITH AUTOMATIC TRANSPARENCY
// ============================================================

async function findAssembly() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (assemblyNavigationBusy || fullTransparencyBusy) {
    throw new Error('Assembly navigation is already running.');
  }

  const guid =
    el('guid').value.trim().toLowerCase();

  const modelId = el('model').value;

  if (!validGuid(guid)) {
    throw new Error(
      'Enter a valid 36-character Tekla assembly GUID.'
    );
  }

  if (!modelId) {
    throw new Error(
      'Choose a model. Open the IFC in the 3D viewer first.'
    );
  }

  assemblyNavigationBusy = true;

  try {

    // --------------------------------------------------------
    // STEP 1 - RESOLVE TARGET BEFORE CHANGING APPEARANCE
    // --------------------------------------------------------

    status('Resolving Tekla assembly GUID...');

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

    const runtimeId = runtimeIds && runtimeIds[0];

    if (!Number.isInteger(runtimeId)) {
      throw new Error(
        'Assembly GUID not resolved in this model.'
      );
    }

    const selector = {
      modelObjectIds: [{
        modelId,
        objectRuntimeIds: [runtimeId],
        recursive: true
      }]
    };

    // --------------------------------------------------------
    // STEP 2 - CHECK FOR OTHER ACTIVE APPEARANCE TESTS
    // --------------------------------------------------------

    if (
      autoTransparencyActive ||
      autoTransparencyBusy ||
      transparencyTestActive ||
      transparencyTestBusy ||
      ghostStyleTestActive ||
      ghostStyleTestBusy ||
      doesNotEqualTestActive ||
      doesNotEqualTestBusy ||
      appearanceTestBusy
    ) {
      throw new Error(
        'Restore any earlier appearance tests before navigating.'
      );
    }

    // --------------------------------------------------------
    // STEP 3 - RESTORE PREVIOUS NAVIGATION
    // --------------------------------------------------------

    if (fullTransparencyActive) {

      status('Restoring previous assembly appearance...');

      await restoreFullModelTransparency();

      if (fullTransparencyActive) {
        throw new Error(
          'Previous transparency could not be fully restored.'
        );
      }
    }

    // --------------------------------------------------------
    // STEP 4 - APPLY AUTOMATIC TRANSPARENCY
    // --------------------------------------------------------

    status('Applying automatic surrounding transparency...');

    // Reuse the successful Stage 6D/6E functionality.
    // The function reads the current GUID and model fields,
    // applies 20% opacity to surrounding objects, and
    // restores the selected assembly to 100% opacity.

    await testFullModelTransparency();

    // --------------------------------------------------------
    // STEP 5 - SELECT AND ZOOM
    // --------------------------------------------------------

    status('Selecting assembly...');

    await api.viewer.setSelection(
      selector,
      'set'
    );

    status('Zooming to assembly...');

    await api.viewer.setCamera(selector);

    lastAssemblySelector = selector;

    // --------------------------------------------------------
    // STEP 6 - REPORT SUCCESS
    // --------------------------------------------------------

    log('ASSEMBLY NAVIGATION - COMPLETE', {
      stage: '2D.3B.7C.7',
      modelId,
      guid,
      runtimeId,
      surroundingOpacity: FULL_TRANSPARENCY_OPACITY,
      selectedOpacity: 1,
      originalIfcColoursPreserved: true,
      nativeGhostModeRequired: false,
      restoreAvailable: true
    });

    status(
      'Assembly located successfully. Selected assembly is ' +
      'solid and surrounding IFC objects are transparent.'
    );

    return true;

  } catch (error) {

    log('ASSEMBLY NAVIGATION - ERROR', {
      stage: '2D.3B.7C.7',
      error: error.message,
      transparencyRestoreAvailable: fullTransparencyActive
    });

    throw error;

  } finally {

    assemblyNavigationBusy = false;
  }
}

// ============================================================
// STAGE 2D.3B.7C.7
// RESTORE MODEL APPEARANCE
// ============================================================

async function restoreNavigationAppearance() {

  if (!api) {
    throw new Error('Connect to Trimble Connect first.');
  }

  if (assemblyNavigationBusy || fullTransparencyBusy) {
    throw new Error(
      'Wait for the current navigation operation to finish.'
    );
  }

  if (!fullTransparencyActive) {
    status('No active navigation transparency to restore.');
    return;
  }

  await restoreFullModelTransparency();

  if (!fullTransparencyActive) {

    lastAssemblySelector = null;

    log('ASSEMBLY NAVIGATION - APPEARANCE RESTORED', {
      stage: '2D.3B.7C.7',
      completed: true
    });

    status(
      'Model appearance restored. All surrounding objects ' +
      'should now be fully opaque.'
    );
  }
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

        // Automatic transparency replaces the old
        // native Ghost Mode requirement.

        if (completed !== true) {
          throw new Error(
            'Automatic assembly navigation did not complete.'
          );
        }

        autoNavigationPending = false;

        status(
          'Automatic assembly navigation completed. ' +
          'Selected assembly is solid and surrounding ' +
          'IFC objects are transparent.'
        );

        log('Automatic navigation successful', {
          teklaGuid: incomingGuid,
          modelId: modelSelect.value,
          attempt
        });

        return;

      } catch (error) {

        log('Automatic navigation retry', {
          attempt,
          error: error.message
        });

        // Do not retry when appearance changes may
        // have been partially applied.

        if (fullTransparencyActive) {
          throw new Error(
            'Navigation stopped after an appearance error. ' +
            'Use Restore Model Appearance before retrying. ' +
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

    status(
      'Automatic navigation failed: ' +
      error.message
    );

    log(
      'Automatic navigation failed',
      String(error)
    );

  } finally {

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

// Stage 2D.3B.7C.7
// Restore model appearance button.

el('restoreNavigation').addEventListener(
  'click',
  run(restoreNavigationAppearance)
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
// STAGE 2D.3B.7C.2 - APPEARANCE TEST BUTTONS
// ============================================================

el('testAssemblyColour').addEventListener(
  'click',
  run(testAssemblyColour)
);

el('testSingleOpacity').addEventListener(
  'click',
  run(testSingleObjectOpacity)
);

el('resetSingleAppearance').addEventListener(
  'click',
  run(resetSingleObjectAppearance)
);

// ============================================================
// STAGE 2D.3B.7C.4 - GHOST-STYLE BUTTONS
// ============================================================

el('testGhostStyle').addEventListener(
  'click',
  run(testGhostStyleTransparency)
);

el('restoreGhostStyle').addEventListener(
  'click',
  run(restoreGhostStyleTransparency)
);

// ============================================================
// STAGE 2D.3B.7C.5 - DOES NOT EQUAL BUTTONS
// ============================================================

el('testDoesNotEqual').addEventListener(
  'click',
  run(testDoesNotEqualTransparency)
);

el('restoreDoesNotEqual').addEventListener(
  'click',
  run(restoreDoesNotEqualTransparency)
);

// ============================================================
// STAGE 2D.3B.7C.6A - OBJECT DISCOVERY BUTTON
// ============================================================

el('inspectObjectDiscovery').addEventListener(
  'click',
  run(inspectIfcObjectDiscovery)
);

// ============================================================
// STAGE 2D.3B.7C.6B - HIERARCHY TEST BUTTON
// ============================================================

el('inspectIfcHierarchy').addEventListener(
  'click',
  run(inspectIfcHierarchy)
);

// ============================================================
// STAGE 2D.3B.7C.6C - AUTOMATIC TRANSPARENCY BUTTONS
// ============================================================

el('testAutomaticTransparency').addEventListener(
  'click',
  run(testAutomaticTransparency)
);

el('restoreAutomaticTransparency').addEventListener(
  'click',
  run(restoreAutomaticTransparency)
);

// ============================================================
// STAGE 2D.3B.7C.6D - FULL-MODEL TRANSPARENCY BUTTONS
// ============================================================

el('testFullModelTransparency').addEventListener(
  'click',
  run(testFullModelTransparency)
);

el('restoreFullModelTransparency').addEventListener(
  'click',
  run(restoreFullModelTransparency)
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

  } else {

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

// ============================================================
// END OF BPA ASSEMBLY NAVIGATOR
// STAGE 2D.3B.7C.7
// ============================================================


