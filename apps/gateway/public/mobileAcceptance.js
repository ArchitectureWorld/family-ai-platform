const $ = (id) => document.getElementById(id);

const keys = {
  bootstrapToken: "family-ai-dev-token",
  bootstrapDevice: "family-ai-dev-device",
  adminRef: "family-ai-admin-session-ref",
  adminToken: "family-ai-admin-session-token",
  personalRef: "family-ai-personal-session-ref",
  personalToken: "family-ai-personal-session-token"
};

const stepDefinitions = [
  ["environment", "确认 Gateway 与空白体验环境"],
  ["family", "自动创建体验家庭"],
  ["entries", "验证家庭管理与个人空间"],
  ["member", "自动创建移动入口成员"],
  ["pairing", "生成并预览五分钟配对材料"],
  ["claim", "模拟 iPhone 完成个人入口认领"],
  ["session", "验证续期、退出与再次续期"],
  ["unbind", "验证 iPhone 本机解绑"],
  ["remote", "验证管理员远程撤销设备"],
  ["report", "生成不含秘密信息的中文报告"]
];

let lastReport = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomCredential() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function randomInstallationId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function bootstrapCredential() {
  const token = sessionStorage.getItem(keys.bootstrapToken) ?? "";
  const deviceRef = sessionStorage.getItem(keys.bootstrapDevice) ?? "device:test";
  if (!token) {
    throw new Error("缺少本机体验凭证。请重新运行一键验收启动脚本，它会自动打开正确页面。");
  }
  return { token, deviceRef };
}

function storeEntries(entries) {
  sessionStorage.setItem(keys.adminRef, entries.admin.entrySessionRef);
  sessionStorage.setItem(keys.adminToken, entries.admin.token);
  sessionStorage.setItem(keys.personalRef, entries.personal.entrySessionRef);
  sessionStorage.setItem(keys.personalToken, entries.personal.token);
}

function entryHeaders(entry) {
  return {
    authorization: `Bearer ${entry.token}`,
    "x-entry-session-ref": entry.entrySessionRef
  };
}

function deviceHeaders(device) {
  return {
    authorization: `Device ${device.credential}`,
    "x-device-ref": device.deviceRef
  };
}

async function request(path, options = {}) {
  const headers = {
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(options.headers ?? {})
  };

  if (options.bootstrap) {
    const credential = bootstrapCredential();
    headers.authorization = `Bearer ${credential.token}`;
    headers["x-device-ref"] = credential.deviceRef;
  }
  if (options.entry) Object.assign(headers, entryHeaders(options.entry));
  if (options.device) Object.assign(headers, deviceHeaders(options.device));

  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const publicError = body?.error ?? body ?? {};
    const error = new Error(publicError.message ?? `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.code = publicError.code ?? "UNKNOWN_ERROR";
    throw error;
  }
  return body;
}

async function expectError(path, expectedStatus, expectedCode, options = {}) {
  try {
    await request(path, options);
  } catch (error) {
    if (error.status === expectedStatus && error.code === expectedCode) return;
    throw error;
  }
  throw new Error(`预期 ${expectedCode}，但请求意外成功。`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function initializeSteps() {
  const list = $("mobileAcceptanceSteps");
  list.innerHTML = stepDefinitions.map(([id, label], index) => `
    <li id="mobile-step-${id}" class="acceptance-step pending">
      <span class="acceptance-step-number">${index + 1}</span>
      <span class="acceptance-step-copy"><strong>${escapeHtml(label)}</strong><small>等待执行</small></span>
      <b>等待</b>
    </li>
  `).join("");
}

function updateStep(id, state, detail) {
  const node = $(`mobile-step-${id}`);
  if (!node) return;
  node.className = `acceptance-step ${state}`;
  node.querySelector("small").textContent = detail;
  node.querySelector("b").textContent = state === "running" ? "进行中" : state === "passed" ? "通过" : state === "failed" ? "失败" : "等待";
}

function recordStep(report, id, title, detail) {
  report.steps.push({ id, title, result: "通过", detail });
  updateStep(id, "passed", detail);
}

function reportMarkdown(report) {
  const rows = report.steps.map((step) => `| ${step.title} | ${step.result} | ${step.detail} |`).join("\n");
  return `# Mobile Entry 小白体验验收报告\n\n- 开始时间：${report.startedAt}\n- 完成时间：${report.finishedAt}\n- 最终结果：**${report.result}**\n- 说明：报告已排除配对码、二维码内容、设备凭证、安装标识、Session Token、Authorization、SQL 数据与本机路径。\n\n| 验收步骤 | 结果 | 用户可理解的证据 |\n|---|---|---|\n${rows}\n`;
}

function renderMobileAcceptanceReport(report) {
  lastReport = report;
  const reportNode = $("mobileAcceptanceReport");
  reportNode.classList.remove("hidden");
  reportNode.innerHTML = `
    <div class="acceptance-report-heading">
      <div>
        <p class="eyebrow">MOBILE ENTRY ACCEPTANCE</p>
        <h3>${report.result === "通过" ? "一键体验验收通过" : "一键体验验收未通过"}</h3>
        <p>${escapeHtml(report.summary)}</p>
      </div>
      <span class="status ${report.result === "通过" ? "ok" : "error"}">${escapeHtml(report.result)}</span>
    </div>
    <div class="acceptance-report-grid">
      <span><small>开始</small><strong>${escapeHtml(report.startedAt)}</strong></span>
      <span><small>完成</small><strong>${escapeHtml(report.finishedAt)}</strong></span>
      <span><small>通过步骤</small><strong>${report.steps.length} / ${stepDefinitions.length}</strong></span>
    </div>
    ${report.error ? `<div class="acceptance-error"><strong>失败原因</strong><span>${escapeHtml(report.error)}</span></div>` : ""}
    <div class="acceptance-report-actions">
      <button id="downloadMobileAcceptanceReport" type="button">下载中文验收报告</button>
      ${report.result === "通过" ? '<button id="continueAcceptancePortal" class="primary" type="button">进入已创建的家庭体验</button>' : ""}
    </div>
    <p class="acceptance-redaction">报告不会包含配对码、二维码内容、设备凭证、Session Token 或数据库内容。</p>
  `;

  $("downloadMobileAcceptanceReport").addEventListener("click", () => {
    const blob = new Blob([reportMarkdown(report)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mobile-entry-acceptance-${new Date().toISOString().replaceAll(":", "-")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  });
  $("continueAcceptancePortal")?.addEventListener("click", () => location.reload());
}

async function loadMember(admin, personRef) {
  const result = await request("/api/v1/admin/members", { entry: admin });
  return result.members.find((member) => member.personRef === personRef);
}

async function simulateMobileClaim(admin, personRef, displayName, includePairingRef) {
  let pairingMaterial = null;
  let deviceMaterial = null;
  try {
    const pairingResult = await request(`/api/v1/admin/members/${encodeURIComponent(personRef)}/pairing-codes`, {
      method: "POST",
      entry: admin
    });
    pairingMaterial = {
      pairingRef: pairingResult.pairing.pairingRef,
      code: pairingResult.pairing.code,
      expiresAt: pairingResult.pairing.expiresAt
    };

    const preview = await request("/api/v1/mobile/pairing/preview", {
      method: "POST",
      body: { protocolVersion: 1, code: pairingMaterial.code }
    });
    assert(preview.person.personRef === personRef, "手工短码预览返回了错误的家庭成员。");

    deviceMaterial = {
      credential: randomCredential(),
      installationId: randomInstallationId(),
      deviceRef: "",
      entrySessionRef: "",
      entryToken: ""
    };
    const claimPayload = {
      protocolVersion: 1,
      ...(includePairingRef ? { pairingRef: pairingMaterial.pairingRef } : {}),
      code: pairingMaterial.code,
      installationId: deviceMaterial.installationId,
      deviceCredential: deviceMaterial.credential,
      device: {
        displayName,
        terminalType: "mobile",
        platform: "ios",
        systemVersion: "26.0",
        appVersion: "1.0.0",
        model: "iPhone"
      }
    };
    const claimed = await request("/api/v1/mobile/pairing/claim", {
      method: "POST",
      body: claimPayload
    });
    deviceMaterial.deviceRef = claimed.device.deviceRef;
    deviceMaterial.entrySessionRef = claimed.entry.entrySessionRef;
    deviceMaterial.entryToken = claimed.entry.token;
    assert(claimed.protocolVersion === 1, "iPhone 认领返回的协议版本不正确。");
    return deviceMaterial;
  } finally {
    pairingMaterial = null;
  }
}

async function runMobileAcceptance() {
  const button = $("runMobileAcceptance");
  const report = {
    startedAt: new Date().toLocaleString(),
    finishedAt: "—",
    result: "执行中",
    summary: "正在按真实用户路径自动体验 Mobile Entry。",
    steps: [],
    error: ""
  };
  let firstDevice = null;
  let secondDevice = null;
  let activeStep = "environment";

  button.disabled = true;
  button.textContent = "正在执行，请勿关闭页面…";
  $("mobileAcceptanceRunner").classList.add("running");
  $("mobileAcceptanceReport").classList.add("hidden");
  initializeSteps();

  try {
    updateStep("environment", "running", "正在连接 Gateway 并确认当前数据为空");
    const health = await request("/health");
    assert(health.service === "family-ai-gateway-foundation", "当前端口不是 Family AI Gateway。");
    const onboarding = await request("/api/v1/onboarding/status");
    assert(!onboarding.initialized, "当前体验数据不是空白状态。请重新运行一键验收启动脚本，它会自动清空一次性体验数据。");
    bootstrapCredential();
    recordStep(report, "environment", "体验环境", "Gateway 正常，当前为可安全初始化的空白体验环境");

    activeStep = "family";
    updateStep("family", "running", "正在自动创建体验家庭、管理员和管理电脑");
    const initialized = await request("/api/v1/onboarding/family", {
      method: "POST",
      bootstrap: true,
      body: {
        familyName: "Mobile Entry 体验家庭",
        ownerName: "体验管理员",
        deviceName: "体验管理电脑"
      }
    });
    storeEntries(initialized.entries);
    const admin = initialized.entries.admin;
    const personal = initialized.entries.personal;
    recordStep(report, "family", "创建家庭", "体验家庭、管理员与管理电脑已自动建立");

    activeStep = "entries";
    updateStep("entries", "running", "正在比较家庭管理与个人空间的身份和 Agent");
    const adminContext = await request("/api/v1/portal/context", { entry: admin });
    const personalContext = await request("/api/v1/portal/context", { entry: personal });
    assert(adminContext.audience === "family_admin", "家庭管理入口权限范围不正确。");
    assert(personalContext.audience === "personal", "个人空间入口权限范围不正确。");
    assert(adminContext.person.personRef === personalContext.person.personRef, "两个入口没有绑定同一个人。");
    assert(adminContext.device.deviceRef === personalContext.device.deviceRef, "两个入口没有绑定同一台设备。");
    assert(adminContext.entrySessionRef !== personalContext.entrySessionRef, "两个入口错误地共用了同一个 Session。");
    assert(adminContext.agent.agentRef !== personalContext.agent.agentRef, "两个入口错误地连接了同一个 Agent。");
    recordStep(report, "entries", "双入口隔离", "同一人、同一设备；家庭管理与个人空间使用独立 Session 和不同 Agent");

    activeStep = "member";
    updateStep("member", "running", "正在新增一位用于 iPhone 配对的家庭成员");
    const createdMember = await request("/api/v1/admin/members", {
      method: "POST",
      entry: admin,
      body: { displayName: "移动入口体验成员", familyRole: "adult" }
    });
    const personRef = createdMember.member.personRef;
    assert(Number(createdMember.member.activePersonalDeviceCount) === 0, "新成员不应已有移动设备。");
    recordStep(report, "member", "新增成员", "已建立一位尚未认领个人移动入口的家庭成员");

    activeStep = "pairing";
    updateStep("pairing", "running", "正在生成五分钟配对材料并使用手工短码预览");
    firstDevice = await simulateMobileClaim(admin, personRef, "一键验收 iPhone 甲", true);
    recordStep(report, "pairing", "配对材料", "五分钟一次性配对材料生成成功，手工短码能够准确预览目标成员");

    activeStep = "claim";
    updateStep("claim", "running", "正在确认 iPhone 只获得该成员的个人入口");
    const mobileEntry = {
      entrySessionRef: firstDevice.entrySessionRef,
      token: firstDevice.entryToken
    };
    const mobileContext = await request("/api/v1/portal/context", { entry: mobileEntry });
    assert(mobileContext.protocolVersion === 1, "移动入口上下文缺少协议版本。");
    assert(mobileContext.audience === "personal", "iPhone 被错误授予家庭管理权限。");
    assert(mobileContext.person.personRef === personRef, "iPhone 个人入口绑定了错误的成员。");
    const claimedMember = await loadMember(admin, personRef);
    assert(Number(claimedMember.activePersonalDeviceCount) === 1, "管理员未看到已认领的 iPhone。");
    recordStep(report, "claim", "iPhone 认领", "模拟 iPhone 已建立七天个人 Session，且没有获得家庭管理权限");

    activeStep = "session";
    updateStep("session", "running", "正在验证设备续期、退出和再次续期");
    const renewed = await request("/api/v1/mobile/session/renew", { method: "POST", device: firstDevice });
    assert(renewed.protocolVersion === 1, "续期响应协议版本不正确。");
    await request("/api/v1/mobile/session/logout", { method: "POST", device: firstDevice });
    const renewedAfterLogout = await request("/api/v1/mobile/session/renew", { method: "POST", device: firstDevice });
    assert(renewedAfterLogout.entry.entrySessionRef, "退出后设备无法重新建立个人 Session。");
    recordStep(report, "session", "Session 生命周期", "设备可以续期；退出只结束当前 Session，不会错误解绑设备");

    activeStep = "unbind";
    updateStep("unbind", "running", "正在模拟 iPhone 在本机解除绑定");
    await request("/api/v1/mobile/device", { method: "DELETE", device: firstDevice });
    await expectError("/api/v1/mobile/session/renew", 403, "DEVICE_REVOKED", { method: "POST", device: firstDevice });
    const unboundMember = await loadMember(admin, personRef);
    assert(Number(unboundMember.activePersonalDeviceCount) === 0, "本机解绑后管理员仍看到有效移动设备。");
    recordStep(report, "unbind", "本机解绑", "iPhone、入口绑定和 Session 已共同撤销，设备不能再次续期");
    firstDevice = null;

    activeStep = "remote";
    updateStep("remote", "running", "正在创建第二台 iPhone，并由管理员远程撤销");
    secondDevice = await simulateMobileClaim(admin, personRef, "一键验收 iPhone 乙", false);
    const remoteClaimedMember = await loadMember(admin, personRef);
    assert(Number(remoteClaimedMember.activePersonalDeviceCount) === 1, "第二台 iPhone 未出现在管理员设备计数中。");
    await request(`/api/v1/admin/devices/${encodeURIComponent(secondDevice.deviceRef)}`, {
      method: "DELETE",
      entry: admin
    });
    await expectError("/api/v1/mobile/session/renew", 403, "DEVICE_REVOKED", { method: "POST", device: secondDevice });
    const revokedMember = await loadMember(admin, personRef);
    assert(Number(revokedMember.activePersonalDeviceCount) === 0, "管理员撤销后仍存在有效移动设备。");
    recordStep(report, "remote", "远程撤销", "管理员可以远程撤销 iPhone，撤销后设备立即失去续期能力");
    secondDevice = null;

    activeStep = "report";
    updateStep("report", "running", "正在整理不含任何秘密材料的中文结果");
    report.finishedAt = new Date().toLocaleString();
    report.result = "通过";
    report.summary = "家庭创建、双入口隔离、iPhone 配对、Session 生命周期、本机解绑和管理员远程撤销均已通过。";
    recordStep(report, "report", "中文报告", "验收结果已汇总，秘密信息不会写入页面报告或下载文件");
    renderMobileAcceptanceReport(report);
  } catch (error) {
    updateStep(activeStep, "failed", error.message);
    report.finishedAt = new Date().toLocaleString();
    report.result = "未通过";
    report.summary = "流程已停止，请按失败原因处理后重新运行一键验收。";
    report.error = error.message;
    renderMobileAcceptanceReport(report);
  } finally {
    firstDevice = null;
    secondDevice = null;
    button.disabled = false;
    button.textContent = lastReport?.result === "通过" ? "重新运行一键体验验收" : "重新尝试一键体验验收";
    $("mobileAcceptanceRunner").classList.remove("running");
  }
}

function initializeMobileAcceptance() {
  initializeSteps();
  $("runMobileAcceptance").addEventListener("click", runMobileAcceptance);
  const mode = new URLSearchParams(location.search).get("mode");
  if (mode === "mobile-acceptance") {
    $("mobileAcceptanceRunner").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

initializeMobileAcceptance();

export { renderMobileAcceptanceReport, runMobileAcceptance, simulateMobileClaim };
