import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createRenderer } from "../member-public/render.js";
import { createStore } from "../member-public/store.js";
import {
  createMemberDocumentHarness,
  deferred,
  memberActions,
  memberState,
} from "./helpers/memberBrowserHarness.js";
const indexPath = fileURLToPath(
  new URL("../member-public/index.html", import.meta.url),
);
const mountedAgents = [
  {
    assignmentRef: "assignment:zzh",
    agentRef: "agent:hermes-zzh",
    displayName: "zzh",
    providerProfileRef: "provider-profile:hermes-zzh",
    isDefault: true,
    status: "idle",
    statusLabel: "空闲",
  },
  {
    assignmentRef: "assignment:codex",
    agentRef: "agent:codex-cli",
    displayName: "Codex",
    providerProfileRef: "provider-profile:codex-cli",
    isDefault: false,
    status: "working",
    statusLabel: "工作中",
  },
];
describe("Member Web render lifecycle", () => {
  it("routes every static and dynamic action only to the replacement Renderer", async () => {
    const harness = createMemberDocumentHarness();
    const firstActions = memberActions();
    const secondActions = memberActions();
    const first = createRenderer({
      store: createStore(memberState()),
      actions: firstActions,
      documentRef: harness.document,
    });
    expect(() => first.destroy()).not.toThrow();
    expect(() => first.destroy()).not.toThrow();
    const second = createRenderer({
      store: createStore(memberState()),
      actions: secondActions,
      documentRef: harness.document,
    });
    harness.submit("createWorkForm");
    harness.input("messageInput", "draft");
    harness.submit("messageComposer");
    const select = harness.document.getElementById("mobileWorkSelect")!;
    select.value = "work:0001";
    select.dispatchEvent(new Event("change"));
    harness.document.querySelectorAll(".retry-message")[0].click();
    harness.document
      .querySelectorAll(".message-select")[0]
      .dispatchEvent(new Event("change"));
    harness.document.querySelectorAll("[data-section]")[0].click();
    harness.click("loadEarlierButton");
    harness.submit("chatToWorkForm");
    await harness.whenIdle();
    for (const name of [
      "createWork",
      "saveDraft",
      "send",
      "openWork",
      "retry",
      "toggleMessageSelection",
      "navigate",
      "loadEarlier",
      "convertChatToWork",
    ] as const) {
      expect(firstActions[name]).not.toHaveBeenCalled();
      expect(secondActions[name]).toHaveBeenCalledOnce();
    }
    second.destroy();
  });
  it("opens and closes both dialogs only through the replacement Renderer", () => {
    const harness = createMemberDocumentHarness();
    const first = createRenderer({
      store: createStore(memberState()),
      actions: memberActions(),
      documentRef: harness.document,
    });
    first.destroy();
    const second = createRenderer({
      store: createStore(memberState()),
      actions: memberActions(),
      documentRef: harness.document,
    });
    harness.click("createWorkButton");
    expect(harness.elements.createWorkDialog.showModalCalls).toBe(1);
    harness.document.querySelectorAll("[data-close-dialog]")[0].click();
    expect(harness.elements.createWorkDialog.closeCalls).toBe(1);
    harness.click("convertSelectionButton");
    expect(harness.elements.chatToWorkDialog.showModalCalls).toBe(1);
    harness.document.querySelectorAll("[data-close-dialog]")[1].click();
    expect(harness.elements.chatToWorkDialog.closeCalls).toBe(1);
    second.destroy();
  });
  it("keeps Renderer documents and abort signals isolated", async () => {
    const firstHarness = createMemberDocumentHarness();
    const secondHarness = createMemberDocumentHarness();
    const firstActions = memberActions();
    const secondActions = memberActions();
    const first = createRenderer({
      store: createStore(memberState()),
      actions: firstActions,
      documentRef: firstHarness.document,
    });
    const firstSelect =
      firstHarness.document.getElementById("mobileWorkSelect")!;
    first.destroy();
    const second = createRenderer({
      store: createStore(memberState()),
      actions: secondActions,
      documentRef: secondHarness.document,
    });
    firstHarness.submit("createWorkForm");
    firstSelect.value = "work:0001";
    firstSelect.dispatchEvent(new Event("change"));
    secondHarness.submit("createWorkForm");
    const secondSelect =
      secondHarness.document.getElementById("mobileWorkSelect")!;
    secondSelect.value = "work:0001";
    secondSelect.dispatchEvent(new Event("change"));
    await firstHarness.whenIdle();
    await secondHarness.whenIdle();
    expect(firstActions.createWork).not.toHaveBeenCalled();
    expect(firstActions.openWork).not.toHaveBeenCalled();
    expect(secondActions.createWork).toHaveBeenCalledOnce();
    expect(secondActions.openWork).toHaveBeenCalledOnce();
    second.destroy();
  });
  it("keeps concurrent static and dynamic listeners isolated without a global document", async () => {
    const previous = globalThis.document;
    const sentinel = {
      getElementById: () => {
        throw new Error("GLOBAL_DOCUMENT_LEAK");
      },
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: sentinel,
    });
    try {
      const a = createMemberDocumentHarness();
      const b = createMemberDocumentHarness();
      const aActions = memberActions();
      const bActions = memberActions();
      const rendererA = createRenderer({
        store: createStore(memberState()),
        actions: aActions,
        documentRef: a.document,
      });
      const aForm = a.elements.createWorkForm;
      const aRetry = a.document.querySelectorAll(".retry-message")[0];
      const aMessage = a.document.querySelectorAll(".message-select")[0];
      const aWork = a.document.querySelectorAll(".work-list-item")[0];
      const aSelect = a.document.getElementById("mobileWorkSelect")!;
      const rendererB = createRenderer({
        store: createStore(memberState()),
        actions: bActions,
        documentRef: b.document,
      });
      const bForm = b.elements.createWorkForm;
      const bRetry = b.document.querySelectorAll(".retry-message")[0];
      const bMessage = b.document.querySelectorAll(".message-select")[0];
      const bWork = b.document.querySelectorAll(".work-list-item")[0];
      const bSelect = b.document.getElementById("mobileWorkSelect")!;
      rendererA.destroy();
      aForm.requestSubmit();
      aRetry.click();
      aMessage.dispatchEvent(new Event("change"));
      aWork.click();
      aSelect.value = "work:0001";
      aSelect.dispatchEvent(new Event("change"));
      bForm.requestSubmit();
      bRetry.click();
      bMessage.dispatchEvent(new Event("change"));
      bWork.click();
      bSelect.value = "work:0001";
      bSelect.dispatchEvent(new Event("change"));
      await a.whenIdle();
      await b.whenIdle();
      expect(aActions.createWork).not.toHaveBeenCalled();
      expect(aActions.retry).not.toHaveBeenCalled();
      expect(aActions.toggleMessageSelection).not.toHaveBeenCalled();
      expect(aActions.openWork).not.toHaveBeenCalled();
      expect(bActions.createWork).toHaveBeenCalledOnce();
      expect(bActions.retry).toHaveBeenCalledOnce();
      expect(bActions.toggleMessageSelection).toHaveBeenCalledOnce();
      expect(bActions.openWork).toHaveBeenCalledTimes(2);
      rendererB.destroy();
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previous,
      });
    }
  });
  it("makes the selected Agent explicit throughout the main workspace", () => {
    const harness = createMemberDocumentHarness();
    const store = createStore(memberState({
      context: { mountedAgents, defaultAgentRef: "agent:hermes-zzh" },
      currentAgentRef: "agent:hermes-zzh",
    }));
    const renderer = createRenderer({
      store,
      actions: memberActions(),
      documentRef: harness.document,
    });

    expect(harness.elements.currentAgentIdentity.textContent)
      .toContain("zzh独立会话空闲");
    expect(harness.elements.workspaceTitle.textContent).toBe("和 zzh 继续聊");
    expect(harness.elements.messageInput.placeholder).toBe("给 zzh 发消息…");

    store.setState({ currentAgentRef: "agent:codex-cli" });

    expect(harness.elements.currentAgentIdentity.textContent)
      .toContain("Codex独立会话工作中");
    expect(harness.elements.workspaceTitle.textContent).toBe(
      "和 Codex 继续聊",
    );
    expect(harness.elements.messageInput.placeholder).toBe(
      "给 Codex 发消息…",
    );
    expect(harness.elements.workMessageInput.placeholder).toBe(
      "让 Codex 继续推进当前 Work…",
    );
    renderer.destroy();
  });
  it("adds files from picker, paste, and drop and sends an attachment-only Chat after every upload is ready", async () => {
    const harness = createMemberDocumentHarness();
    const pending = {
      attachmentRef: "attachment:pending",
      agentRef: "agent:hermes-zzh",
      threadRef: "thread:chat-0001",
      fileName: "家庭预算.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 4096,
      progress: 0.5,
      serverState: "uploading",
    };
    const ready = {
      ...pending,
      attachmentRef: "attachment:ready",
      progress: 1,
      serverState: "ready",
      publicMetadata: {
        attachmentRef: "attachment:ready",
        fileName: "家庭预算.xlsx",
        mediaType: pending.mediaType,
        sizeBytes: 4096,
        sha256: "a".repeat(64),
        downloadUrl: "/api/v1/attachments/attachment%3Aready/download",
      },
    };
    const store = createStore(memberState({
      context: { mountedAgents, defaultAgentRef: "agent:hermes-zzh" },
      currentAgentRef: "agent:hermes-zzh",
      agentWorkspaceStatus: "ready",
      attachmentDrafts: [pending],
    }));
    const actions = memberActions({
      send: vi.fn(async () => {
        store.setState({ attachmentDrafts: [] });
        return { status: "queued" };
      }),
    });
    const renderer = createRenderer({
      store,
      actions,
      documentRef: harness.document,
    });
    const file = {
      name: "家庭预算.xlsx",
      type: pending.mediaType,
      size: 4096,
    };

    harness.click("messageAttachmentButton");
    expect(harness.elements.messageAttachmentInput.clickCalls).toBe(1);
    harness.files("messageAttachmentInput", [file]);
    const pasted = harness.transfer("messageInput", "paste", [file]);
    const dragged = harness.transfer("messageComposer", "dragover", [file]);
    const dropped = harness.transfer("messageComposer", "drop", [file]);
    await harness.whenIdle();

    expect(pasted.defaultPrevented).toBe(true);
    expect(dragged.defaultPrevented).toBe(true);
    expect(dropped.defaultPrevented).toBe(true);
    expect(actions.addAttachments).toHaveBeenNthCalledWith(1, "chat", [file]);
    expect(actions.addAttachments).toHaveBeenNthCalledWith(2, "chat", [file]);
    expect(actions.addAttachments).toHaveBeenNthCalledWith(3, "chat", [file]);
    expect(harness.elements.messageAttachmentTray.textContent)
      .toContain("家庭预算.xlsx");
    expect(harness.elements.messageAttachmentTray.textContent)
      .toContain("上传中 50%");
    expect(harness.elements.sendMessageButton.disabled).toBe(true);

    const remove = harness.document.querySelectorAll(".attachment-remove")[0];
    expect(remove.getAttribute("aria-label")).toBe(
      "移除附件 家庭预算.xlsx",
    );
    remove.click();
    await harness.whenIdle();
    expect(actions.cancelAttachment).toHaveBeenCalledWith(
      "attachment:pending",
    );

    store.setState({ attachmentDrafts: [ready] });
    expect(harness.elements.sendMessageButton.disabled).toBe(false);
    harness.submit("messageComposer");
    await harness.whenIdle();

    expect(actions.send).toHaveBeenCalledWith("chat", "");
    expect(harness.elements.messageInput.value).toBe("");
    expect(harness.elements.messageAttachmentTray.textContent).toBe("");
    renderer.destroy();
  });
  it("supports Work picker, paste, drop, affected-file errors, and attachment-only enqueue", async () => {
    const harness = createMemberDocumentHarness();
    const addAttachments = vi.fn()
      .mockRejectedValueOnce(new Error("每条消息最多添加 10 个附件。"))
      .mockResolvedValue(undefined);
    const ready = {
      attachmentRef: "attachment:work-ready",
      agentRef: "agent:hermes-zzh",
      threadRef: "thread:work-0001",
      fileName: "work-plan.md",
      mediaType: "text/markdown",
      sizeBytes: 512,
      progress: 1,
      serverState: "ready",
      publicMetadata: {
        attachmentRef: "attachment:work-ready",
        fileName: "work-plan.md",
        mediaType: "text/markdown",
        sizeBytes: 512,
        sha256: "d".repeat(64),
        downloadUrl:
          "/api/v1/attachments/attachment%3Awork-ready/download",
      },
    };
    const store = createStore(memberState({
      section: "work",
      context: { mountedAgents, defaultAgentRef: "agent:hermes-zzh" },
      currentAgentRef: "agent:hermes-zzh",
      agentWorkspaceStatus: "ready",
      attachmentDrafts: [],
    }));
    const actions = memberActions({
      addAttachments,
      send: vi.fn(async () => {
        store.setState({ attachmentDrafts: [] });
        return { status: "queued" };
      }),
    });
    const renderer = createRenderer({
      store,
      actions,
      documentRef: harness.document,
    });
    const file = { name: "work-plan.md", type: "text/markdown", size: 512 };

    harness.click("workAttachmentButton");
    expect(harness.elements.workAttachmentInput.clickCalls).toBe(1);
    harness.files("workAttachmentInput", [file]);
    await harness.whenIdle();
    expect(harness.elements.workAttachmentError.textContent).toContain(
      "work-plan.md：每条消息最多添加 10 个附件。",
    );

    const pasted = harness.transfer("workMessageInput", "paste", [file]);
    const dropped = harness.transfer(
      "workMessageComposer",
      "drop",
      [file],
    );
    await harness.whenIdle();
    expect(pasted.defaultPrevented).toBe(true);
    expect(dropped.defaultPrevented).toBe(true);
    expect(addAttachments).toHaveBeenNthCalledWith(2, "work", [file]);
    expect(addAttachments).toHaveBeenNthCalledWith(3, "work", [file]);

    store.setState({ attachmentDrafts: [ready] });
    expect(harness.elements.workSendMessageButton.disabled).toBe(false);
    harness.submit("workMessageComposer");
    await harness.whenIdle();
    expect(actions.send).toHaveBeenCalledWith("work", "");
    expect(harness.elements.workAttachmentTray.textContent).toBe("");
    renderer.destroy();
  });
  it("keeps text and the ready attachment tray when durable enqueue fails", async () => {
    const harness = createMemberDocumentHarness();
    const attachment = {
      attachmentRef: "attachment:ready",
      agentRef: "agent:hermes-zzh",
      threadRef: "thread:chat-0001",
      fileName: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 2048,
      progress: 1,
      serverState: "ready",
      publicMetadata: {
        attachmentRef: "attachment:ready",
        fileName: "report.pdf",
        mediaType: "application/pdf",
        sizeBytes: 2048,
        sha256: "b".repeat(64),
        downloadUrl: "/api/v1/attachments/attachment%3Aready/download",
      },
    };
    const actions = memberActions({
      send: vi.fn(async () => {
        throw new Error("IDB_COMMIT_FAILED");
      }),
    });
    const renderer = createRenderer({
      store: createStore(memberState({
        context: { mountedAgents, defaultAgentRef: "agent:hermes-zzh" },
        currentAgentRef: "agent:hermes-zzh",
        agentWorkspaceStatus: "ready",
        attachmentDrafts: [attachment],
      })),
      actions,
      documentRef: harness.document,
    });
    harness.elements.messageInput.value = "保留这段内容";

    harness.submit("messageComposer");
    await harness.whenIdle();

    expect(harness.elements.messageInput.value).toBe("保留这段内容");
    expect(harness.elements.messageAttachmentTray.textContent)
      .toContain("report.pdf");
    expect(harness.elements.productToast.textContent)
      .toContain("IDB_COMMIT_FAILED");
    renderer.destroy();
  });
  it("renders safe authoritative download chips, optimistic attachment chips, and affected-file errors", () => {
    const harness = createMemberDocumentHarness();
    const authoritativeAttachment = {
      attachmentRef: "attachment:server",
      fileName: "<季度报告>.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1024,
      sha256: "c".repeat(64),
      downloadUrl: "/api/v1/attachments/attachment%3Aserver/download",
    };
    const failedDraft = {
      attachmentRef: "attachment:failed",
      agentRef: "agent:hermes-zzh",
      threadRef: "thread:chat-0001",
      fileName: "installer.exe",
      mediaType: "application/octet-stream",
      sizeBytes: 2048,
      progress: 0,
      serverState: "failed",
      error: { message: "不支持此文件类型" },
    };
    const state = memberState({
      context: { mountedAgents, defaultAgentRef: "agent:hermes-zzh" },
      currentAgentRef: "agent:hermes-zzh",
      agentWorkspaceStatus: "ready",
      attachmentDrafts: [failedDraft],
      messagesByThread: {
        "thread:chat-0001": [{
          messageRef: "message:attachment",
          actor: { type: "person" },
          content: { text: "请查看" },
          attachments: [authoritativeAttachment],
          occurredAt: "2026-07-25T10:00:00.000Z",
        }],
      },
      outgoing: [{
        clientMessageId: "web:with-attachment",
        threadRef: "thread:chat-0001",
        content: { text: "" },
        attachments: [authoritativeAttachment],
        occurredAt: "2026-07-25T10:00:01.000Z",
        status: "failed",
        error: { retryable: true },
      }],
    });
    const renderer = createRenderer({
      store: createStore(state),
      actions: memberActions(),
      documentRef: harness.document,
    });

    const download = harness.document.querySelectorAll(
      ".message-attachment-download",
    )[0];
    expect(download.textContent).toContain("<季度报告>.pdf");
    expect(download.href).toBe(authoritativeAttachment.downloadUrl);
    expect(download.download).toBe("<季度报告>.pdf");
    expect(harness.document.querySelectorAll(".outgoing-attachment"))
      .toHaveLength(1);
    expect(harness.elements.messageAttachmentError.textContent)
      .toContain("installer.exe：不支持此文件类型");
    expect(harness.elements.sendMessageButton.disabled).toBe(true);
    renderer.destroy();
  });
  it("shows the selected Agent identity and skeleton immediately, then restores only that Agent workspace", () => {
    const harness = createMemberDocumentHarness();
    const store = createStore(memberState({
      context: { mountedAgents, defaultAgentRef: "agent:hermes-zzh" },
      currentAgentRef: "agent:codex-cli",
      agentWorkspaceStatus: "loading",
      chat: null,
      works: [],
      selectedWorkRef: null,
      messagesByThread: {},
      drafts: {},
      attachmentDrafts: [],
    }));
    const renderer = createRenderer({
      store,
      actions: memberActions(),
      documentRef: harness.document,
    });

    expect(harness.elements.currentAgentIdentity.textContent)
      .toContain("Codex独立会话工作中");
    expect(harness.elements.agentWorkspaceAnnouncement.textContent)
      .toContain("已切换到 Codex");
    expect(harness.elements.agentWorkspaceStateTitle.textContent)
      .toBe("正在打开 Codex");
    expect(harness.elements.agentWorkspaceState.classList.contains("hidden"))
      .toBe(false);
    expect(harness.elements.chatSection.classList.contains("hidden")).toBe(
      true,
    );

    store.setState({
      agentWorkspaceStatus: "ready",
      chat: { threadRef: "thread:codex-chat" },
      activeThreadRef: "thread:codex-chat",
      messagesByThread: {
        "thread:codex-chat": [{
          messageRef: "message:codex",
          actor: { type: "assistant" },
          content: { text: "Codex 独立历史" },
          occurredAt: "2026-07-25T10:00:00.000Z",
        }],
      },
      drafts: { "thread:codex-chat": "Codex 草稿" },
    });

    expect(harness.elements.agentWorkspaceState.classList.contains("hidden"))
      .toBe(true);
    expect(harness.elements.chatSection.classList.contains("hidden")).toBe(
      false,
    );
    expect(harness.elements.threadMessages.textContent)
      .toContain("Codex 独立历史");
    expect(harness.elements.messageInput.value).toBe("Codex 草稿");
    expect(harness.elements.chatEmptyTitle.textContent)
      .toBe("开始和 Codex 对话");
    renderer.destroy();
  });
  it.each([
    ["chat", "messageInput"],
    ["work", "workMessageInput"],
  ] as const)(
    "submits %s with Enter but not Shift+Enter, IME Enter, or empty Enter",
    async (target, inputId) => {
      const harness = createMemberDocumentHarness();
      const actions = memberActions();
      const renderer = createRenderer({
        store: createStore(memberState({
          context: { mountedAgents, defaultAgentRef: "agent:hermes-zzh" },
          currentAgentRef: "agent:hermes-zzh",
        })),
        actions,
        documentRef: harness.document,
      });

      harness.input(inputId, "第一行");
      const shifted = harness.key(inputId, "Enter", true);
      expect(shifted.defaultPrevented).toBe(false);

      const composing = harness.key(inputId, "Enter", false, true);
      expect(composing.defaultPrevented).toBe(false);
      expect(actions.send).not.toHaveBeenCalled();

      harness.elements[inputId].value = "   ";
      harness.key(inputId, "Enter");
      await harness.whenIdle();
      expect(actions.send).not.toHaveBeenCalled();

      harness.elements[inputId].value = "发送内容";
      const entered = harness.key(inputId, "Enter");
      expect(entered.defaultPrevented).toBe(true);
      await harness.whenIdle();
      expect(actions.send).toHaveBeenCalledOnce();
      expect(actions.send).toHaveBeenCalledWith(target, "发送内容");
      renderer.destroy();
    },
  );
  it("mirrors every actual member index ID and keyboard-event contract", () => {
    const harness = createMemberDocumentHarness();
    const ids = [
      ...readFileSync(indexPath, "utf8").matchAll(/id="([^"]+)"/g),
    ].map((match) => match[1]);
    expect(ids).toHaveLength(91);
    for (const id of ids)
      expect(harness.document.getElementById(id)).not.toBeNull();
    expect(harness.elements.pairingCode.parentElement).toBe(
      harness.elements.pairForm,
    );
    expect(harness.elements.logoutButton.parentElement).toBe(
      harness.elements.workspaceSidebar,
    );
    expect(harness.document.querySelectorAll("[data-section]")).toHaveLength(4);
    const event = harness.key("messageInput", "Enter", true);
    expect(event.key).toBe("Enter");
    expect(event.shiftKey).toBe(true);
    event.preventDefault();
    expect(event.defaultPrevented).toBe(true);
  });
  it("matches every real index ID nearest-ancestor chain and dialog form traversal", () => {
    const harness = createMemberDocumentHarness();
    const stack: Array<{ tag: string; id: string | null }> = [];
    const actualParents = new Map<string, string | null>();
    const voidTags = new Set(["input", "meta", "link", "img", "br", "hr"]);
    for (const token of readFileSync(indexPath, "utf8").matchAll(
      /<\/?[a-z][^>]*>/gi,
    )) {
      const value = token[0];
      if (value.startsWith("</")) {
        stack.pop();
        continue;
      }
      const tag = /^<([a-z]+)/i.exec(value)![1].toLowerCase();
      const id = /\bid="([^"]+)"/.exec(value)?.[1] ?? null;
      if (id)
        actualParents.set(
          id,
          [...stack].reverse().find((node) => node.id)?.id ?? null,
        );
      if (!voidTags.has(tag) && !value.endsWith("/>")) stack.push({ tag, id });
    }
    expect(actualParents).toHaveLength(91);
    for (const [id, expectedParent] of actualParents) {
      let parent = harness.elements[id].parentElement;
      while (parent && !parent.id) parent = parent.parentElement;
      expect(parent?.id ?? null, id).toBe(expectedParent);
    }
    for (const formId of ["createWorkForm", "chatToWorkForm"] as const) {
      const form = harness.elements[formId];
      const fields = form.querySelectorAll("button, input, textarea");
      expect(fields).toContain(
        formId === "createWorkForm"
          ? harness.elements.createWorkTitleInput
          : harness.elements.chatToWorkTitleInput,
      );
      expect(fields).toContain(
        formId === "createWorkForm"
          ? harness.elements.createWorkGoalInput
          : harness.elements.chatToWorkGoalInput,
      );
    }
    harness.elements.createWorkTitleInput.value = "title";
    harness.elements.createWorkGoalInput.value = "goal";
    harness.elements.chatToWorkTitleInput.value = "chat title";
    harness.elements.chatToWorkGoalInput.value = "chat goal";
    harness.elements.createWorkForm.reset();
    harness.elements.chatToWorkForm.reset();
    expect(harness.elements.createWorkTitleInput.value).toBe("");
    expect(harness.elements.createWorkGoalInput.value).toBe("");
    expect(harness.elements.chatToWorkTitleInput.value).toBe("");
    expect(harness.elements.chatToWorkGoalInput.value).toBe("");
  });
  it("leaves a stale create Work submission open without a success effect", async () => {
    const pending = deferred<undefined>();
    const setTimeoutFn = vi.fn(() => 1);
    const harness = createMemberDocumentHarness();
    const actions = memberActions({
      createWork: vi.fn(() => pending.promise),
    });
    const renderer = createRenderer({
      store: createStore(memberState()),
      actions,
      documentRef: harness.document,
      setTimeoutFn,
      clearTimeoutFn: vi.fn(),
    });
    harness.elements.createWorkDialog.showModal();
    harness.elements.createWorkTitleInput.value = "保留标题";
    harness.elements.createWorkGoalInput.value = "保留目标";

    harness.submit("createWorkForm");
    await Promise.resolve();
    expect(actions.createWork).toHaveBeenCalledOnce();
    expect(harness.elements.createWorkTitleInput.disabled).toBe(true);

    pending.resolve(undefined);
    await harness.whenIdle();

    expect(harness.elements.createWorkTitleInput.value).toBe("保留标题");
    expect(harness.elements.createWorkGoalInput.value).toBe("保留目标");
    expect(harness.elements.createWorkDialog.open).toBe(true);
    expect(harness.elements.createWorkDialog.closeCalls).toBe(0);
    expect(harness.elements.productToast.textContent).toBe("");
    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(harness.elements.createWorkTitleInput.disabled).toBe(false);
    expect(harness.elements.createWorkGoalInput.disabled).toBe(false);
    renderer.destroy();
  });
  it("leaves a stale Chat conversion open without a success effect", async () => {
    const pending = deferred<undefined>();
    const setTimeoutFn = vi.fn(() => 1);
    const harness = createMemberDocumentHarness();
    const actions = memberActions({
      convertChatToWork: vi.fn(() => pending.promise),
    });
    const renderer = createRenderer({
      store: createStore(memberState()),
      actions,
      documentRef: harness.document,
      setTimeoutFn,
      clearTimeoutFn: vi.fn(),
    });
    harness.elements.chatToWorkDialog.showModal();
    harness.elements.chatToWorkTitleInput.value = "保留转换标题";
    harness.elements.chatToWorkGoalInput.value = "保留转换目标";

    harness.submit("chatToWorkForm");
    await Promise.resolve();
    expect(actions.convertChatToWork).toHaveBeenCalledOnce();
    expect(harness.elements.chatToWorkTitleInput.disabled).toBe(true);

    pending.resolve(undefined);
    await harness.whenIdle();

    expect(harness.elements.chatToWorkTitleInput.value).toBe("保留转换标题");
    expect(harness.elements.chatToWorkGoalInput.value).toBe("保留转换目标");
    expect(harness.elements.chatToWorkDialog.open).toBe(true);
    expect(harness.elements.chatToWorkDialog.closeCalls).toBe(0);
    expect(harness.elements.productToast.textContent).toBe("");
    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(harness.elements.chatToWorkTitleInput.disabled).toBe(false);
    expect(harness.elements.chatToWorkGoalInput.disabled).toBe(false);
    renderer.destroy();
  });
  it("completes a non-stale create Work submission", async () => {
    const setTimeoutFn = vi.fn(() => 1);
    const harness = createMemberDocumentHarness();
    const actions = memberActions({
      createWork: vi.fn(async () => ({ workConversationRef: "work:new" })),
    });
    const renderer = createRenderer({
      store: createStore(memberState()),
      actions,
      documentRef: harness.document,
      setTimeoutFn,
      clearTimeoutFn: vi.fn(),
    });
    harness.elements.createWorkDialog.showModal();
    harness.elements.createWorkTitleInput.value = "新 Work";
    harness.elements.createWorkGoalInput.value = "新目标";

    harness.submit("createWorkForm");
    await harness.whenIdle();

    expect(harness.elements.createWorkTitleInput.value).toBe("");
    expect(harness.elements.createWorkGoalInput.value).toBe("");
    expect(harness.elements.createWorkDialog.open).toBe(false);
    expect(harness.elements.createWorkDialog.closeCalls).toBe(1);
    expect(harness.elements.productToast.textContent).toBe("Work 已创建。");
    expect(setTimeoutFn).toHaveBeenCalledOnce();
    renderer.destroy();
  });
  it("completes a non-stale Chat conversion", async () => {
    const setTimeoutFn = vi.fn(() => 1);
    const harness = createMemberDocumentHarness();
    const actions = memberActions({
      convertChatToWork: vi.fn(async () => ({
        conversation: { workConversationRef: "work:converted" },
      })),
    });
    const renderer = createRenderer({
      store: createStore(memberState()),
      actions,
      documentRef: harness.document,
      setTimeoutFn,
      clearTimeoutFn: vi.fn(),
    });
    harness.elements.chatToWorkDialog.showModal();
    harness.elements.chatToWorkTitleInput.value = "转换 Work";
    harness.elements.chatToWorkGoalInput.value = "转换目标";

    harness.submit("chatToWorkForm");
    await harness.whenIdle();

    expect(harness.elements.chatToWorkTitleInput.value).toBe("");
    expect(harness.elements.chatToWorkGoalInput.value).toBe("");
    expect(harness.elements.chatToWorkDialog.open).toBe(false);
    expect(harness.elements.chatToWorkDialog.closeCalls).toBe(1);
    expect(harness.elements.productToast.textContent).toBe(
      "已从 Chat 创建 Work。",
    );
    expect(setTimeoutFn).toHaveBeenCalledOnce();
    renderer.destroy();
  });
});
