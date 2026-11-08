"use strict";

// This channel is shared only among BPA frames in the same browser storage partition.
// Discover first, then address a single viewer. Other viewers must not navigate.
const connectTabId = crypto.randomUUID();
let connectTabChannel = null;
try {
    connectTabChannel = new BroadcastChannel("BPA_CONNECT_DIRECT_DRAWING_TRIAL");
} catch (error) {
    log("Connect tab reuse unavailable", error.message);
}
const receivedConnectRequests = new Set();

// The Chrome helper delivers directly into an already-loaded viewer frame.
document.addEventListener("bpa-fast-drawing", async event => {
    let data;
    try {
        data = JSON.parse(event.detail);
        if (typeof data.requestId !== "string" || typeof data.guid !== "string" ||
            !validTarget(data.guid)) return;
        if (!await canReceiveDrawing(data)) return;
        latestLiveRequest = {guid:data.guid, modelId:data.modelId};
        log("Fast drawing received from Chrome helper", {guid:data.guid, modelId:data.modelId});
        void processLiveNavigation();
        document.dispatchEvent(new CustomEvent("bpa-fast-drawing-result", {
            detail:JSON.stringify({requestId:data.requestId, ok:true})
        }));
    } catch (error) { log("Fast drawing handoff unavailable", error.message); }
});

function notifyDirectTabHelper(role, data, viewerId) {
    document.dispatchEvent(new CustomEvent("bpa-direct-tab-handoff", {detail:JSON.stringify({
        role, requestId:data.requestId, viewerId,
        projectId:data.projectId, modelId:data.modelId, guid:data.guid
    })}));
}

async function canReceiveDrawing(data) {
    if (!api || connectionBusy || directDrawingCommand ||
        typeof data.projectId !== "string" || typeof data.modelId !== "string") return false;
    if ((await api.extension.getHost()).name !== "3dviewer") return false;
    if ((await api.project.getProject()).id !== data.projectId) return false;
    return el("model").value === data.modelId &&
        (await api.viewer.getModels()).some(model =>
            (model.id || model.modelId || model.versionId) === data.modelId);
}

if (connectTabChannel) connectTabChannel.addEventListener("message", async ({data}) => {
    if (!data || typeof data.requestId !== "string" || data.sender === connectTabId ||
        !["discover", "navigate"].includes(data.type)) return;
    try {
        if (data.type === "navigate" && data.receiver !== connectTabId) return;
        if (!await canReceiveDrawing(data)) return;
        if (data.type === "discover") {
            connectTabChannel.postMessage({type:"offer", requestId:data.requestId, receiver:data.sender, sender:connectTabId});
            return;
        }
        if (typeof data.guid !== "string" || !validTarget(data.guid)) return;
        if (!receivedConnectRequests.has(data.requestId)) {
            receivedConnectRequests.add(data.requestId);
            if (receivedConnectRequests.size > 100) receivedConnectRequests.delete(receivedConnectRequests.values().next().value);
            latestLiveRequest = {guid:data.guid, modelId:data.modelId};
            log("Direct drawing received from another Connect tab", {guid:data.guid, modelId:data.modelId});
            void processLiveNavigation();
        }
        notifyDirectTabHelper("received", data, connectTabId);
        connectTabChannel.postMessage({type:"accepted", requestId:data.requestId, receiver:data.sender, sender:connectTabId});
        try { window.top.focus(); } catch (_) { /* Browser controls tab focus. */ }
    } catch (error) {
        log("Connect tab handoff failed", error.message);
    }
});

async function handoffDirectDrawing(projectId, modelId, guid) {
    if (!connectTabChannel) return false;
    status("Checking for an open Connect viewer for this model…");
    const requestId = crypto.randomUUID();
    const base = {requestId, sender:connectTabId, projectId, modelId};
    const accepted = await new Promise(resolve => {
        let viewer, timeout, retry;
        function finish(value) {
            clearTimeout(timeout);
            clearTimeout(retry);
            connectTabChannel.removeEventListener("message", receive);
            resolve(value);
        }
        function receive({data}) {
            if (!data || data.requestId !== requestId || data.receiver !== connectTabId) return;
            if (data.type === "offer" && !viewer && typeof data.sender === "string") {
                viewer = data.sender;
                clearTimeout(timeout);
                clearTimeout(retry);
                timeout = setTimeout(() => finish(false), 3000);
                const delivery = {...base, type:"navigate", receiver:viewer, guid};
                connectTabChannel.postMessage(delivery);
                retry = setTimeout(() => connectTabChannel.postMessage(delivery), 1000);
            } else if (data.type === "accepted" && viewer && data.sender === viewer) {
                finish(viewer);
            }
        }
        connectTabChannel.addEventListener("message", receive);
        timeout = setTimeout(() => finish(false), 1800);
        connectTabChannel.postMessage({...base, type:"discover"});
        retry = setTimeout(() => connectTabChannel.postMessage({...base, type:"discover"}), 700);
    });
    if (!accepted) {
        log("No existing viewer acknowledged. Opening this drawing here.");
        return false;
    }
    log("Existing Connect viewer acknowledged drawing", {guid, projectId, modelId});
    notifyDirectTabHelper("sent", {...base, guid}, accepted);
    status("Drawing sent to your existing Connect viewer. You can close this temporary tab.");
    function closeTemporaryTab() {
        try {
            window.top.close();
        } catch (error) {
            log("Temporary tab close error", {name:error.name, message:error.message});
        }
        setTimeout(() => {
            status("Drawing received by the existing viewer. Chrome kept this tab open. Press Ctrl+W to close this temporary tab.");
            log("Temporary tab still open after close request");
        }, 600);
    }
    let closeButton = document.getElementById("closeHandoffTab");
    if (!closeButton) {
        closeButton = document.createElement("button");
        closeButton.id = "closeHandoffTab";
        closeButton.type = "button";
        closeButton.textContent = "Close this tab";
        closeButton.addEventListener("click", closeTemporaryTab);
        el("status").insertAdjacentElement("afterend", closeButton);
    }
    closeTemporaryTab();
    return true;
}
