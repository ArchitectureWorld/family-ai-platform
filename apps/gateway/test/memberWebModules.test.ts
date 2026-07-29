import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createMemberPageAdapter } from "../member-public/entry.js";
import { createMemberDocumentHarness } from "./helpers/memberBrowserHarness.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const publicDirectory = join(root, "apps/gateway/member-public");
const gatewaySource = join(root, "apps/gateway/src/memberWeb.ts");

function read(name: string) {
  return readFileSync(join(publicDirectory, name), "utf8");
}

const modules = [
  "entry.js",
  "api.js",
  "cache-identity.js",
  "pairing.js",
  "entry-storage.js",
  "entry-mutation.js",
  "entry-lifecycle.js",
  "store.js",
  "cache.js",
  "thread.js",
  "sync.js",
  "chat.js",
  "work.js",
  "render.js",
  "product.js"
];

function memberPageHarness() {
  const harness = createMemberDocumentHarness();
  for (const element of Object.values(harness.elements)) {
    Object.assign(element.classList, {
      remove(...names: string[]) {
        for (const name of names) {
          element.classList.values.delete(name);
        }
      }
    });
  }
  const setCustomValidity = vi.fn();
  Object.assign(harness.elements.pairingCode, {
    setCustomValidity,
    reportValidity: vi.fn()
  });
  return { harness, setCustomValidity };
}

function createAdapterFixture() {
  const { harness, setCustomValidity } = memberPageHarness();
  const eventTarget = new EventTarget();
  const installationId =
    "00000000-0000-4000-8000-000000000031";
  const storage = {
    getOrCreateInstallationIdLocked: vi.fn(() => installationId),
    readInstallationId: vi.fn(() => installationId),
    readClaimCookieIntent: vi.fn(() => null),
    readCookieClearPending: vi.fn(() => null),
    writeIdentityPointer: vi.fn()
  };
  const mutationLock = {
    runInstallationInit: vi.fn(
      async (operation: () => unknown) => operation()
    ),
    acquireProductFlight: vi.fn(async () => ({
      release: async () => {}
    })),
    runCacheOpen: vi.fn(
      async (
        _installationId: string,
        operation: () => unknown
      ) => operation()
    )
  };
  const controller = {
    bootstrap: vi.fn(async () => undefined),
    claim: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    removeDevice: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    handleEntryFailure: vi.fn(async () => true),
    getState: vi.fn(() => ({ name: "unpaired" }))
  };
  let controllerInput: any;
  const locationRef = {
    href: "http://member.test/member/",
    reload: vi.fn()
  };
  const historyRef = {
    state: null,
    replaceState: vi.fn()
  };
  const dependencies = {
    createEntryStorage: vi.fn(() => storage),
    createEntryMutationLock: vi.fn(() => mutationLock),
    capturePairingFragment: vi.fn(() => null),
    createApiClient: vi.fn(() => ({})),
    createEntryController: vi.fn((input) => {
      controllerInput = input;
      return controller;
    })
  };
  const page = createMemberPageAdapter({
    documentRef: harness.document,
    globalTarget: eventTarget,
    locationRef,
    historyRef,
    localStorageRef: {},
    sessionStorageRef: {},
    cryptoImpl: {},
    navigatorRef: {
      platform: "Test OS",
      userAgent: "Test Browser"
    },
    confirmImpl: () => true,
    dependencies
  });
  return {
    harness,
    setCustomValidity,
    eventTarget,
    controller,
    get controllerInput() {
      return controllerInput;
    },
    dependencies,
    locationRef,
    historyRef,
    page
  };
}

describe("Member Web product modules", () => {
  it("ships syntactically valid focused ES modules through explicit product routes", () => {
    const registration = readFileSync(gatewaySource, "utf8");
    for (const name of modules) {
      const result = spawnSync(process.execPath, ["--check", join(publicDirectory, name)], {
        encoding: "utf8"
      });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
      expect(registration).toContain(`"/member/assets/${name}"`);
    }
    expect(registration).not.toContain("fastify-static");
    expect(registration).not.toContain("acceptance.js");
  });

  it("renders the normal Chat and Work product structure without debug or acceptance controls", () => {
    const html = read("index.html");
    for (const required of [
      'id="chatSection"',
      'id="workSection"',
      'id="currentAgentIdentity"',
      'id="threadMessages"',
      'aria-live="polite"',
      'id="messageComposer"',
      'id="messageInput"',
      'id="sendMessageButton"',
      'id="loadEarlierButton"',
      'id="workList"',
      'id="createWorkButton"',
      'id="createWorkDialog"',
      'id="workDetail"',
      'id="workProgress"',
      'id="chatToWorkDialog"',
      'id="mobileNavigation"'
    ]) {
      expect(html).toContain(required);
    }
    expect(html).not.toContain("验收台");
    expect(html).not.toContain("一键验收");
    expect(html).not.toContain("调试日志");
    expect(html).not.toContain("暂停 Work");
    expect(html).not.toContain("完成 Work");
    expect(html).not.toContain("归档 Work");
  });

  it("supports keyboard, touch, reduced motion and responsive layouts", () => {
    const html = read("index.html");
    const css = read("member.css");
    expect(html).toContain('aria-label="消息输入"');
    expect(html).toContain('<dialog id="createWorkDialog"');
    expect(html).toContain('<dialog id="chatToWorkDialog"');
    expect(css).toContain("@media (max-width:");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toContain(".mobile-navigation");
  });

  it("keeps user content in textContent-based rendering and credentials outside product modules", () => {
    const render = read("render.js");
    expect(render).toContain("textContent");
    expect(render).not.toContain("innerHTML");

    const source = modules.map(read).join("\n");
    expect(source).not.toContain("document.cookie");
    expect(source).not.toContain("family_ai_web_entry_token");
    expect(source).not.toContain("family_ai_web_device_credential");
    expect(source).not.toContain("externalSessionRef");
  });

  it.each(["installation lock", "LocalStorage"])(
    "fails closed on %s initialization failure without exposing fragment material",
    async (failure) => {
      const { harness } = memberPageHarness();
      const eventTarget = new EventTarget();
      const secret =
        "SENSITIVE-PAIRING-MATERIAL-SHOULD-NOT-RENDER";
      const initializationError = new Error(secret);
      const storage = {
        getOrCreateInstallationIdLocked: vi.fn(() => {
          if (failure === "LocalStorage") {
            throw initializationError;
          }
          return "00000000-0000-4000-8000-000000000041";
        })
      };
      const mutationLock = {
        runInstallationInit: vi.fn(
          async (operation: () => unknown) => {
            if (failure === "installation lock") {
              throw initializationError;
            }
            return operation();
          }
        )
      };
      const locationRef = {
        href:
          `http://member.test/member/#code=${secret}` +
          `&pairingRef=${secret}`,
        reload: vi.fn()
      };
      const historyRef = {
        state: null,
        replaceState: vi.fn()
      };
      const dependencies = {
        createEntryStorage: vi.fn(() => storage),
        createEntryMutationLock: vi.fn(() => mutationLock),
        capturePairingFragment: vi.fn(),
        createApiClient: vi.fn(),
        createEntryController: vi.fn()
      };
      const page = createMemberPageAdapter({
        documentRef: harness.document,
        globalTarget: eventTarget,
        locationRef,
        historyRef,
        localStorageRef: {},
        sessionStorageRef: {},
        cryptoImpl: {},
        navigatorRef: {},
        dependencies
      });

      await expect(page.ready).rejects.toBe(initializationError);
      expect(
        dependencies.capturePairingFragment
      ).not.toHaveBeenCalled();
      expect(dependencies.createApiClient).not.toHaveBeenCalled();
      expect(dependencies.createEntryController).not.toHaveBeenCalled();
      expect(historyRef.replaceState).toHaveBeenCalledWith(
        null,
        "",
        "/member/"
      );
      expect(harness.elements.errorMessage.textContent).toBe(
        "无法安全初始化此浏览器入口，请重新加载页面。"
      );
      expect(harness.elements.errorMessage.textContent).not.toContain(
        secret
      );
      expect(
        harness.elements.loadingState.classList.contains("hidden")
      ).toBe(true);
      expect(
        harness.elements.pairForm.classList.contains("hidden")
      ).toBe(true);
      expect(
        harness.elements.errorState.classList.contains("hidden")
      ).toBe(false);

      harness.click("retryButton");
      expect(locationRef.reload).toHaveBeenCalledOnce();
    }
  );

  it.each([
    {
      failure: "localStorage accessor",
      accessor: "localStorage",
      factory: null
    },
    {
      failure: "sessionStorage accessor",
      accessor: "sessionStorage",
      factory: null
    },
    {
      failure: "storage factory",
      accessor: null,
      factory: "storage"
    },
    {
      failure: "mutation factory",
      accessor: null,
      factory: "mutation"
    }
  ] as const)(
    "captures a synchronous $failure failure in ready and renders one safe reload path",
    async ({ failure, accessor, factory }) => {
      const { harness } = memberPageHarness();
      const eventTarget = new EventTarget();
      const secret = `SENSITIVE-${failure}-FAILURE`;
      const initializationError = new Error(secret);
      const installationId =
        "00000000-0000-4000-8000-000000000061";
      const storage = {
        getOrCreateInstallationIdLocked: vi.fn(
          () => installationId
        )
      };
      const mutationLock = {
        runInstallationInit: vi.fn(
          async (operation: () => unknown) => operation()
        )
      };
      const locationRef = {
        href:
          "http://member.test/member/" +
          `#code=${encodeURIComponent(secret)}` +
          "&pairingRef=pairing%3Ainit-failure",
        reload: vi.fn()
      };
      const historyRef = {
        state: null,
        replaceState: vi.fn()
      };
      const dependencies = {
        createEntryStorage: vi.fn(() => {
          if (factory === "storage") {
            throw initializationError;
          }
          return storage;
        }),
        createEntryMutationLock: vi.fn(() => {
          if (factory === "mutation") {
            throw initializationError;
          }
          return mutationLock;
        }),
        capturePairingFragment: vi.fn(),
        createApiClient: vi.fn(),
        createEntryController: vi.fn()
      };
      const originalDescriptor = accessor
        ? Object.getOwnPropertyDescriptor(globalThis, accessor)
        : undefined;
      if (accessor) {
        Object.defineProperty(globalThis, accessor, {
          configurable: true,
          get() {
            throw initializationError;
          }
        });
      }

      let page:
        | ReturnType<typeof createMemberPageAdapter>
        | undefined;
      let synchronousError: unknown;
      try {
        page = createMemberPageAdapter({
          documentRef: harness.document,
          globalTarget: eventTarget,
          locationRef,
          historyRef,
          ...(accessor === "localStorage"
            ? {}
            : { localStorageRef: {} }),
          ...(accessor === "sessionStorage"
            ? {}
            : { sessionStorageRef: {} }),
          cryptoImpl: {},
          navigatorRef: {},
          dependencies
        });
      } catch (error) {
        synchronousError = error;
      } finally {
        if (accessor) {
          if (originalDescriptor) {
            Object.defineProperty(
              globalThis,
              accessor,
              originalDescriptor
            );
          } else {
            Reflect.deleteProperty(globalThis, accessor);
          }
        }
      }

      expect(synchronousError).toBeUndefined();
      expect(page?.ready).toBeInstanceOf(Promise);
      await expect(page?.ready).rejects.toBe(initializationError);
      expect(
        dependencies.capturePairingFragment
      ).not.toHaveBeenCalled();
      expect(dependencies.createApiClient).not.toHaveBeenCalled();
      expect(dependencies.createEntryController).not.toHaveBeenCalled();
      expect(historyRef.replaceState).toHaveBeenCalledWith(
        null,
        "",
        "/member/"
      );
      expect(harness.elements.errorMessage.textContent).toBe(
        "无法安全初始化此浏览器入口，请重新加载页面。"
      );
      expect([
        harness.elements.errorMessage.textContent,
        harness.elements.pairingMessage.textContent,
        harness.elements.connectionStatus.textContent
      ].join("\n")).not.toContain(secret);

      page?.showFatalError(initializationError);
      page?.showFatalError(initializationError);
      harness.click("retryButton");
      expect(locationRef.reload).toHaveBeenCalledOnce();
    }
  );

  it.each(["SessionStorage", "crypto"])(
    "scrubs a valid fragment and fails closed before API when %s credential creation fails",
    async (failure) => {
      const { harness } = memberPageHarness();
      const secret = "SENSITIVE-CREDENTIAL-FAILURE";
      const trace: string[] = [];
      const installationId =
        "00000000-0000-4000-8000-000000000051";
      const storage = {
        getOrCreateInstallationIdLocked: vi.fn(
          () => installationId
        )
      };
      const mutationLock = {
        runInstallationInit: vi.fn(
          async (operation: () => unknown) => operation()
        )
      };
      const sessionStorageRef = {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => {
          if (failure === "SessionStorage") {
            throw new Error(secret);
          }
        }),
        removeItem: vi.fn()
      };
      const cryptoImpl = {
        getRandomValues<T extends ArrayBufferView>(values: T) {
          if (failure === "crypto") {
            throw new Error(secret);
          }
          new Uint8Array(
            values.buffer,
            values.byteOffset,
            values.byteLength
          ).fill(0);
          return values;
        }
      };
      const locationRef = {
        href:
          "http://member.test/member/" +
          "#pairingRef=pairing%3Acredential-failure" +
          "&code=ABCD-EFGH",
        reload: vi.fn()
      };
      const historyRef = {
        state: null,
        replaceState: vi.fn(
          (_state, _title, url) => {
            trace.push(`scrub:${url}`);
          }
        )
      };
      const controller = {
        bootstrap: vi.fn(async () => undefined),
        claim: vi.fn(async () => undefined),
        logout: vi.fn(async () => undefined),
        resume: vi.fn(async () => undefined),
        retry: vi.fn(async () => undefined),
        removeDevice: vi.fn(async () => undefined),
        destroy: vi.fn(async () => undefined),
        handleEntryFailure: vi.fn(async () => true),
        getState: vi.fn(() => ({ name: "unpaired" }))
      };
      const dependencies = {
        createEntryStorage: vi.fn(() => storage),
        createEntryMutationLock: vi.fn(() => mutationLock),
        createApiClient: vi.fn(() => {
          trace.push("api");
          return {};
        }),
        createEntryController: vi.fn(() => {
          trace.push("controller");
          return controller;
        })
      };
      const page = createMemberPageAdapter({
        documentRef: harness.document,
        globalTarget: new EventTarget(),
        locationRef,
        historyRef,
        localStorageRef: {},
        sessionStorageRef,
        cryptoImpl,
        navigatorRef: {},
        dependencies
      });

      const outcome = await page.ready.then(
        () => null,
        (error) => error
      );
      expect(outcome).toMatchObject({
        code: "PAIRING_CREDENTIAL_UNAVAILABLE"
      });
      expect(trace).toEqual(["scrub:/member/"]);
      expect(dependencies.createApiClient).not.toHaveBeenCalled();
      expect(
        dependencies.createEntryController
      ).not.toHaveBeenCalled();
      expect(harness.elements.errorMessage.textContent).toBe(
        "无法安全初始化此浏览器入口，请重新加载页面。"
      );
      expect([
        harness.elements.errorMessage.textContent,
        harness.elements.pairingMessage.textContent,
        harness.elements.connectionStatus.textContent
      ].join("\n")).not.toContain(secret);

      harness.click("retryButton");
      expect(locationRef.reload).toHaveBeenCalledOnce();
    }
  );

  it("turns bootstrap rejection into one inert fatal reload path and disposes the controller", async () => {
    const fixture = createAdapterFixture();
    const secret = "SENSITIVE-BOOTSTRAP-FAILURE";
    const bootstrapError = new Error(secret);
    fixture.controller.bootstrap.mockRejectedValueOnce(
      bootstrapError
    );

    await expect(fixture.page.ready).rejects.toBe(
      bootstrapError
    );
    await fixture.harness.whenIdle();
    expect(fixture.controller.destroy).toHaveBeenCalledOnce();
    expect(
      fixture.harness.elements.errorMessage.textContent
    ).toBe("无法安全初始化此浏览器入口，请重新加载页面。");
    expect(
      fixture.harness.elements.errorMessage.textContent
    ).not.toContain(secret);

    fixture.page.showFatalError(bootstrapError);
    fixture.page.showFatalError(bootstrapError);
    fixture.harness.click("retryButton");
    await fixture.harness.whenIdle();
    expect(fixture.locationRef.reload).toHaveBeenCalledOnce();
    expect(fixture.controller.retry).not.toHaveBeenCalled();

    await Promise.all([
      fixture.page.destroy(),
      fixture.page.destroy()
    ]);
    expect(fixture.controller.destroy).toHaveBeenCalledOnce();
  });

  it("contains rejected controller UI actions and renders one fixed safe error", async () => {
    const fixture = createAdapterFixture();
    await fixture.page.ready;
    const secret = "SENSITIVE-CONTROLLER-ERROR";
    for (const action of [
      fixture.controller.logout,
      fixture.controller.resume,
      fixture.controller.retry,
      fixture.controller.removeDevice
    ]) {
      action.mockRejectedValueOnce(new Error(secret));
    }

    fixture.harness.click("logoutButton");
    fixture.harness.click("resumeBrowserButton");
    fixture.harness.click("retryButton");
    fixture.harness.click("revokeButton");
    await fixture.harness.whenIdle();
    await fixture.harness.whenIdle();

    expect(fixture.controller.logout).toHaveBeenCalledOnce();
    expect(fixture.controller.resume).toHaveBeenCalledOnce();
    expect(fixture.controller.retry).toHaveBeenCalledOnce();
    expect(fixture.controller.removeDevice).toHaveBeenCalledOnce();
    expect(
      fixture.harness.elements.errorMessage.textContent
    ).toBe("操作未完成，请重新尝试。");
    expect(
      fixture.harness.elements.errorMessage.textContent
    ).not.toContain(secret);
  });

  it("keeps BFCache pages alive and idempotently unbinds every listener on final destroy", async () => {
    const fixture = createAdapterFixture();
    await fixture.page.ready;
    const pageEvent = (type: string, persisted: boolean) => {
      const event = new Event(type);
      Object.defineProperty(event, "persisted", {
        value: persisted
      });
      return event;
    };

    fixture.eventTarget.dispatchEvent(
      pageEvent("pagehide", true)
    );
    fixture.eventTarget.dispatchEvent(
      pageEvent("pageshow", true)
    );
    await fixture.harness.whenIdle();
    expect(fixture.controller.destroy).not.toHaveBeenCalled();

    fixture.harness.click("logoutButton");
    await fixture.harness.whenIdle();
    expect(fixture.controller.logout).toHaveBeenCalledOnce();

    fixture.eventTarget.dispatchEvent(
      pageEvent("pagehide", false)
    );
    await fixture.harness.whenIdle();
    expect(fixture.controller.destroy).toHaveBeenCalledOnce();
    await Promise.all([
      fixture.page.destroy(),
      fixture.page.destroy()
    ]);
    expect(fixture.controller.destroy).toHaveBeenCalledOnce();

    const calls = {
      logout: fixture.controller.logout.mock.calls.length,
      resume: fixture.controller.resume.mock.calls.length,
      retry: fixture.controller.retry.mock.calls.length,
      remove: fixture.controller.removeDevice.mock.calls.length
    };
    fixture.harness.click("logoutButton");
    fixture.harness.click("resumeBrowserButton");
    fixture.harness.click("retryButton");
    fixture.harness.click("revokeButton");
    fixture.eventTarget.dispatchEvent(new Event("online"));
    fixture.eventTarget.dispatchEvent(new Event("offline"));
    fixture.eventTarget.dispatchEvent(
      pageEvent("pagehide", false)
    );
    await fixture.harness.whenIdle();
    expect(fixture.controller.logout).toHaveBeenCalledTimes(
      calls.logout
    );
    expect(fixture.controller.resume).toHaveBeenCalledTimes(
      calls.resume
    );
    expect(fixture.controller.retry).toHaveBeenCalledTimes(
      calls.retry
    );
    expect(fixture.controller.removeDevice).toHaveBeenCalledTimes(
      calls.remove
    );
    expect(fixture.controller.destroy).toHaveBeenCalledOnce();
  });

  it("clears pairing code bytes and validity on active and terminal states", async () => {
    const fixture = createAdapterFixture();
    await fixture.page.ready;
    const pairingCode = fixture.harness.elements.pairingCode;

    pairingCode.value = "ABCD-EFGH";
    fixture.setCustomValidity.mockClear();
    fixture.controllerInput.onViewState({
      name: "active",
      busy: false,
      code: null,
      message: null,
      showResume: false
    });
    expect(pairingCode.value).toBe("");
    expect(fixture.setCustomValidity).toHaveBeenLastCalledWith("");

    pairingCode.value = "JKLM-NPQR";
    fixture.setCustomValidity.mockClear();
    fixture.controllerInput.onViewState({
      name: "unpaired",
      busy: false,
      code: "PAIRING_INVALID",
      message: "安全错误",
      showResume: false
    });
    expect(pairingCode.value).toBe("");
    expect(fixture.setCustomValidity).toHaveBeenLastCalledWith("");
  });

  it("boots the adapter secret-first and uses the current installation for manual Pair", async () => {
    const harness = createMemberDocumentHarness();
    for (const element of Object.values(harness.elements)) {
      Object.assign(element.classList, {
        remove(...names: string[]) {
          for (const name of names) element.classList.values.delete(name);
        }
      });
    }
    const eventTarget = new EventTarget();
    const historyRef = { state: null, replaceState: vi.fn() };

    const trace: string[] = [];
    const firstInstallation =
      "00000000-0000-4000-8000-000000000011";
    const rotatedInstallation =
      "00000000-0000-4000-8000-000000000012";
    let currentInstallation = firstInstallation;
    const storage = {
      getOrCreateInstallationIdLocked: vi.fn(() => {
        trace.push("installation");
        return firstInstallation;
      }),
      readInstallationId: vi.fn(() => currentInstallation),
      readClaimCookieIntent: vi.fn(() => null),
      readCookieClearPending: vi.fn(() => null),
      writeIdentityPointer: vi.fn()
    };
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    const mutationLock = {
      runInstallationInit: vi.fn(async (operation: () => unknown) => {
        trace.push("init-request");
        await initializationGate;
        trace.push("init-enter");
        const result = operation();
        trace.push("init-exit");
        return result;
      }),
      acquireProductFlight: vi.fn(async () => ({
        release: async () => {}
      })),
      runCacheOpen: vi.fn(
        async (
          _installationId: string,
          operation: () => unknown
        ) => operation()
      )
    };
    const controller = {
      bootstrap: vi.fn(async () => undefined),
      claim: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
      removeDevice: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
      handleEntryFailure: vi.fn(async () => true)
    };
    let controllerInput: any;
    let productOptions: any;
    const pending = {
      protocolVersion: 2,
      code: "ABCD-EFGH",
      installationId: firstInstallation
    };
    const preparePendingClaim = vi.fn((input) => ({
      ...pending,
      installationId: input.installationId
    }));
    let resolveProductStart!: (value: unknown) => void;
    const firstProductStart = new Promise((resolve) => {
      resolveProductStart = resolve;
    });
    const dependencies = {
      createEntryStorage: vi.fn(() => {
        trace.push("storage");
        return storage;
      }),
      capturePairingFragment: vi.fn(() => {
        trace.push("fragment");
        return pending;
      }),
      createApiClient: vi.fn(() => {
        trace.push("api");
        return {};
      }),
      createEntryMutationLock: vi.fn(() => {
        trace.push("mutation-lock");
        return mutationLock;
      }),
      createEntryController: vi.fn((input) => {
        trace.push("controller");
        controllerInput = input;
        return controller;
      }),
      deleteLegacyMemberCache: vi.fn(async () => undefined),
      deleteIdentityMemberCache: vi.fn(async () => undefined),
      startProductWorkbench: vi.fn((_context, options) => {
        productOptions = options;
        return firstProductStart;
      }),
      stopProductWorkbench: vi.fn(async () => undefined),
      preparePendingClaim,
      clearPendingClaim: vi.fn(),
      isTerminalPairingError: vi.fn(() => false),
      shouldRetainPendingClaim: vi.fn(() => true),
      normalizePairingCode: vi.fn((value) =>
        String(value).trim().toUpperCase()
      )
    };
    const page = createMemberPageAdapter({
      documentRef: harness.document,
      globalTarget: eventTarget,
      locationRef: {
        href: "http://member.test/member/#code=ABCD-EFGH"
      },
      historyRef,
      localStorageRef: {},
      sessionStorageRef: {},
      cryptoImpl: {},
      navigatorRef: {
        platform: "Test OS",
        userAgent: "Test Browser"
      },
      confirmImpl: () => true,
      dependencies
    });
    expect(trace).toEqual([
      "storage",
      "mutation-lock",
      "init-request"
    ]);
    expect(storage.getOrCreateInstallationIdLocked).not.toHaveBeenCalled();
    expect(
      dependencies.capturePairingFragment
    ).not.toHaveBeenCalled();
    expect(dependencies.createApiClient).not.toHaveBeenCalled();
    expect(dependencies.createEntryController).not.toHaveBeenCalled();

    releaseInitialization();
    await page.ready;
    expect(trace).toEqual([
      "storage",
      "mutation-lock",
      "init-request",
      "init-enter",
      "installation",
      "init-exit",
      "fragment",
      "api",
      "controller"
    ]);
    expect(controller.bootstrap).toHaveBeenCalledWith({
      pendingClaim: pending,
      fragmentError: null
    });

    const guard = vi.fn();
    const context = {
      person: { displayName: "Alice" },
      family: { displayName: "Family" },
      device: { displayName: "Browser" }
    };
    const start = controllerInput.workbench.start(
      context,
      firstInstallation,
      guard
    );
    await Promise.resolve();
    expect([
      harness.elements.personName.textContent,
      harness.elements.familyName.textContent,
      harness.elements.deviceName.textContent,
      harness.elements.personAvatar.textContent
    ]).toEqual(["", "", "", ""]);
    resolveProductStart({ destroy: async () => {} });
    await expect(
      start
    ).resolves.toBe(true);
    expect([
      harness.elements.personName.textContent,
      harness.elements.familyName.textContent,
      harness.elements.deviceName.textContent,
      harness.elements.personAvatar.textContent
    ]).toEqual(["Alice", "Family", "Browser", "A"]);
    controllerInput.onViewState({
      name: "active",
      busy: false,
      showResume: false
    });
    expect(
      harness.elements.workspaceView.classList.contains("hidden")
    ).toBe(false);

    for (const [element, value] of [
      [harness.elements.personName, "Trusted Person"],
      [harness.elements.familyName, "Trusted Family"],
      [harness.elements.deviceName, "Trusted Device"],
      [harness.elements.personAvatar, "T"]
    ] as const) {
      element.textContent = value;
    }
    dependencies.startProductWorkbench.mockResolvedValueOnce(null);
    await expect(
      controllerInput.workbench.start(
        {
          person: { displayName: "Untrusted Person" },
          family: { displayName: "Untrusted Family" },
          device: { displayName: "Untrusted Device" }
        },
        firstInstallation,
        vi.fn()
      )
    ).resolves.toBe(false);
    expect([
      harness.elements.personName.textContent,
      harness.elements.familyName.textContent,
      harness.elements.deviceName.textContent,
      harness.elements.personAvatar.textContent
    ]).toEqual([
      "Trusted Person",
      "Trusted Family",
      "Trusted Device",
      "T"
    ]);

    const identityMismatch = Object.assign(
      new Error("CACHE_IDENTITY_MISMATCH"),
      { code: "CACHE_IDENTITY_MISMATCH" }
    );
    dependencies.startProductWorkbench.mockRejectedValueOnce(
      identityMismatch
    );
    await expect(
      controllerInput.workbench.start(
        {
          person: { displayName: "Spoofed Person" },
          family: { displayName: "Spoofed Family" },
          device: { displayName: "Spoofed Device" }
        },
        firstInstallation,
        vi.fn()
      )
    ).rejects.toBe(identityMismatch);
    expect([
      harness.elements.personName.textContent,
      harness.elements.familyName.textContent,
      harness.elements.deviceName.textContent,
      harness.elements.personAvatar.textContent
    ]).toEqual([
      "Trusted Person",
      "Trusted Family",
      "Trusted Device",
      "T"
    ]);

    expect(productOptions.assertEntryStartable).toBe(guard);
    await productOptions.acquireProductFlight();
    await productOptions.withIdentityOpenLock(
      async () => undefined
    );
    expect(
      mutationLock.acquireProductFlight
    ).toHaveBeenCalledWith(firstInstallation);
    expect(mutationLock.runCacheOpen).toHaveBeenCalledWith(
      firstInstallation,
      expect.any(Function)
    );
    productOptions.onCacheValidated({
      personRef: "person:alice",
      deviceRef: "device:web"
    });
    expect(storage.writeIdentityPointer).toHaveBeenCalledOnce();
    await productOptions.onEntryInvalid({
      code: "DEVICE_AUTH_INVALID"
    });
    await productOptions.onEntryRevoked({
      code: "DEVICE_REVOKED"
    });
    expect(controller.handleEntryFailure).toHaveBeenCalledTimes(2);

    currentInstallation = rotatedInstallation;
    await page.submitManualPairing("abcd-efgh");
    expect(preparePendingClaim).toHaveBeenLastCalledWith(
      expect.objectContaining({
        code: "ABCD-EFGH",
        installationId: rotatedInstallation
      })
    );
    expect(controller.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: rotatedInstallation
      })
    );

    harness.click("logoutButton");
    harness.click("resumeBrowserButton");
    harness.click("retryButton");
    harness.click("revokeButton");
    await harness.whenIdle();
    eventTarget.dispatchEvent(new Event("pagehide"));
    await harness.whenIdle();
    expect(controller.logout).toHaveBeenCalledOnce();
    expect(controller.resume).toHaveBeenCalledOnce();
    expect(controller.retry).toHaveBeenCalledOnce();
    expect(controller.removeDevice).toHaveBeenCalledOnce();
    expect(controller.destroy).toHaveBeenCalledOnce();
  });

  it("serializes concurrent first-installation adapters and re-reads the winner inside init lock", async () => {
    const firstInstallation =
      "00000000-0000-4000-8000-000000000021";
    let sharedInstallation: string | null = null;
    const observedBeforeCreate: Array<string | null> = [];
    const capturedInstallations: string[] = [];
    let generated = 0;
    let initRequests = 0;
    let initEntries = 0;
    let initLane: Promise<unknown> = Promise.resolve();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });

    function storage() {
      return {
        getOrCreateInstallationIdLocked: vi.fn(() => {
          observedBeforeCreate.push(sharedInstallation);
          if (sharedInstallation === null) {
            generated += 1;
            sharedInstallation = firstInstallation;
          }
          return sharedInstallation;
        }),
        readInstallationId: () => sharedInstallation,
        readClaimCookieIntent: () => null,
        readCookieClearPending: () => null,
        writeIdentityPointer: vi.fn()
      };
    }

    function mutationLock() {
      return {
        runInstallationInit(operation: () => unknown) {
          initRequests += 1;
          const queued = initLane.then(async () => {
            initEntries += 1;
            if (initEntries === 1) {
              signalFirstEntered();
              await firstGate;
            }
            return operation();
          });
          initLane = queued.then(
            () => undefined,
            () => undefined
          );
          return queued;
        },
        acquireProductFlight: async () => ({
          release: async () => {}
        }),
        runCacheOpen: async (
          _installationId: string,
          operation: () => unknown
        ) => operation()
      };
    }

    const controllers: any[] = [];
    const dependencies = {
      createEntryStorage: vi.fn(() => storage()),
      createEntryMutationLock: vi.fn(() => mutationLock()),
      capturePairingFragment: vi.fn((input) => {
        capturedInstallations.push(input.installationId);
        return null;
      }),
      createApiClient: vi.fn(() => ({})),
      createEntryController: vi.fn(() => {
        const controller = {
          bootstrap: vi.fn(async () => undefined),
          claim: vi.fn(async () => undefined),
          logout: vi.fn(async () => undefined),
          resume: vi.fn(async () => undefined),
          retry: vi.fn(async () => undefined),
          removeDevice: vi.fn(async () => undefined),
          destroy: vi.fn(async () => undefined),
          handleEntryFailure: vi.fn(async () => true),
          getState: vi.fn(() => ({ name: "unpaired" }))
        };
        controllers.push(controller);
        return controller;
      })
    };
    const makePage = () =>
      createMemberPageAdapter({
        documentRef: createMemberDocumentHarness().document,
        globalTarget: new EventTarget(),
        locationRef: {
          href: "http://member.test/member/"
        },
        historyRef: {
          state: null,
          replaceState: vi.fn()
        },
        localStorageRef: {},
        sessionStorageRef: {},
        cryptoImpl: {},
        navigatorRef: {
          platform: "Test OS",
          userAgent: "Test Browser"
        },
        confirmImpl: () => false,
        dependencies
      });

    const first = makePage();
    const second = makePage();
    expect(initRequests).toBe(2);
    expect(observedBeforeCreate).toEqual([]);
    expect(capturedInstallations).toEqual([]);
    expect(dependencies.createApiClient).not.toHaveBeenCalled();
    expect(dependencies.createEntryController).not.toHaveBeenCalled();

    await firstEntered;
    expect(observedBeforeCreate).toEqual([]);
    releaseFirst();
    await Promise.all([first.ready, second.ready]);

    expect(initEntries).toBe(2);
    expect(generated).toBe(1);
    expect(observedBeforeCreate).toEqual([
      null,
      firstInstallation
    ]);
    expect(capturedInstallations).toEqual([
      firstInstallation,
      firstInstallation
    ]);
    expect(dependencies.createApiClient).toHaveBeenCalledTimes(2);
    expect(dependencies.createEntryController).toHaveBeenCalledTimes(2);
    expect(controllers).toHaveLength(2);
    expect(first.controller).toBe(controllers[0]);
    expect(second.controller).toBe(controllers[1]);
  });

});
