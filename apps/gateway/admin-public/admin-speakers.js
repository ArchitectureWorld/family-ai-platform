const BOARDS = { "diy-n16r8": "DIY N16R8", "esp32-s3-box3": "ESP32-S3 BOX-3", "waveshare-audio": "微雪音频板" };
const PHASES = { waiting_for_wake: "等待唤醒", listening: "正在聆听", processing: "正在处理", speaking: "正在播放", muted: "已静音", starting: "正在启动", reconnecting: "正在重连", stopped: "已停止", not_configured: "尚未配置", unknown: "状态未知" };
const SERVICES = { running: "运行中", stopped: "已停止", not_configured: "尚未配置", unknown: "状态未知" };
const PROBLEMS = { service_stopped: "语音服务已停止", telemetry_stale: "运行状态已过期", telemetry_unavailable: "运行状态暂不可用", identity_mismatch: "设备身份不匹配", disconnected: "设备连接已断开", upstream_unavailable: "语音上游暂不可用" };
const SOURCES = { ready: "每 5 秒自动刷新", stale: "采集已过期，当前连接与语音状态未知", unavailable: "暂时无法获取音箱状态", not_configured: "尚未配置音箱监测" };
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isLabel = value => typeof value === "string" && value.length > 0 && value.length <= 80 && /^[\p{L}\p{N} _().+\-]+$/u.test(value);
const isTime = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const member = (object, key) => Object.hasOwn(object, key);

export function normalizeSpeakerResponse(value) {
  const invalid = () => { throw new Error("ADMIN_SPEAKER_RESPONSE_INVALID"); };
  if (!isRecord(value) || value.protocolVersion !== 1 || !member(SOURCES, value.sourceState) ||
      !(value.sampledAt === null || isTime(value.sampledAt)) || !Array.isArray(value.speakers) || value.speakers.length > 32) invalid();
  if ((["ready", "stale"].includes(value.sourceState) && value.sampledAt === null) ||
      (["unavailable", "not_configured"].includes(value.sourceState) && (value.sampledAt !== null || value.speakers.length !== 0))) invalid();
  const speakers = value.speakers.map(s => {
    if (!isRecord(s) || typeof s.speakerId !== "string" || !/^[a-f0-9]{12}$/.test(s.speakerId) ||
        !isLabel(s.displayName) || !(s.room === null || isLabel(s.room)) || !member(BOARDS, s.board) ||
        typeof s.usbConnected !== "boolean" || !["wifi", "usb", "unknown"].includes(s.transport) ||
        !member(SERVICES, s.serviceState) || !["connected", "disconnected", "unknown"].includes(s.linkState) ||
        !member(PHASES, s.phase) || !(s.runtimeUpdatedAt === null || isTime(s.runtimeUpdatedAt)) ||
        !(s.firmware === null || isLabel(s.firmware)) ||
        !(s.volumePercent === null || (Number.isInteger(s.volumePercent) && s.volumePercent >= 0 && s.volumePercent <= 100)) ||
        !isRecord(s.capabilities) || ["wifi", "aec", "duplex"].some(key => typeof s.capabilities[key] !== "boolean") ||
        !(s.problemCode === null || member(PROBLEMS, s.problemCode))) invalid();
    return {
      speakerId: s.speakerId, displayName: s.displayName, room: s.room, board: s.board,
      usbConnected: s.usbConnected, transport: s.transport, serviceState: s.serviceState,
      linkState: s.linkState, phase: s.phase, runtimeUpdatedAt: s.runtimeUpdatedAt,
      firmware: s.firmware, volumePercent: s.volumePercent,
      capabilities: { wifi: s.capabilities.wifi, aec: s.capabilities.aec, duplex: s.capabilities.duplex },
      problemCode: s.problemCode
    };
  });
  if (new Set(speakers.map(s => s.speakerId)).size !== speakers.length) invalid();
  return { protocolVersion: 1, sourceState: value.sourceState, sampledAt: value.sampledAt, speakers };
}

export function createSpeakerMonitor({
  root, api, documentRef = document, now = () => new Date(),
  setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval,
  onAuthenticationError = () => {}
}) {
  let destroyed = false;
  let pending = false;
  let snapshot = null;
  const abort = new AbortController();
  let timer = null;
  function node(tag, text, className) {
    const result = documentRef.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function render(message) {
    const current = now().getTime();
    const source = snapshot && snapshot.sampledAt !== null && current - Date.parse(snapshot.sampledAt) > 30_000
      ? "stale" : snapshot?.sourceState;
    const heading = node("h2", "设备管理");
    const status = node("p", message ?? (source ? SOURCES[source] : "正在获取音箱状态…"), "speaker-source");
    status.setAttribute("role", "status");
    const cards = node("div", undefined, "speaker-grid");
    for (const s of snapshot?.speakers ?? []) {
      const stale = source === "stale";
      const runtimeStale = s.runtimeUpdatedAt === null
        ? s.serviceState === "running" || s.linkState === "connected"
        : current - Date.parse(s.runtimeUpdatedAt) > 30_000;
      const unknown = stale || runtimeStale;
      const link = unknown ? "unknown" : s.linkState;
      const transport = { wifi: "Wi-Fi", usb: "USB", unknown: "连接" }[s.transport];
      const card = node("article", undefined, "speaker-card");
      card.append(node("h3", s.displayName), node("p", `${BOARDS[s.board]} · ${s.room ?? "未设置房间"}`, "speaker-meta"));
      const connection = node("p", `${transport} ${{ connected: "已连接", disconnected: "已断开", unknown: "状态未知" }[link]}`, `speaker-link speaker-link-${link}`);
      card.append(connection, node("p", stale ? "USB 插入状态未知" : (s.usbConnected ? "USB 已插入" : "USB 未插入")));
      const details = node("dl", undefined, "speaker-details");
      const rows = [
        ["语音服务", SERVICES[unknown ? "unknown" : s.serviceState]],
        ["语音阶段", PHASES[unknown ? "unknown" : s.phase]],
        ["固件", s.firmware ?? "未知"],
        ["音量", s.volumePercent === null ? "未知" : `${s.volumePercent}%`],
        ["能力", `${s.capabilities.wifi ? "支持 Wi-Fi" : "无 Wi-Fi"} · ${s.capabilities.aec ? "支持 AEC" : "无 AEC"} · ${s.capabilities.duplex ? "全双工" : "半双工"}`],
        ["运行更新", s.runtimeUpdatedAt ?? "暂无数据"]
      ];
      for (const [label, value] of rows) details.append(node("dt", label), node("dd", value));
      card.append(details);
      const problem = unknown ? (stale || s.runtimeUpdatedAt !== null ? "telemetry_stale" : "telemetry_unavailable") : s.problemCode;
      if (problem) card.append(node("p", PROBLEMS[problem], "speaker-problem"));
      cards.append(card);
    }
    root.replaceChildren(heading, status, node("p", `采样时间：${snapshot?.sampledAt ?? "暂无数据"}`, "speaker-meta"), cards);
    if (source === "ready" && snapshot.speakers.length === 0) root.append(node("p", "暂无已登记音箱。"));
  }
  function stop() {
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
    abort.abort();
  }
  async function refresh() {
    if (destroyed) return;
    render(); // Local TTL still advances if the next fetch hangs.
    if (pending) return;
    pending = true;
    try {
      const value = await api.speakers({ signal: abort.signal });
      if (destroyed) return;
      snapshot = normalizeSpeakerResponse(value);
      render();
    } catch (error) {
      if (destroyed) return;
      snapshot = null;
      if (error?.status === 401 || error?.status === 403) {
        stop();
        destroyed = true;
        render("管理员授权已失效，请重新进入管理页面。");
        onAuthenticationError();
      } else render("暂时无法获取音箱状态，请稍后重试。");
    } finally { pending = false; }
  }
  timer = setIntervalImpl(() => { void refresh(); }, 5000);
  const ready = refresh();
  return {
    ready,
    destroy() {
      destroyed = true;
      stop();
      snapshot = null;
      root.replaceChildren();
    }
  };
}
