import {
  ADMIN_CLEAN_PATH,
  captureAdminHandoff,
  clearStoredAdminCredential,
  readStoredAdminCredential,
  writeStoredAdminCredential
} from "./admin-entry.js";
import { AdminApiError, createAdminApi } from "./admin-api.js";

const states = new Map(
  [...document.querySelectorAll("[data-state]")]
    .map(element => [element.dataset.state, element])
);
const setupRoot = document.querySelector("#family-setup-root");
const summaryRoot = document.querySelector("#family-summary");
const membersRoot = document.querySelector("#member-management-root");

export function showAdminState(name) {
  if (!states.has(name)) throw new Error("ADMIN_STATE_INVALID");
  for (const [stateName, element] of states) {
    element.hidden = stateName !== name;
  }
}

function element(name, { className, text, attributes = {} } = {}) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value);
  }
  return node;
}

function labeledInput(labelText, name, autocomplete) {
  const label = element("label", { className: "field" });
  label.append(element("span", { text: labelText }));
  label.append(element("input", {
    attributes: {
      name,
      autocomplete,
      maxlength: "80",
      required: ""
    }
  }));
  return label;
}

function messageNode() {
  return element("p", {
    className: "form-message",
    attributes: { role: "status", "aria-live": "polite" }
  });
}

function errorText(error) {
  if (error instanceof AdminApiError) {
    if (["ENTRY_SESSION_INVALID", "ENTRY_SESSION_EXPIRED", "DEVICE_REVOKED"].includes(error.code)) {
      return "管理员入口已失效，请重新生成入口后再试。";
    }
    if (error.code === "REQUEST_INVALID") return "请检查填写的名称和成员角色。";
  }
  return "暂时无法完成操作，请稍后重试。";
}

function renderFamilySetup(bootstrapCredential) {
  setupRoot.replaceChildren();
  const form = element("form", { className: "form-grid" });
  const feedback = messageNode();
  const submit = element("button", {
    className: "primary-button",
    text: "创建家庭并进入管理",
    attributes: { type: "submit" }
  });
  form.append(
    labeledInput("家庭名称", "familyName", "organization"),
    labeledInput("管理员姓名", "ownerName", "name"),
    labeledInput("管理设备名称", "deviceName", "off"),
    submit,
    feedback
  );
  form.addEventListener("submit", async event => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "正在创建家庭…";
    try {
      const data = new FormData(form);
      const result = await createAdminApi({
        credential: bootstrapCredential
      }).createFamily({
        familyName: data.get("familyName"),
        ownerName: data.get("ownerName"),
        deviceName: data.get("deviceName")
      });
      writeStoredAdminCredential(sessionStorage, result.adminCredential);
      await renderManagement(result.adminCredential);
    } catch (error) {
      feedback.textContent = errorText(error);
      submit.disabled = false;
    }
  });
  setupRoot.append(form);
  showAdminState("create-family");
}

function roleLabel(role) {
  return new Map([
    ["owner", "管理员"],
    ["adult", "成人"],
    ["child", "孩子"],
    ["elder", "长辈"]
  ]).get(role) ?? "成员";
}

function memberCard(member) {
  const card = element("article", { className: "member-card" });
  const identity = element("div");
  identity.append(
    element("h3", { text: member.displayName }),
    element("p", {
      text: `${roleLabel(member.familyRole)} · ${member.activePersonalDeviceCount ?? 0} 台个人设备`
    })
  );
  const pair = element("button", {
    className: "secondary-button",
    text: "生成配对码",
    attributes: {
      type: "button",
      "data-pair-person-ref": member.personRef,
      disabled: "",
      title: "配对功能正在载入"
    }
  });
  card.append(identity, pair);
  return card;
}

async function renderManagement(credential) {
  const api = createAdminApi({ credential });
  const [context, memberResult] = await Promise.all([
    api.context(),
    api.members()
  ]);

  summaryRoot.replaceChildren();
  summaryRoot.append(
    element("p", {
      className: "family-name",
      text: context.family.displayName
    }),
    element("p", {
      className: "family-meta",
      text: `${context.person.displayName} · 家庭管理员`
    })
  );

  membersRoot.replaceChildren();
  const list = element("div", {
    className: "member-list",
    attributes: { "aria-label": "家庭成员" }
  });
  for (const member of memberResult.members) list.append(memberCard(member));

  const form = element("form", { className: "member-form" });
  const nameField = labeledInput("新成员姓名", "displayName", "name");
  const roleField = element("label", { className: "field" });
  const select = element("select", {
    attributes: { name: "familyRole", required: "" }
  });
  for (const [value, text] of [
    ["adult", "成人"],
    ["child", "孩子"],
    ["elder", "长辈"]
  ]) {
    select.append(element("option", { text, attributes: { value } }));
  }
  roleField.append(element("span", { text: "成员角色" }), select);
  const feedback = messageNode();
  const submit = element("button", {
    className: "primary-button",
    text: "添加成员",
    attributes: { type: "submit" }
  });
  form.append(nameField, roleField, submit, feedback);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "正在添加成员…";
    try {
      const data = new FormData(form);
      await api.addMember({
        displayName: data.get("displayName"),
        familyRole: data.get("familyRole")
      });
      feedback.textContent = "成员已添加。";
      await renderManagement(credential);
    } catch (error) {
      feedback.textContent = errorText(error);
      submit.disabled = false;
    }
  });

  membersRoot.append(
    element("h3", { className: "section-title", text: "家庭成员" }),
    list,
    element("h3", { className: "section-title", text: "添加成员" }),
    form
  );
  showAdminState("management");
}

async function start() {
  showAdminState("initializing");
  const rawFragment = window.location.hash;
  const hasQuery = window.location.search !== "";
  if (rawFragment !== "" || hasQuery) {
    window.history.replaceState(null, "", ADMIN_CLEAN_PATH);
  }

  let credential;
  try {
    credential = rawFragment !== ""
      ? captureAdminHandoff(rawFragment)
      : readStoredAdminCredential(sessionStorage);
    if (hasQuery) throw new Error("ADMIN_QUERY_FORBIDDEN");

    const status = await createAdminApi({ credential }).onboardingStatus();
    if (!status.initialized) {
      if (credential?.kind !== "bootstrap") throw new Error("ADMIN_BOOTSTRAP_REQUIRED");
      renderFamilySetup(credential);
      return;
    }
    if (credential?.kind !== "entry") throw new Error("ADMIN_ENTRY_REQUIRED");
    writeStoredAdminCredential(sessionStorage, credential);
    await renderManagement(credential);
  } catch {
    clearStoredAdminCredential(sessionStorage);
    showAdminState("recovery-required");
  }
}

start();
