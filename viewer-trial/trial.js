"use strict";
(async function startTrial() {
  const callback = location.origin + location.pathname;
  const sessionKey = "bpa-viewer-trial-login";
  const params = new URLSearchParams(location.search);
  let drawing = params;
  const id = /^[A-Za-z0-9_-]{1,64}$/;
  function target(position, quantity) {
    if (typeof position !== "string" || !position.trim() || position.length > 79 ||
        !/^[1-9]\d{0,8}$/.test(quantity)) throw Error("Invalid drawing position or quantity.");
    const hex = Array.from(new TextEncoder().encode(position), b => b.toString(16).padStart(2, "0")).join("");
    return "pos-" + hex + "-" + quantity;
  }
  function base64url(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  }
  let login;
  if (params.has("code") || params.has("error")) {
    login = JSON.parse(sessionStorage.getItem(sessionKey) || "null");
    sessionStorage.removeItem(sessionKey);
    history.replaceState(null, "", callback);
    if (!login || login.state !== params.get("state") || Date.now() - login.time > 900000)
      throw Error("Sign-in expired. Reopen the trial drawing link.");
    drawing = new URLSearchParams(login.drawing);
    history.replaceState(null, "", callback + "?" + drawing);
    if (params.has("error")) throw Error("Trimble sign-in was declined. Reload to retry.");
  }
  const project = drawing.get("j"), model = drawing.get("m");
  if (!id.test(project || "") || !id.test(model || "")) throw Error("Open the trial with a drawing project and model.");
  const first = target(drawing.get("p"), drawing.get("q"));
  const form = el("signin");
  form.onsubmit = async event => {
    event.preventDefault();
    try {
      const client = el("client").value.trim();
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
      const state = crypto.randomUUID();
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      sessionStorage.setItem(sessionKey, JSON.stringify({client, verifier, state, drawing: drawing.toString(), time: Date.now()}));
      const args = new URLSearchParams({client_id:client, redirect_uri:callback, scope:"openid connect",
        response_type:"code", state, code_challenge:challenge, code_challenge_method:"S256"});
      location.assign("https://id.trimble.com/oauth/authorize?" + args);
    } catch (error) { reportError(error); }
  };
  if (!login) {
    form.hidden = false;
    status("Sign in to open this drawing in the embedded viewer.");
    return;
  }
  el("client").value = login.client;
  const response = await fetch("https://id.trimble.com/oauth/token", {method:"POST",
    body:new URLSearchParams({grant_type:"authorization_code", client_id:login.client,
      redirect_uri:callback, code:params.get("code"), code_verifier:login.verifier})});
  if (!response.ok) throw Error("Trimble sign-in failed (" + response.status + "). Reload to retry.");
  const {access_token:accessToken, expires_in:expiresIn} = await response.json();
  if (!accessToken) throw Error("Trimble did not return an access token.");
  const frame = el("embeddedTrial");
  const loaded = new Promise(resolve => frame.addEventListener("load", resolve, {once:true}));
  frame.src = "https://web.connect.trimble.com/?isEmbedded=true";
  frame.hidden = false;
  await loaded;
  const channel = new BroadcastChannel("BPA_ASSEMBLY_NAVIGATOR_REUSE");
  let expired = false;
  function expire() {
    expired = true;
    channel.close();
    form.hidden = false;
    status("Viewer sign-in expired. Sign in again to continue.");
  }
  api = await TrimbleConnectWorkspace.connect(frame, event => {
    if (event === "extension.sessionInvalid") expire();
  }, 30000);
  await api.embed.setTokens({accessToken});
  await api.embed.init3DViewer({projectId:project, modelId:model});
  if ((await api.project.getProject()).id !== project) throw Error("The viewer opened a different project.");
  if (expired) return;
  if (Number(expiresIn) > 0) setTimeout(expire, Number(expiresIn) * 1000);
  function navigate(guid) {
    latestLiveRequest = {guid, modelId:model};
    processLiveNavigation();
  }
  let previous;
  channel.onmessage = ({data}) => {
    if (expired || data?.type !== "BPA_REUSE_REQUEST" || !data.requestId ||
        data.projectId !== project || data.modelId !== model || typeof data.position !== "string") return;
    const guid = target(data.position, data.quantity);
    channel.postMessage({type:"BPA_REUSE_ACCEPTED", requestId:data.requestId});
    if (previous !== data.requestId) navigate(guid);
    previous = data.requestId;
  };
  navigate(first);
})().catch(reportError);
