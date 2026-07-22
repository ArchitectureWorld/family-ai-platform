import { qrSvg } from "/qr.js";

const $ = (id) => document.getElementById(id);

const views = ["loadingView", "setupView", "portalView", "entryView", "recoveryView"];
const logNode = $("log");
const connectionNode = $("connection");
const contextCardsNode = $("contextCards");
const adminToolsNode = $("adminTools");
const memberListNode = $("memberList");
const pairingDialog = $("pairingDialog");

const keys = {
  bootstrapToken: "family-ai-dev-token",
  bootstrapDevice: "family-ai-dev-device",
  adminRef: "family-ai-admin-session-ref",
  adminToken: "family-ai-admin-session-token",
  personalRef: "family-ai-personal-session-ref",
  personalToken: "family-ai-personal-session-token"
};

let activePairing = null;
let pairingTimer = null;
let pairingTickBusy = false;

const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.get("token")) sessionStorage.setItem(keys.bootstrapToken, fragment.get("token"));
if (fragment.get("device")) sessionStorage.setItem(keys.bootstrapDevice, fragment.get("device"));
if (location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const secretFieldNames = new Set([
  "authorization",
  "code",
  "credential_hash",
  "deviceCredential",
  "entrySessionToken",
  "qr",
  "qrPayload",
  "token",
  "token_hash"
]);

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      secretFieldNames.has(key) ? "[REDACTED]" : redact(item)
    ]));
  }
  return value;
}

function writeLog(label, value) {
  const safeValue = redact(value);
  const text = typeof safeValue === "string" ? safeValue : JSON.stringify(safeValue, null, 2);
  logNode.textContent = `${new Date().toLocaleTimeString()} · ${label}\n${text}`;
}

function setConnection(kind, text) {
  connectionNode.className = `status ${kind}`;
  connectionNode.textContent = text;
}

function showView(id) {
  for (const view of views) $(view).classList.toggle("hidden", view !== id);
}

function setBusy(busy) {
  document.querySelectorAll("button, input, select").forEach((node) => {
    node.disabled = busy;
  });
}

function entryCredential(kind) {
  const refKey = kind === "admin" ? keys.adminRef : keys.personalRef;
  const tokenKey = kind === "admin" ? keys.adminToken : keys.personalToken;
  const entrySessionRef = sessionStorage.getItem(refKey) ?? "";
  const token = sessionStorage.getItem(tokenKey) ?? "";
  return entrySessionRef && token ? { entrySessionRef, token } : null;
}

function storeEntries(entries) {
  sessionStorage.setItem(keys.adminRef, entries.admin.entrySessionRef);
  sessionStorage.setItem(keys.adminToken, entries.admin.token);
  sessionStorage.setItem(keys.personalRef, entries.personal.entrySessionRef);
  sessionStorage.setItem(keys.personalToken, entries.personal.token);
}

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(options.headers ?? {})
  };

  if (options.auth === "bootstrap") {
    const token = sessionStorage.getItem(keys.bootstrapToken) ?? "";
    const deviceRef = sessionStorage.getItem(keys.bootstrapDevice) ?? "device:test";
    if (!token) {
      throw new Error("缺少本机初始化凭证，请重新运行 ./scripts/verify-foundation.sh 并打开脚本输出的 URL。");
    }
    headers.authorization = `Bearer ${token}`;
    headers["x-device-ref"] = deviceRef;
  }

  if (options.auth === "admin" || options.auth === "personal") {
    const credential = entryCredential(options.auth);
    if (!credential) throw new Error("当前浏览器没有这个入口的 Session。");
    headers.authorization = `Bearer ${credential.token}`;
    headers["x-entry-session-ref"] = credential.entrySessionRef;
  }

  const response = await fetch(path, {
    method: options.method ?? "GET",
    body: options.body,
    headers
  });
  const body = response.status === 204
    ? null
    : await response.json().catch(() => ({
        code: "INVALID_RESPONSE",
        category: "internal",
        message: `Gateway 返回了无法识别的响应（HTTP ${response.status}）。`,
        retryable: true
      }));
  if (!response.ok) {
    const publicError = body?.error ?? body;
    const error = new Error(publicError?.message ?? `HTTP ${response.status}`);
    error.details = {
      status: response.status,
      errorCode: publicError?.code ?? "UNKNOWN_ERROR",
      category: publicError?.category ?? "internal",
      message: publicError?.message ?? `HTTP ${response.status}`,
      retryable: Boolean(publicError?.retryable)
    };
    throw error;
  }
  return body;
}

function renderPortal(context) {
  $("portalTitle").textContent = context ? `${context.family.displayName} · 双入口门户` : "家庭双入口门户";
  $("portalSummary").textContent = context
    ? `${context.person.displayName}正在使用${context.device.displayName}。请选择家庭管理或个人空间。`
    : "请选择要进入的空间。";
}

function renderContext(context) {
  const isAdmin = context.audience === "family_admin";
  $("audienceBadge").className = `status ${isAdmin ? "admin" : "personal"}`;
  $("audienceBadge").textContent = isAdmin ? "当前入口：家庭管理" : "当前入口：个人空间";
  $("entryTitle").textContent = isAdmin ? "家庭管理入口" : "个人空间入口";
  $("entryDescription").textContent = isAdmin
    ? "权限范围是整个 Family，默认由家庭管家承接家庭级事务。"
    : "权限范围是当前 Person，默认由个人助理承接私人事务。";

  const cards = [
    ["入口类型", isAdmin ? "家庭管理" : "个人空间", context.audience],
    ["家庭", context.family.displayName, context.family.familyRef],
    ["同一个 Person", context.person.displayName, context.person.personRef],
    ["同一台 Device", context.device.displayName, context.device.deviceRef],
    ["独立 Session", "已认证", context.entrySessionRef],
    ["默认 Agent", context.agent.displayName, context.agent.agentRef]
  ];
  contextCardsNode.className = "cards";
  contextCardsNode.innerHTML = cards.map(([label, name, ref]) =>
    `<div class="card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(ref)}</small></div>`
  ).join("");

  adminToolsNode.classList.toggle("hidden", !isAdmin);
}

const roleLabels = {
  owner: "家庭所有者",
  adult: "成人",
  child: "孩子",
  elder: "长辈"
};

function renderMembers(members) {
  if (!members.length) {
    memberListNode.className = "member-list empty";
    memberListNode.textContent = "尚无家庭成员";
    return;
  }
  memberListNode.className = "member-list";
  memberListNode.innerHTML = members.map((member) => {
    const deviceCount = Number(member.activePersonalDeviceCount ?? 0);
    return `
      <article class="member-row">
        <div class="member-avatar">${escapeHtml(member.displayName.slice(0, 1))}</div>
        <div class="member-copy">
          <strong>${escapeHtml(member.displayName)}</strong>
          <span>${escapeHtml(roleLabels[member.familyRole] ?? member.familyRole)} · ${escapeHtml(member.personRef)}</span>
        </div>
        <div class="member-agent">
          <b>${escapeHtml(member.personalAssistant.displayName)}</b>
          <span>${member.entryStatus === "claimed" ? "个人入口已建立" : "等待本人认领入口"} · 有效移动设备 ${deviceCount} 台</span>
        </div>
        <button
          class="member-pair"
          type="button"
          data-pair-person="${escapeHtml(member.personRef)}"
          data-pair-name="${escapeHtml(member.displayName)}"
          data-device-count="${deviceCount}"
        >生成 iPhone 配对码</button>
      </article>
    `;
  }).join("");
}

async function loadMembers(options = {}) {
  const result = await api("/api/v1/admin/members", { auth: "admin" });
  renderMembers(result.members);
  if (options.log !== false) {
    writeLog("家庭成员读取成功", { count: result.members.length });
  }
  return result.members;
}

function clearPairingMaterial() {
  $("pairingQr").replaceChildren();
  $("pairingCode").textContent = "—";
  $("pairingCountdown").textContent = "00:00";
  $("pairingFamily").textContent = "—";
  $("pairingPerson").textContent = "—";
  $("pairingContent").classList.add("hidden");
  $("revokePairing").classList.add("hidden");
}

function clearPairingState() {
  if (pairingTimer !== null) window.clearInterval(pairingTimer);
  pairingTimer = null;
  pairingTickBusy = false;
  activePairing = null;
  clearPairingMaterial();
}

function formatCountdown(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutesPart = String(Math.floor(seconds / 60)).padStart(2, "0");
  const secondsPart = String(seconds % 60).padStart(2, "0");
  return `${minutesPart}:${secondsPart}`;
}

async function finishPairing(statusText) {
  clearPairingState();
  $("pairingStatus").textContent = statusText;
  await loadMembers({ log: false }).catch(() => undefined);
}

async function tickPairing() {
  if (!activePairing || pairingTickBusy) return;
  const remaining = Date.parse(activePairing.expiresAt) - Date.now();
  $("pairingCountdown").textContent = formatCountdown(remaining);
  if (remaining <= 0) {
    await finishPairing("配对码已过期，材料已从页面内存中清除。");
    return;
  }

  if (Date.now() - activePairing.lastCheckedAt < 2000) return;
  pairingTickBusy = true;
  try {
    activePairing.lastCheckedAt = Date.now();
    const members = await loadMembers({ log: false });
    const member = members.find((item) => item.personRef === activePairing.personRef);
    if (member && Number(member.activePersonalDeviceCount ?? 0) > activePairing.baselineDeviceCount) {
      await finishPairing("配对已消费，iPhone 个人入口已建立。配对材料已清除。");
    }
  } finally {
    pairingTickBusy = false;
  }
}

async function openPairing(personRef, displayName, baselineDeviceCount) {
  clearPairingState();
  $("pairingTitle").textContent = `为 ${displayName} 配对 iPhone`;
  $("pairingStatus").textContent = "正在生成一次性配对材料…";
  pairingDialog.showModal();

  const result = await api(
    `/api/v1/admin/members/${encodeURIComponent(personRef)}/pairing-codes`,
    { method: "POST", auth: "admin" }
  );
  activePairing = {
    pairingRef: result.pairing.pairingRef,
    expiresAt: result.pairing.expiresAt,
    personRef,
    baselineDeviceCount: Number(baselineDeviceCount),
    lastCheckedAt: 0
  };
  $("pairingFamily").textContent = result.family.displayName;
  $("pairingPerson").textContent = result.person.displayName;
  $("pairingCode").textContent = result.pairing.code;
  $("pairingQr").innerHTML = qrSvg(result.qr.url, {
    title: `${result.person.displayName} 的 iPhone 配对二维码`
  });
  $("pairingCountdown").textContent = formatCountdown(
    Date.parse(result.pairing.expiresAt) - Date.now()
  );
  $("pairingContent").classList.remove("hidden");
  $("revokePairing").classList.remove("hidden");
  $("pairingStatus").textContent = "请在 5 分钟内使用 iPhone 扫码或输入短码。";
  pairingTimer = window.setInterval(() => void tickPairing(), 1000);
  writeLog("iPhone 配对材料已生成", {
    personRef,
    expiresAt: result.pairing.expiresAt,
    materialStoredInBrowser: false
  });
}

async function revokeActivePairing(statusText = "配对已撤销，材料已从页面内存中清除。") {
  if (!activePairing) return;
  const pairingRef = activePairing.pairingRef;
  await api(`/api/v1/admin/pairing-codes/${encodeURIComponent(pairingRef)}`, {
    method: "DELETE",
    auth: "admin"
  });
  await finishPairing(statusText);
}

async function closePairingDialog() {
  if (activePairing) {
    await revokeActivePairing("弹窗关闭前已撤销未消费的配对码。").catch(() => {
      clearPairingState();
    });
  } else {
    clearPairingState();
  }
  pairingDialog.close();
}

async function openEntry(kind) {
  const context = await api("/api/v1/portal/context", { auth: kind });
  renderContext(context);
  showView("entryView");
  if (kind === "admin") await loadMembers();
  writeLog(kind === "admin" ? "已进入家庭管理" : "已进入个人空间", context);
}

async function showPortal() {
  const admin = entryCredential("admin");
  const personal = entryCredential("personal");
  if (!admin || !personal) {
    showView("recoveryView");
    return;
  }
  const context = await api("/api/v1/portal/context", { auth: "admin" });
  renderPortal(context);
  showView("portalView");
  writeLog("双入口 Session 已恢复", {
    family: context.family,
    person: context.person,
    device: context.device,
    adminSessionRef: admin.entrySessionRef,
    personalSessionRef: personal.entrySessionRef
  });
}

async function initializePage() {
  const health = await api("/health");
  if (health.service !== "family-ai-gateway-foundation") {
    throw new Error("端口上的服务不是 Family AI Gateway Foundation。");
  }
  setConnection("ok", "Gateway 可用");
  const status = await api("/api/v1/onboarding/status");
  if (!status.initialized) {
    showView("setupView");
    writeLog("等待首次建家", { initialized: false });
    return;
  }
  await showPortal();
}

async function run(action) {
  setBusy(true);
  try {
    await action();
    setConnection("ok", "Gateway 可用");
  } catch (error) {
    setConnection("error", "操作失败");
    writeLog("错误", error.details ?? { message: error.message });
  } finally {
    setBusy(false);
  }
}

$("setupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const result = await api("/api/v1/onboarding/family", {
      method: "POST",
      auth: "bootstrap",
      body: JSON.stringify({
        familyName: $("familyName").value.trim(),
        ownerName: $("ownerName").value.trim(),
        deviceName: $("deviceName").value.trim()
      })
    });
    storeEntries(result.entries);
    writeLog("家庭初始化成功", result);
    await showPortal();
  });
});

$("enterAdmin").addEventListener("click", () => run(() => openEntry("admin")));
$("enterPersonal").addEventListener("click", () => run(() => openEntry("personal")));
$("backPortal").addEventListener("click", () => run(showPortal));

$("memberForm").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const result = await api("/api/v1/admin/members", {
      method: "POST",
      auth: "admin",
      body: JSON.stringify({
        displayName: $("memberName").value.trim(),
        familyRole: $("memberRole").value
      })
    });
    $("memberName").value = "";
    writeLog("家庭成员创建成功", {
      personRef: result.member.personRef,
      displayName: result.member.displayName,
      familyRole: result.member.familyRole
    });
    await loadMembers();
  });
});

memberListNode.addEventListener("click", (event) => {
  const button = event.target.closest("[data-pair-person]");
  if (!button) return;
  run(() => openPairing(
    button.dataset.pairPerson,
    button.dataset.pairName,
    Number(button.dataset.deviceCount ?? 0)
  ));
});

$("revokePairing").addEventListener("click", () => run(() => revokeActivePairing()));
$("closePairing").addEventListener("click", () => run(closePairingDialog));
$("donePairing").addEventListener("click", () => run(closePairingDialog));
pairingDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  run(closePairingDialog);
});

run(initializePage);
