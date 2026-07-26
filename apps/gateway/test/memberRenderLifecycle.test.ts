import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRenderer } from "../member-public/render.js";
import { createStore } from "../member-public/store.js";
import {
  createMemberDocumentHarness,
  memberActions,
  memberState,
} from "./helpers/memberBrowserHarness.js";
const indexPath = fileURLToPath(
  new URL("../member-public/index.html", import.meta.url),
);
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
  it("mirrors every actual member index ID and keyboard-event contract", () => {
    const harness = createMemberDocumentHarness();
    const ids = [
      ...readFileSync(indexPath, "utf8").matchAll(/id="([^"]+)"/g),
    ].map((match) => match[1]);
    expect(ids).toHaveLength(68);
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
});
