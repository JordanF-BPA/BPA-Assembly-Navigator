// Non-modal controls stay inside the Navigator frame; the 3D viewer remains usable.
let steppedAssembly = null;
let assemblyStepIndex = -1;
let stepperToken = 'initial';

function clearAssemblyStepper() {
  steppedAssembly = null;
  assemblyStepIndex = -1;
  stepperToken = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  document.getElementById('assemblyStepper').close();
  publishAssemblyStepper();
}

function showAssemblyStepper(assembly) {
  const roots = [...new Set(assembly.rootIds || [assembly.runtimeId])];
  clearAssemblyStepper();
  if (roots.length < 2) return;
  steppedAssembly = {...assembly, rootIds: roots};
  document.getElementById('assemblyStepperTitle').textContent =
    assembly.position ? 'Assembly ' + assembly.position : 'Drawing assemblies';
  renderAssemblyStep();
  if (!stepperOverlaySeen) document.getElementById('assemblyStepper').show();
  publishAssemblyStepper(true);
  if (assemblyStepperPosition) positionAssemblyStepper(assemblyStepperPosition.x, assemblyStepperPosition.y);
}

function renderAssemblyStep() {
  if (!steppedAssembly) return;
  const total = steppedAssembly.rootIds.length;
  document.getElementById('assemblyStepperCount').textContent = assemblyStepIndex < 0
    ? 'Showing all ' + total + ' assemblies'
    : 'Assembly ' + (assemblyStepIndex + 1) + ' of ' + total;
  publishAssemblyStepper();
}

function updateAssemblyStepperButtons(busy) {
  for (const id of ['assemblyPrevious', 'assemblyNext', 'assemblyAll']) {
    document.getElementById(id).disabled = busy || !steppedAssembly;
  }
  publishAssemblyStepper();
}

async function stepAssembly(direction) {
  if (!steppedAssembly || assemblyNavigationBusy || fullTransparencyBusy ||
      connectionBusy || autoNavigationRunning) return {ok:false,error:'Navigator is busy. Please try again in a moment.'};
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
    return {ok:true};
  } catch (error) {
    reportError(error);
    return {ok:false,error:error.message};
  } finally {
    assemblyNavigationBusy = false;
    updateButtons();
  }
}

document.getElementById('assemblyPrevious').addEventListener('click', () => stepAssembly(-1));
document.getElementById('assemblyNext').addEventListener('click', () => stepAssembly(1));
document.getElementById('assemblyAll').addEventListener('click', () => stepAssembly(0));

// Keep the chosen position across drawing links in this viewer session.
let assemblyStepperPosition = null;
let assemblyStepperDrag = null;
const stepperDialog = document.getElementById('assemblyStepper');
const stepperHandle = document.getElementById('assemblyStepperTitle');

function positionAssemblyStepper(x, y) {
  const box = stepperDialog.getBoundingClientRect();
  const viewport = document.documentElement;
  x = Math.max(0, Math.min(x, viewport.clientWidth - box.width));
  y = Math.max(0, Math.min(y, viewport.clientHeight - box.height));
  assemblyStepperPosition = {x, y};
  Object.assign(stepperDialog.style, {left:x+'px', top:y+'px', right:'auto', bottom:'auto', margin:'0'});
}

stepperHandle.addEventListener('pointerdown', event => {
  if (event.button !== 0 || assemblyStepperDrag) return;
  const box = stepperDialog.getBoundingClientRect();
  assemblyStepperDrag = {id:event.pointerId, x:event.clientX-box.left, y:event.clientY-box.top};
  stepperHandle.setPointerCapture(event.pointerId);
  event.preventDefault();
});
stepperHandle.addEventListener('pointermove', event => {
  if (assemblyStepperDrag?.id !== event.pointerId) return;
  positionAssemblyStepper(event.clientX-assemblyStepperDrag.x, event.clientY-assemblyStepperDrag.y);
});
function finishAssemblyStepperDrag(event) {
  if (assemblyStepperDrag?.id !== event.pointerId) return;
  assemblyStepperDrag = null;
  if (stepperHandle.hasPointerCapture(event.pointerId)) stepperHandle.releasePointerCapture(event.pointerId);
}
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  stepperHandle.addEventListener(name, finishAssemblyStepperDrag);
}
stepperHandle.addEventListener('keydown', event => {
  const direction = {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]}[event.key];
  if (!direction) return;
  event.preventDefault();
  const box = stepperDialog.getBoundingClientRect();
  positionAssemblyStepper(box.left+direction[0]*10, box.top+direction[1]*10);
});
document.defaultView?.addEventListener('resize', () => {
  if (stepperDialog.open && assemblyStepperPosition) {
    positionAssemblyStepper(assemblyStepperPosition.x, assemblyStepperPosition.y);
  }
});

function publishAssemblyStepper(claim = false) {
  if (!document.dispatchEvent) return;
  document.dispatchEvent(new CustomEvent('bpa-stepper-state', {detail:JSON.stringify({
    token:stepperToken, claim, title:steppedAssembly?.position ? 'Assembly '+steppedAssembly.position : 'Drawing assemblies',
    count:steppedAssembly?.rootIds.length || 0, index:assemblyStepIndex,
    busy:assemblyNavigationBusy || fullTransparencyBusy || connectionBusy || autoNavigationRunning
  })}));
}
let stepperOverlaySeen = 0;
document.addEventListener?.('bpa-stepper-overlay-ready', () => {
  stepperOverlaySeen = Date.now();
  stepperDialog.close();
});
document.addEventListener?.('bpa-stepper-action', async event => {
  let message;
  try { message = JSON.parse(event.detail); } catch (_) { return; }
  let result = {ok:false,error:'This drawing has changed. Use its current controls.'};
  if (message.token === stepperToken && [-1,0,1].includes(message.direction)) result = await stepAssembly(message.direction);
  publishAssemblyStepper();
  document.dispatchEvent(new CustomEvent('bpa-stepper-action-result',{detail:JSON.stringify({...result,requestId:message.requestId})}));
});
document.defaultView?.setInterval(() => {
  publishAssemblyStepper();
  // Once the helper owns the UI, delayed heartbeats must not reopen the fallback.
  if (steppedAssembly && !stepperOverlaySeen && !stepperDialog.open) stepperDialog.show();
},2000);
