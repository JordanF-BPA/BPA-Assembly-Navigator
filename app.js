/* BPA Assembly Navigator - Stage 2D.3A. No access tokens or credentials are stored. */
'use strict';
let api = null;
const el = id => document.getElementById(id);
const log = (message, value) => {
  const line = message + (value === undefined ? '' : '\n' + JSON.stringify(value, null, 2));
  el('log').textContent = line + '\n\n' + el('log').textContent;
};
const status = message => { el('status').textContent = message; };
const run = fn => async () => { try { await fn(); } catch (error) { status('Error: ' + error.message); log('ERROR', String(error)); } };
const validGuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

async function connect() {
  status('Connecting to Trimble Connect viewer...');
  if (!window.TrimbleConnectWorkspace) throw new Error('Trimble Workspace API script did not load.');
  if (!api) {
    api = await window.TrimbleConnectWorkspace.connect(window.parent, (event, data) => {
      if (event === 'viewer.onSelectionChanged') log('Viewer selection changed', data);
    }, 30000);
  }
  const project = await api.project.getProject();
  log('Connected to project', { id: project?.id, name: project?.name });
  const models = await api.viewer.getModels();
  const select = el('model');
  select.replaceChildren();
  for (const model of models || []) {
    const id = model.id || model.modelId || model.versionId;
    if (!id) continue;
    const option = document.createElement('option');
    option.value = id;
    option.textContent = (model.name || model.fileName || id) + ' (' + id + ')';
    select.appendChild(option);
  }
  log('Available models (inspect identifiers and loading state)', models);
  status('Connected. Choose the loaded IFC model, then Find, Select & Zoom.');
}

async function readSelected() {
  if (!api) throw new Error('Connect first.');
  const selection = await api.viewer.getSelection();
  log('Current selection (modelId and objectRuntimeIds)', selection);
  status('Selection read. Check diagnostics for model and runtime IDs.');
}

async function findAssembly() {
  if (!api) throw new Error('Connect first.');
  const guid = el('guid').value.trim().toLowerCase();
  if (!validGuid(guid)) throw new Error('Enter a valid 36-character Tekla assembly GUID.');
  const modelId = el('model').value;
  if (!modelId) throw new Error('Choose a model. Open the IFC in the 3D viewer first.');
  status('Resolving IFC object GUID...');
  const runtimeIds = await api.viewer.convertToObjectRuntimeIds(modelId, [guid]);
  log('GUID -> runtime ID result', { modelId, guid, runtimeIds });
  const id = runtimeIds && runtimeIds[0];
  if (!Number.isInteger(id)) {
    throw new Error('Assembly GUID not resolved in this model. Check model selection, IFC version and GUID.');
  }
  const selector = { modelObjectIds: [{ modelId, objectRuntimeIds: [id], recursive: true }] };
  await api.viewer.setSelection(selector, 'set');
  status('Object selected. Fitting camera...');
  await api.viewer.setCamera(selector);
  status('Selection and camera commands completed. Confirm the assembly is highlighted and visible.');
  log('Selected and zoomed', { modelId, guid, runtimeId: id });
}

el('connect').addEventListener('click', run(connect));
el('read').addEventListener('click', run(readSelected));
el('find').addEventListener('click', run(findAssembly));
