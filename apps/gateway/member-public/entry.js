import { createApiClient } from "./api.js";
import {
  deleteIdentityMemberCache,
  deleteLegacyMemberCache
} from "./cache-identity.js";
import { createEntryController } from "./entry-lifecycle.js";
import { createEntryMutationLock } from "./entry-mutation.js";
import { createEntryStorage } from "./entry-storage.js";
import {
  capturePairingFragment,
  clearPendingClaim,
  isTerminalPairingError,
  normalizePairingCode,
  preparePendingClaim,
  shouldRetainPendingClaim
} from "./pairing.js";
import {
  startProductWorkbench,
  stopProductWorkbench
} from "./product.js";

const defaultDependencies = {
  capturePairingFragment,
  clearPendingClaim,
  createApiClient,
  createEntryController,
  createEntryMutationLock,
  createEntryStorage,
  deleteIdentityMemberCache,
  deleteLegacyMemberCache,
  isTerminalPairingError,
  normalizePairingCode,
  preparePendingClaim,
  shouldRetainPendingClaim,
  startProductWorkbench,
  stopProductWorkbench
};

const FATAL_ENTRY_MESSAGE =
  "无法安全初始化此浏览器入口，请重新加载页面。";
const UI_ACTION_MESSAGE = "操作未完成，请重新尝试。";

function entryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function browserDescriptor(navigatorRef) {
  const platform =
    navigatorRef?.userAgentData?.platform ||
    navigatorRef?.platform ||
    "Browser OS";
  return {
    displayName: `${platform} 浏览器`,
    browser: String(navigatorRef?.userAgent ?? "").slice(0, 120),
    operatingSystem: String(platform).slice(0, 80),
    appVersion: "0.1.0"
  };
}

function formattedPairingCode(value, normalize) {
  const compact = normalize(value)
    .replace(/[^A-Z2-9]/gu, "")
    .slice(0, 8);
  return compact.length > 4
    ? `${compact.slice(0, 4)}-${compact.slice(4)}`
    : compact;
}

export function createMemberPageAdapter({
  documentRef = globalThis.document,
  globalTarget = globalThis,
  locationRef = globalThis.location,
  historyRef = globalThis.history,
  localStorageRef,
  sessionStorageRef,
  cryptoImpl = globalThis.crypto,
  navigatorRef = globalThis.navigator,
  confirmImpl = globalThis.confirm?.bind(globalThis),
  dependencies: overrides = {}
} = {}) {
  const dependencies = {
    ...defaultDependencies,
    ...overrides
  };
  const element = (id) => {
    const found = documentRef?.getElementById?.(id);
    if (!found) throw entryError(
      "ENTRY_PAGE_ELEMENT_MISSING",
      `Member page element is missing: ${id}`
    );
    return found;
  };

  // Storage access and factory construction stay inside initializePage()
  // so every synchronous initialization failure rejects ready.
  let storage;
  let mutationLock;
  let controller = null;
  let ready;
  let destroyed = false;
  let destroyPromise = null;
  let controllerDestroyPromise = null;
  let fatalRendered = false;
  const listenerCleanups = [];

  function listen(target, type, listener, options) {
    if (
      destroyed ||
      typeof target?.addEventListener !== "function"
    ) return;
    target.addEventListener(type, listener, options);
    listenerCleanups.push(() =>
      target.removeEventListener(type, listener, options)
    );
  }

  function detachListeners() {
    while (listenerCleanups.length > 0) {
      listenerCleanups.pop()();
    }
  }

  function destroyController() {
    if (controllerDestroyPromise) {
      return controllerDestroyPromise;
    }
    const currentController = controller;
    controllerDestroyPromise = currentController
      ? Promise.resolve()
        .then(() => currentController.destroy())
        .catch(() => undefined)
      : Promise.resolve();
    return controllerDestroyPromise;
  }

  function setConnection(kind, label) {
    const node = element("connectionStatus");
    node.className = `connection ${kind}`.trim();
    if (node.lastElementChild) {
      node.lastElementChild.textContent = label;
    }
  }

  function showEntryPanel(id) {
    for (const candidate of [
      "loadingState",
      "pairForm",
      "errorState"
    ]) {
      element(candidate).classList.toggle(
        "hidden",
        candidate !== id
      );
    }
  }

  function showEntry() {
    element("workspaceView").classList.add("hidden");
    element("entryView").classList.remove("hidden");
  }

  function showWorkspace() {
    element("entryView").classList.add("hidden");
    element("workspaceView").classList.remove("hidden");
  }

  function clearPairingMaterial() {
    const pairingCode = element("pairingCode");
    pairingCode.value = "";
    pairingCode.setCustomValidity?.("");
  }

  function scrubUntrustedFragment() {
    let href;
    try {
      href = String(locationRef?.href ?? "");
    } catch {
      return;
    }
    const fragmentIndex = href.indexOf("#");
    if (fragmentIndex < 0) return;
    const withoutFragment = href.slice(0, fragmentIndex);
    let replacement = "/member/";
    try {
      const url = new URL(withoutFragment);
      replacement = `${url.pathname}${url.search}`;
    } catch {
      // Keep the fixed same-origin fallback.
    }
    try {
      historyRef?.replaceState?.(
        historyRef.state,
        "",
        replacement
      );
    } catch {
      // Best-effort secrecy cleanup must not expose the original URL.
    }
  }

  function renderFixedError(message, connectionLabel) {
    showEntry();
    showEntryPanel("errorState");
    element("errorMessage").textContent = message;
    setConnection("offline", connectionLabel);
  }

  function showFatalError() {
    if (fatalRendered || destroyed) return;
    fatalRendered = true;
    detachListeners();
    void destroyController();
    scrubUntrustedFragment();
    clearPairingMaterial();
    renderFixedError(
      FATAL_ENTRY_MESSAGE,
      "安全初始化失败"
    );
    listen(element("retryButton"), "click", () => {
      try {
        locationRef?.reload?.();
      } catch {
        // Reload failure leaves the fixed safe fatal view visible.
      }
    });
  }

  function showUiActionError() {
    if (destroyed) return;
    renderFixedError(UI_ACTION_MESSAGE, "操作未完成");
  }

  function runUiAction(operation) {
    return Promise.resolve()
      .then(() => {
        if (destroyed) return;
        return operation();
      })
      .catch(() => {
        showUiActionError();
      });
  }

  function renderContext(context) {
    const personName = String(
      context?.person?.displayName ?? "家庭成员"
    );
    element("personName").textContent = personName;
    element("familyName").textContent = String(
      context?.family?.displayName ?? "Family AI"
    );
    element("personAvatar").textContent =
      personName.trim().slice(0, 1) || "F";
    element("deviceName").textContent = String(
      context?.device?.displayName ?? "当前浏览器"
    );
  }

  function renderEntryState(state) {
    const pairingCode = element("pairingCode");
    const resumeButton = element("resumeBrowserButton");
    pairingCode.disabled = state.busy === true;
    resumeButton.disabled = state.busy === true;
    resumeButton.classList.toggle(
      "hidden",
      state.showResume !== true
    );
    if (
      state.name === "active" ||
      state.name === "revoked" ||
      (state.name === "unpaired" && state.code)
    ) {
      clearPairingMaterial();
    }

    if (state.name === "active") {
      showWorkspace();
      setConnection("online", "工作台已连接");
      return;
    }

    showEntry();
    if (state.name === "pairing") {
      showEntryPanel("loadingState");
      setConnection("", "正在建立个人入口");
      return;
    }
    if (
      state.name === "recoverable_error" ||
      state.name === "revoked"
    ) {
      showEntryPanel("errorState");
      element("errorMessage").textContent =
        state.message || "请检查网络后重新尝试。";
      setConnection("offline", "连接失败");
      return;
    }

    showEntryPanel("pairForm");
    const messages = {
      locked:
        "已退出当前会话。可以使用这台浏览器恢复个人入口，或输入新的配对码。",
      unpaired:
        "输入管理员提供的一次性配对码。"
    };
    element("pairingMessage").textContent =
      state.message ||
      messages[state.name] ||
      messages.unpaired;
    setConnection("offline", "等待建立入口");
    if (state.name === "unpaired") pairingCode.focus();
  }

  function createController(api) {
    return dependencies.createEntryController({
      api,
      storage,
      mutationLock,
      cacheLifecycle: {
        deleteLegacy: () =>
          dependencies.deleteLegacyMemberCache(),
        deleteIdentity: (identity, options) =>
          dependencies.deleteIdentityMemberCache(
            identity,
            options
          )
      },
      workbench: {
        start: async (
          context,
          expectedInstallationId,
          assertEntryStartable
        ) => {
          assertEntryStartable();
          const result =
            await dependencies.startProductWorkbench(context, {
              assertEntryStartable,
              acquireProductFlight: () =>
                mutationLock.acquireProductFlight(
                  expectedInstallationId
                ),
              withIdentityOpenLock: (operation) =>
                mutationLock.runCacheOpen(
                  expectedInstallationId,
                  operation
                ),
              onCacheValidated: (identity) => {
                if (
                  storage.readInstallationId() !==
                    expectedInstallationId ||
                  storage.readClaimCookieIntent() ||
                  storage.readCookieClearPending()
                ) {
                  assertEntryStartable();
                  throw entryError(
                    "ENTRY_START_INVARIANT_CHANGED",
                    "Entry startup invariant changed before pointer publication."
                  );
                }
                storage.writeIdentityPointer(
                  expectedInstallationId,
                  identity
                );
                assertEntryStartable();
              },
              onEntryInvalid: (error) =>
                controller.handleEntryFailure(
                  error,
                  expectedInstallationId
                ),
              onEntryRevoked: (error) =>
                controller.handleEntryFailure(
                  error,
                  expectedInstallationId
                )
            });
          if (result === null) return false;
          assertEntryStartable();
          renderContext(context);
          return true;
        },
        stop: () => dependencies.stopProductWorkbench()
      },
      pendingClaims: {
        clear: () =>
          dependencies.clearPendingClaim(sessionStorageRef),
        isTerminalError:
          dependencies.isTerminalPairingError,
        shouldRetain: dependencies.shouldRetainPendingClaim
      },
      deviceDescriptor: browserDescriptor(navigatorRef),
      eventTarget: globalTarget,
      onViewState: renderEntryState
    });
  }

  async function submitManualPairingAfterReady(value) {
    const code = formattedPairingCode(
      value,
      dependencies.normalizePairingCode
    );
    const currentInstallationId =
      storage.readInstallationId();
    const manualClaim = dependencies.preparePendingClaim({
      code,
      installationId: currentInstallationId,
      sessionStorage: sessionStorageRef,
      cryptoImpl
    });
    await controller.claim(manualClaim);
  }

  function bindPageActions() {
    const pairingInput = element("pairingCode");
    listen(pairingInput, "input", (event) => {
      event.target.value = formattedPairingCode(
        event.target.value,
        dependencies.normalizePairingCode
      );
    });

    listen(
      element("pairForm"),
      "submit",
      (event) => {
        event.preventDefault();
        const code = formattedPairingCode(
          pairingInput.value,
          dependencies.normalizePairingCode
        );
        if (
          !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u
            .test(code)
        ) {
          pairingInput.setCustomValidity?.(
            "请输入完整的 8 位配对码"
          );
          pairingInput.reportValidity?.();
          return;
        }
        pairingInput.setCustomValidity?.("");
        void runUiAction(() =>
          submitManualPairingAfterReady(code)
        );
      }
    );

    listen(
      element("logoutButton"),
      "click",
      () => void runUiAction(() => controller.logout())
    );
    listen(
      element("resumeBrowserButton"),
      "click",
      () => void runUiAction(() => controller.resume())
    );
    listen(
      element("retryButton"),
      "click",
      () => void runUiAction(() => controller.retry())
    );
    listen(
      element("revokeButton"),
      "click",
      () => void runUiAction(async () => {
        const confirmed = confirmImpl?.(
          "移除此浏览器后，需要新的配对码才能再次进入。是否继续？"
        );
        if (confirmed) await controller.removeDevice();
      })
    );
    listen(
      globalTarget,
      "pagehide",
      (event) => {
        if (event?.persisted === true) return;
        void destroyPage();
      }
    );
    listen(globalTarget, "pageshow", (event) => {
      if (event?.persisted !== true) return;
      void runUiAction(() =>
        controller.getState?.().name === "active"
          ? undefined
          : controller.retry()
      );
    });
    listen(globalTarget, "online", () => {
      void runUiAction(() =>
        controller.getState?.().name === "active"
          ? undefined
          : controller.retry()
      );
    });
    listen(globalTarget, "offline", () => {
      void runUiAction(() => {
        if (controller.getState?.().name !== "active") {
          setConnection("offline", "当前离线");
        }
      });
    });
  }

  function destroyPage() {
    if (destroyPromise) return destroyPromise;
    destroyed = true;
    detachListeners();
    destroyPromise = controller
      ? destroyController()
      : Promise.resolve(ready)
        .then(() => destroyController())
        .catch(() => undefined);
    return destroyPromise;
  }

  async function initializePage() {
    const initializedLocalStorage =
      localStorageRef === undefined
        ? globalThis.localStorage
        : localStorageRef;
    const initializedSessionStorage =
      sessionStorageRef === undefined
        ? globalThis.sessionStorage
        : sessionStorageRef;
    const initializedStorage =
      dependencies.createEntryStorage({
        localStorage: initializedLocalStorage,
        cryptoImpl
      });
    const initializedMutationLock =
      dependencies.createEntryMutationLock();
    localStorageRef = initializedLocalStorage;
    sessionStorageRef = initializedSessionStorage;
    storage = initializedStorage;
    mutationLock = initializedMutationLock;

    const installationId =
      await mutationLock.runInstallationInit(() =>
        storage.getOrCreateInstallationIdLocked()
      );
    if (destroyed) {
      throw entryError(
        "ENTRY_PAGE_DESTROYED",
        "Member page was destroyed during initialization."
      );
    }

    // Capture and scrub pairing material before constructing any API.
    let pendingClaim = null;
    let fragmentError = null;
    try {
      pendingClaim = dependencies.capturePairingFragment({
        href: locationRef.href,
        historyRef,
        installationId,
        sessionStorage: sessionStorageRef,
        cryptoImpl
      });
    } catch (error) {
      if (error?.code !== "PAIRING_FRAGMENT_INVALID") {
        throw error;
      }
      fragmentError = error;
    }

    const api = dependencies.createApiClient();
    controller = createController(api);
    await controller.bootstrap({
      pendingClaim,
      fragmentError
    });
    bindPageActions();
    return controller;
  }

  ready = initializePage().catch((error) => {
    if (error?.code !== "ENTRY_PAGE_DESTROYED") {
      showFatalError();
    }
    throw error;
  });

  return {
    get controller() {
      return controller;
    },
    ready,
    async submitManualPairing(value) {
      await ready;
      return submitManualPairingAfterReady(value);
    },
    destroy: destroyPage,
    showFatalError
  };
}

if (
  typeof globalThis.window !== "undefined" &&
  globalThis.window === globalThis &&
  globalThis.document?.getElementById?.("entryView")
) {
  const page = createMemberPageAdapter();
  void page.ready.catch((error) => {
    page.showFatalError(error);
  });
}
