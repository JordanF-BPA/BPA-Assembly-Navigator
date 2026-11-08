// Non-modal controls stay inside the Navigator frame; the 3D viewer remains usable.
let steppedAssembly = null;
let assemblyStepIndex = -1;

function clearAssemblyStepper() {
  steppedAssembly = null;
  assemblyStepIndex = -1;
  document.getElementById('assemblyStepper').close();
}

function showAssemblyStepper(assembly) {
  const roots = [...new Set(assembly.rootIds || [assembly.runtimeId])];
  clearAssemblyStepper();
  if (roots.length < 2) return;
  steppedAssembly = {...assembly, rootIds: roots};
  document.getElementById('assemblyStepperTitle').textContent =
    assembly.position ? 'Assembly ' + assembly.position : 'Drawing assemblies';
  renderAssemblyStep();
  document.getElementById('assemblyStepper').show();
}

function renderAssemblyStep() {
  if (!steppedAssembly) return;
  const total = steppedAssembly.rootIds.length;
  document.getElementById('assemblyStepperCount').textContent = assemblyStepIndex < 0
    ? 'Showing all ' + total + ' assemblies'
    : 'Assembly ' + (assemblyStepIndex + 1) + ' of ' + total;
}

function updateAssemblyStepperButtons(busy) {
  for (const id of ['assemblyPrevious', 'assemblyNext', 'assemblyAll']) {
    document.getElementById(id).disabled = busy || !steppedAssembly;
  }
}

async function stepAssembly(direction) {
  if (!steppedAssembly || assemblyNavigationBusy || fullTransparencyBusy ||
      connectionBusy || autoNavigationRunning) return;
  const group = steppedAssembly;
  const count = group.rootIds.length;
  const next = direction === 0 ? -1 : assemblyStepIndex < 0
    ? (direction > 0 ? 0 : count - 1)
    : (assemblyStepIndex + direction + count) % count;
  const selector = next < 0 ? group.selector :
    createObjectSelector(group.modelId, [group.rootIds[next]], true);
  assemblyNavigationBusy = true;
  updateButtons();
  try {
    await api.viewer.setSelection(selector, 'set');
    await api.viewer.setCamera(selector);
    assemblyStepIndex = next;
    renderAssemblyStep();
  } catch (error) {
    reportError(error);
  } finally {
    assemblyNavigationBusy = false;
    updateButtons();
  }
}

document.getElementById('assemblyPrevious').addEventListener('click', () => stepAssembly(-1));
document.getElementById('assemblyNext').addEventListener('click', () => stepAssembly(1));
document.getElementById('assemblyAll').addEventListener('click', () => stepAssembly(0));
