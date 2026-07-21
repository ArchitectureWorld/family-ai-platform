const $ = (id) => document.getElementById(id);
const logNode = $("log");
const connectionNode = $("connection");
const identityNode = $("identity");
const conversationNode = $("conversation");
const historyNode = $("history");
const messageNode = $("message");

const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.get("token")) sessionStorage.setItem("family-ai-dev-token", fragment.get("token"));
if (fragment.get("device")) sessionStorage.setItem("family-ai-dev-device", fragment.get("device"));
if (location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);

const token = sessionStorage.getItem("family-ai-dev-token") ?? "";
const deviceRef = sessionStorage.getItem("family-ai-dev-device") ?? "device:test";
let conversationRef = sessionStorage.getItem("family-ai-dev-conversation") ?? "";
let turn = Number(sessionStorage.getItem("family-ai-dev-turn") ?? "0");

function writeLog(label, value) {
  const safe = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  logNode.textContent = `${new Date().toLocaleTimeString()} · ${label}\n${safe}`;
}

function setConnection(kind, text) {
  connectionNode.className = `status ${kind}`;
  connectionNode.textContent = text;
}

async function api(path, options = {}) {
  if (!token) throw new Error("缺少开发 Token，请重新运行 ./scripts/dev-up.sh 并打开脚本输出的 URL。");
  const headers = {
    authorization: `Bearer ${token}`,
    "x-device-ref": deviceRef,
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(options.headers ?? {})
  };
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => ({ code: "INVALID_RESPONSE" }));
  if (!response.ok) {
    const error = new Error(body?.message ?? `HTTP ${response.status}`);
    error.details = { status: response.status, body };
    throw error;
  }
  return body;
}

function renderIdentity(identity) {
  identityNode.className = "cards";
  identityNode.innerHTML = [
    ["成员", identity.memberDisplayName, identity.memberRef],
    ["设备", identity.deviceDisplayName, identity.deviceRef],
    ["固定个人助理", identity.agentDisplayName, identity.agentRef]
  ].map(([label, name, ref]) => `<div class="card"><span>${label}</span><strong>${name}</strong><small>${ref}</small></div>`).join("");
}

function renderConversation(conversation) {
  conversationRef = conversation.conversationRef;
  sessionStorage.setItem("family-ai-dev-conversation", conversationRef);
  conversationNode.textContent = `${conversation.title} · ${conversation.conversationRef}`;
}

function renderMessages(messages) {
  if (!messages.length) {
    historyNode.className = "timeline empty";
    historyNode.textContent = "该会话尚无消息";
    return;
  }
  historyNode.className = "timeline";
  historyNode.innerHTML = messages.map((item) => {
    const text = item.payload?.text ?? "";
    const role = item.role === "assistant" ? "assistant" : "user";
    const label = role === "assistant" ? "个人助理" : "我";
    return `<article class="message ${role}">${text}<small>${label} · ${item.messageRef}</small></article>`;
  }).join("");
}

async function loadIdentity() {
  const identity = await api("/api/v1/me");
  renderIdentity(identity);
  writeLog("身份验证成功", identity);
  return identity;
}

async function createConversation() {
  const result = await api("/api/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ title: `Gateway 体验 ${new Date().toLocaleString()}` })
  });
  renderConversation(result.conversation);
  turn = 0;
  sessionStorage.setItem("family-ai-dev-turn", "0");
  renderMessages([]);
  writeLog("会话创建成功", result);
}

async function loadConversations() {
  const result = await api("/api/v1/conversations");
  const selected = result.conversations.find((item) => item.conversationRef === conversationRef)
    ?? result.conversations[0];
  if (!selected) throw new Error("尚无会话，请先创建体验会话。");
  renderConversation(selected);
  writeLog("会话读取成功", result);
  await loadHistory();
}

async function loadHistory() {
  if (!conversationRef) throw new Error("请先创建或读取一个会话。");
  const result = await api(`/api/v1/conversations/${encodeURIComponent(conversationRef)}/messages`);
  renderConversation(result.conversation);
  renderMessages(result.messages);
  writeLog("历史读取成功", { count: result.messages.length, conversationRef });
}

async function sendMessage() {
  if (!conversationRef) throw new Error("请先创建或读取一个会话。");
  const text = messageNode.value.trim();
  if (!text) throw new Error("消息不能为空。");
  turn += 1;
  sessionStorage.setItem("family-ai-dev-turn", String(turn));
  const id = crypto.randomUUID();
  const envelope = {
    protocolVersion: "1.0",
    messageRef: `message:${id}`,
    correlationRef: `correlation:${crypto.randomUUID()}`,
    idempotencyKey: `browser:${id}`,
    occurredAt: new Date().toISOString(),
    source: { kind: "device", ref: deviceRef },
    target: { kind: "agent", ref: "agent:personal-assistant" },
    payload: { type: "text", text, language: "zh-CN" }
  };
  const result = await api(`/api/v1/conversations/${encodeURIComponent(conversationRef)}/messages`, {
    method: "POST",
    body: JSON.stringify(envelope)
  });
  writeLog(`第 ${turn} 轮发送成功`, result);
  await loadHistory();
}

async function run(action) {
  document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    await action();
    setConnection("ok", "Gateway 可用");
  } catch (error) {
    setConnection("error", "操作失败");
    writeLog("错误", error.details ?? { message: error.message });
  } finally {
    document.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

$("loadIdentity").addEventListener("click", () => run(loadIdentity));
$("createConversation").addEventListener("click", () => run(createConversation));
$("loadConversations").addEventListener("click", () => run(loadConversations));
$("loadHistory").addEventListener("click", () => run(loadHistory));
$("sendMessage").addEventListener("click", () => run(sendMessage));
$("sendSecond").addEventListener("click", () => {
  messageNode.value = "这是第二轮体验消息，请确认上下文连续。";
  messageNode.focus();
});

fetch("/health")
  .then((response) => response.json())
  .then(() => {
    setConnection("ok", token ? "Gateway 可用" : "Gateway 可用，缺少 Token");
    if (token) return loadIdentity();
  })
  .then(() => {
    if (conversationRef) return loadHistory();
  })
  .catch((error) => {
    setConnection("error", "无法连接");
    writeLog("启动检查失败", { message: error.message });
  });
