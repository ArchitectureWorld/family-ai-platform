import {
  clearProductWorkbenchCache,
  startProductWorkbench,
  stopProductWorkbench
} from "./product.js";

const $ = (id) => document.getElementById(id);

const state = {
  pairingRef: null,
  context: null,
  busy: false
};

const installationKey = "family-ai-web-installation-id";

function installationId() {
  const existing = localStorage.getItem(installationKey);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(installationKey, created);
  return created;
}

function setConnection(kind, label) {
  const node = $("connectionStatus");
  node.className = `connection ${kind}`;
  node.lastElementChild.textContent = label;
}

function showOnly(id) {
  for (const candidate of ["loadingState", "pairForm", "errorState"]) {
    $(candidate).classList.toggle("hidden", candidate !== id);
  }
}

function showEntry() {
  $("workspaceView").classList.add("hidden");
  $("entryView").classList.remove("hidden");
}

async function handleProductEntryInvalid(error) {
  await stopProductWorkbench();
  state.context = null;
  if (error?.code === "DEVICE_REVOKED") {
    await clearProductWorkbenchCache().catch(() => undefined);
    localStorage.removeItem(installationKey);
    pairingPrompt("此浏览器的授权已被撤销，请使用新的配对码重新建立入口。");
    return;
  }
  void restore();
}

async function showWorkspace(context) {
  state.context = context;
  $("entryView").classList.add("hidden");
  $("workspaceView").classList.remove("hidden");
  $("resumeBrowserButton").classList.add("hidden");
  $("personName").textContent = context.person.displayName;
  $("familyName").textContent = context.family.displayName;
  $("personAvatar").textContent = context.person.displayName.trim().slice(0, 1) || "F";
  $("deviceName").textContent = context.device.displayName;
  setConnection("online", "工作台已连接");
  await startProductWorkbench(context, { onEntryInvalid: handleProductEntryInvalid });
}

function clearPairingLocation() {
  const url = new URL(location.href);
  url.searchParams.delete("pairingRef");
  url.searchParams.delete("code");
  state.pairingRef = null;
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

async function api(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = {
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(!["GET", "HEAD", "OPTIONS"].includes(method)
      ? { "x-family-ai-web-request": "1" }
      : {}),
    ...(options.headers ?? {})
  };
  const response = await fetch(path, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin"
  });
  const body = response.status === 204
    ? null
    : await response.json().catch(() => null);
  if (!response.ok) {
    const publicError = body?.error ?? body;
    const error = new Error(publicError?.message ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.code = publicError?.code ?? "GATEWAY_UNAVAILABLE";
    error.retryable = Boolean(publicError?.retryable);
    throw error;
  }
  return body;
}

function browserDescriptor() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "Browser OS";
  return {
    displayName: `${platform} 浏览器`,
    browser: navigator.userAgent.slice(0, 120),
    operatingSystem: String(platform).slice(0, 80),
    appVersion: "0.1.0"
  };
}

function normalizeCode(value) {
  const compact = value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

async function claimPairing(code, pairingRef = null) {
  state.busy = true;
  showOnly("loadingState");
  setConnection("", "正在建立个人入口");
  try {
    const result = await api("/api/v1/web-entry/pairing/claim", {
      method: "POST",
      body: {
        protocolVersion: 1,
        ...(pairingRef ? { pairingRef } : {}),
        code,
        installationId: installationId(),
        device: browserDescriptor()
      }
    });
    clearPairingLocation();
    await showWorkspace(result.context);
  } finally {
    state.busy = false;
  }
}

function pairingPrompt(
  message = "输入管理员提供的一次性配对码。",
  allowDeviceRecovery = false
) {
  showEntry();
  showOnly("pairForm");
  $("pairingMessage").textContent = message;
  $("resumeBrowserButton").classList.toggle("hidden", !allowDeviceRecovery);
  setConnection("offline", "等待建立入口");
  $("pairingCode").focus();
}

function showError(error) {
  void stopProductWorkbench();
  showEntry();
  showOnly("errorState");
  $("errorMessage").textContent = error?.message || "请检查网络后重新尝试。";
  setConnection("offline", "连接失败");
}

async function loadContext() {
  return api("/api/v1/web-entry/context");
}

async function renewSession() {
  return api("/api/v1/web-entry/session/renew", { method: "POST" });
}

async function restore() {
  await stopProductWorkbench();
  showEntry();
  showOnly("loadingState");
  const url = new URL(location.href);
  const pairingRef = url.searchParams.get("pairingRef");
  const code = normalizeCode(url.searchParams.get("code") ?? "");
  state.pairingRef = pairingRef;

  if (code.length === 9) {
    $("pairingCode").value = code;
    try {
      await claimPairing(code, pairingRef);
      return;
    } catch (error) {
      clearPairingLocation();
      if (["PAIRING_INVALID", "PAIRING_EXPIRED", "PAIRING_CONSUMED"].includes(error.code)) {
        pairingPrompt(error.message);
        return;
      }
      showError(error);
      return;
    }
  }

  try {
    const context = await loadContext();
    await showWorkspace(context.context);
    return;
  } catch (error) {
    if (error.status !== 401) {
      showError(error);
      return;
    }
  }

  try {
    const renewed = await renewSession();
    await showWorkspace(renewed.context);
  } catch (error) {
    if ([401, 403].includes(error.status)) {
      pairingPrompt();
      return;
    }
    showError(error);
  }
}

$("pairingCode").addEventListener("input", (event) => {
  event.target.value = normalizeCode(event.target.value);
});

$("pairForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const code = normalizeCode($("pairingCode").value);
  if (code.length !== 9) {
    $("pairingCode").setCustomValidity("请输入完整的 8 位配对码");
    $("pairingCode").reportValidity();
    return;
  }
  $("pairingCode").setCustomValidity("");
  try {
    await claimPairing(code, state.pairingRef);
  } catch (error) {
    if (["PAIRING_INVALID", "PAIRING_EXPIRED", "PAIRING_CONSUMED"].includes(error.code)) {
      clearPairingLocation();
      pairingPrompt(error.message);
      return;
    }
    showError(error);
  }
});

$("retryButton").addEventListener("click", () => void restore());

$("resumeBrowserButton").addEventListener("click", async () => {
  if (state.busy) return;
  state.busy = true;
  showOnly("loadingState");
  setConnection("", "正在恢复个人入口");
  try {
    const renewed = await renewSession();
    await showWorkspace(renewed.context);
  } catch (error) {
    if ([401, 403].includes(error.status)) {
      pairingPrompt("此浏览器无法恢复入口，请使用新的配对码重新建立。");
      return;
    }
    showError(error);
  } finally {
    state.busy = false;
  }
});

$("logoutButton").addEventListener("click", async () => {
  if (state.busy) return;
  state.busy = true;
  try {
    await api("/api/v1/web-entry/logout", { method: "POST" });
    await stopProductWorkbench();
    state.context = null;
    pairingPrompt("已退出当前会话。可以使用这台浏览器恢复个人入口，或输入新的配对码。", true);
  } catch (error) {
    showError(error);
  } finally {
    state.busy = false;
  }
});

$("revokeButton").addEventListener("click", async () => {
  if (state.busy) return;
  const confirmed = window.confirm("移除此浏览器后，需要新的配对码才能再次进入。是否继续？");
  if (!confirmed) return;
  state.busy = true;
  try {
    await api("/api/v1/web-entry/device", { method: "DELETE" });
    await stopProductWorkbench();
    await clearProductWorkbenchCache();
    state.context = null;
    localStorage.removeItem(installationKey);
    pairingPrompt("此浏览器已从 Family AI 移除，请使用新的配对码重新建立入口。");
  } catch (error) {
    showError(error);
  } finally {
    state.busy = false;
  }
});

window.addEventListener("online", () => {
  if (!state.context) void restore();
});
window.addEventListener("offline", () => {
  if (!state.context) setConnection("offline", "当前离线");
});

void restore();