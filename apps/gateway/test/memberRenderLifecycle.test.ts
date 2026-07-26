import { describe, expect, it } from "vitest";
import { createRenderer } from "../member-public/render.js";
import { createStore } from "../member-public/store.js";
import {
  createMemberDocumentHarness,
  memberActions,
  memberState,
} from "./helpers/memberBrowserHarness.js";
describe("Member Web render lifecycle", () => {
  it("routes every static and dynamic action only to the replacement Renderer", async () => {
    const harness = createMemberDocumentHarness();
    const previous = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: harness.document,
    });
    try {
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
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previous,
      });
    }
  });
  it("opens and closes both dialogs only through the replacement Renderer", () => {
    const harness = createMemberDocumentHarness();
    const previous = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: harness.document,
    });
    try {
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
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previous,
      });
    }
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
});
