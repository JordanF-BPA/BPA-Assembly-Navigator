'use strict';
// A file ID (not a version ID) follows later revisions of the same published model.
const projectChoiceId = /^[A-Za-z0-9_-]{1,64}$/;
const projectChoiceKey = project => 'BPA_PROJECT_MODEL_V1:' + project;
let projectChoiceRequest = null;
let projectChoiceFile = null;
let projectChoiceBrowser = null;
let projectChoiceTokenWaiter = null;
let projectChoiceGeneration = 0;
let projectChoiceSession = null;
async function refreshProjectChoiceSession() {
    if (!document.dispatchEvent) return;
    projectChoiceSession = await new Promise(resolve => {
        const requestId = crypto.randomUUID();
        const finish = value => {
            clearTimeout(timer);
            document.removeEventListener('bpa-model-session-result', receive);
            resolve(value);
        };
        const receive = event => {
            try {
                const result = JSON.parse(event.detail);
                if (result.requestId === requestId) finish(result.session || null);
            } catch (_) { /* Ignore unrelated events. */ }
        };
        const timer = setTimeout(() => finish(null), 1500);
        document.addEventListener('bpa-model-session-result', receive);
        document.dispatchEvent(new CustomEvent('bpa-model-session-request',{detail:requestId}));
    });
}

function readProjectModel(project) {
    try {
        const value = JSON.parse(localStorage.getItem(projectChoiceKey(project)) || 'null');
        return value && value.projectId === project && projectChoiceId.test(value.modelId || '') &&
            (!projectChoiceSession || value.session === projectChoiceSession) ? value : null;
    } catch (_) { return null; }
}
function rememberProjectModel(project, file) {
    const value = {projectId:project, modelId:file.id, name:file.name, session:projectChoiceSession};
    try { localStorage.setItem(projectChoiceKey(project), JSON.stringify(value)); return true; }
    catch (_) { return false; }
}
function handleModelChoiceEvent(event, args) {
    // Access tokens remain in memory and are passed only to Trimble's embedded explorer.
    if (event === 'extension.accessToken' && projectChoiceTokenWaiter && typeof args?.data === 'string') {
        projectChoiceTokenWaiter(args.data);
    }
}
async function requestProjectBrowserToken() {
    if (projectChoiceTokenWaiter) throw Error('Model browser is already connecting.');
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, token) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout); projectChoiceTokenWaiter = null;
            error ? reject(error) : resolve(token);
        };
        const timeout = setTimeout(() => finish(Error('Connect permission timed out. Click Browse project models to retry.')), 30000);
        projectChoiceTokenWaiter = token => finish(null, token);
        Promise.resolve(api.extension.requestPermission('accesstoken')).then(result => {
            if (result === 'denied') finish(Error('Allow Connect access to browse project models.'));
            // First approval arrives as an event. Subsequent calls return the token itself.
            else if (typeof result === 'string' && result && result !== 'pending' && result !== 'granted') finish(null, result);
        }).catch(error => finish(error));
    });
}
function modelFileFromEvent(args) {
    // Project-extension events wrap the file; embedded explorer actions carry it directly.
    const payload = args?.data?.file || args?.data;
    const file = Array.isArray(payload) ? (payload.length === 1 ? payload[0] : null) : payload;
    return file && file.type === 'FILE' && projectChoiceId.test(file.id || '') &&
        /\.(ifc|trb|tekla)$/i.test(file.name || '') ? {id:file.id, name:file.name} : null;
}
async function showProjectModelChoice(projectId, guid) {
    if (!projectChoiceId.test(projectId)) throw Error('Invalid Connect project.');
    projectChoiceRequest = {projectId, guid};
    projectChoiceGeneration++;
    projectChoiceFile = null;
    el('confirmProjectModel').disabled = true;
    el('projectModelChoice').hidden = false;
    el('modelChoiceMessage').textContent = 'Choose the model containing this drawing’s assemblies.';
    status('Select a model once for this project.');
}
async function browseProjectModels() {
    const request = projectChoiceRequest;
    if (!request) throw Error('Open a drawing link or choose Change remembered model first.');
    const generation = ++projectChoiceGeneration;
    projectChoiceBrowser = null;
    projectChoiceFile = null;
    el('confirmProjectModel').disabled = true;
    el('loadModelBrowser').disabled = true;
    try {
        const token = await requestProjectBrowserToken();
        if (generation !== projectChoiceGeneration) return;
        // Workspace API caches connections by iframe window. A new frame gets a fresh callback.
        const previousFrame = el('projectModelBrowser');
        const frame = previousFrame.cloneNode(false);
        frame.removeAttribute('src');
        previousFrame.replaceWith(frame);
        frame.hidden = false;
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(Error('Model browser did not load. Try Browse project models again.')), 30000);
            frame.onload = () => { clearTimeout(timeout); resolve(); };
            frame.src = TrimbleConnectWorkspace.getConnectEmbedUrl();
        });
        const browser = await TrimbleConnectWorkspace.connect(frame, (event, args) => {
            if (generation !== projectChoiceGeneration) return;
            if (event === 'extension.fileSelected' || event === 'extension.fileViewClicked' || event === 'embed.onAction') {
                projectChoiceFile = modelFileFromEvent(args);
                el('confirmProjectModel').disabled = !projectChoiceFile;
                el('modelChoiceMessage').textContent = projectChoiceFile ? 'Selected: ' + projectChoiceFile.name : 'Select one IFC, TrimBIM or Tekla model file.';
            }
            if (event === 'extension.sessionInvalid' || event === 'embed.session.invalid') {
                projectChoiceFile = null;
                el('confirmProjectModel').disabled = true;
                el('modelChoiceMessage').textContent = 'Sign-in expired. Click Browse project models again.';
            }
        }, 30000);
        if (generation !== projectChoiceGeneration) return;
        if (await browser.embed.setTokens({accessToken:token}) === false)
            throw Error('Connect rejected the model browser session. Click Browse project models to retry.');
        const accepted = await browser.embed.initFileExplorer({projectId:request.projectId,
            enableAdd:false, enableUploadFiles:false, enableCreateFolder:false,
            enableExplorerAllProjects:false, enableExplorerKebabMenu:false, enableSelect:false,
            fileTypeFilter:['ifc','trb','tekla']});
        if (accepted === false) throw Error('Connect could not open the project model browser.');
        if (generation !== projectChoiceGeneration) return;
        projectChoiceBrowser = browser;
    } finally { el('loadModelBrowser').disabled = false; }
}
async function navigateProjectModel(projectId, modelId, guid) {
    if ((await api.project.getProject()).id !== projectId) throw Error('The active Connect project changed. Reopen the drawing link.');
    el('guid').value = guid;
    const host = await api.extension.getHost();
    if (host.name === 'project') {
        if (typeof handoffDirectDrawing === 'function' && await handoffDirectDrawing(projectId, modelId, guid)) return;
        await launchPendingAssemblyInViewer(projectId, modelId);
    } else if (host.name === '3dviewer') {
        const models = await api.viewer.getModels();
        if (models.some(model => (model.id || model.modelId) === modelId)) {
            latestLiveRequest = {guid, modelId};
            await processLiveNavigation();
        } else {
            // Re-enter the project extension to load the newly chosen model.
            const match = positionTarget.exec(guid);
            if (!match) throw Error('Reopen the drawing QR to switch to an unloaded model.');
            window.open('https://web.connect.trimble.com/projects/' + projectId +
                '/extension/583cfc91-ce7a-84d0-e830-885658dad4fb/BPA_NAVIGATOR_DRAWING_' +
                match[1] + '_' + match[2] + '_' + modelId, '_top');
        }
    } else throw Error('Open BPA Navigator inside Connect Project Explorer or the 3D viewer.');
}
async function openProjectDrawing(projectId, guid) {
    await refreshProjectChoiceSession();
    projectChoiceRequest = {projectId, guid};
    const saved = readProjectModel(projectId);
    if (!saved) { await showProjectModelChoice(projectId, guid); return; }
    el('rememberedProjectModel').textContent = 'Using: ' + saved.name;
    try { await navigateProjectModel(projectId, saved.modelId, guid); }
    catch (error) {
        await showProjectModelChoice(projectId, guid);
        el('modelChoiceMessage').textContent = 'Could not open the remembered model. Choose another model. ' + error.message;
    }
}
async function confirmProjectModel() {
    await refreshProjectChoiceSession();
    const request = projectChoiceRequest, file = projectChoiceFile;
    if (!request || !file || !projectChoiceBrowser) throw Error('Select a project model first.');
    if ((await projectChoiceBrowser.project.getProject()).id !== request.projectId ||
        (await api.project.getProject()).id !== request.projectId) throw Error('Model selection belongs to a different project.');
    const saved = rememberProjectModel(request.projectId, file);
    el('rememberedProjectModel').textContent = 'Using: ' + file.name + (saved ? '' : ' (browser storage unavailable; choice cannot be remembered)');
    el('projectModelChoice').hidden = true;
    if (validTarget(request.guid)) await navigateProjectModel(request.projectId, file.id, request.guid);
    else status('Model choice saved. Open a drawing link to continue.');
}
// Loaded before app.js; listeners run only after its API and UI helpers are available.
document.getElementById('loadModelBrowser').addEventListener('click', () => browseProjectModels().catch(reportError));
document.getElementById('confirmProjectModel').addEventListener('click', () => confirmProjectModel().catch(reportError));
document.getElementById('changeProjectModel').addEventListener('click', async () => {
    try {
        if (!api) await connect();
        const project = await api.project.getProject();
        await showProjectModelChoice(project.id, el('guid').value.trim());
    } catch (error) { reportError(error); }
});
