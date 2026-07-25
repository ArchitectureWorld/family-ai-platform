import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("one-click Member Web experience", () => {
  it("hands the verified real Family state to the normal product workbench", () => {
    const onboarding = read("scripts/acceptance-onboarding.sh");
    const verify = read("scripts/verify-foundation.sh");

    expect(onboarding).toContain("/api/v1/admin/members/$PERSON_REF/pairing-codes");
    expect(onboarding).toContain("/member/?pairingRef=");
    expect(onboarding).toContain("member-web-url");
    expect(onboarding).not.toContain("#token=");

    expect(verify).toContain("member-web-url");
    expect(verify).toContain("真实个人工作台");
    expect(verify).not.toContain("beginner browser acceptance");
    expect(verify).not.toContain("家庭 AI 初始化与入口验收台");
    expect(verify).not.toContain("#token=");
    expect(verify).not.toContain("创建家庭并进入门户");
  });

  it("describes verification only through normal Chat, Work and recovery behavior", () => {
    const verify = read("scripts/verify-foundation.sh");
    for (const normalProductStep of [
      "发送一条 Chat 消息",
      "看到个人助理回复",
      "创建一个 Work",
      "在 Work 中继续对话",
      "刷新页面",
      "restart gateway"
    ]) {
      expect(verify).toContain(normalProductStep);
    }
    expect(verify).not.toContain("点击一键验收");
    expect(verify).not.toContain("打开验收台");
  });

  it("does not execute another reset after generating the product pairing link", () => {
    const verify = read("scripts/verify-foundation.sh");
    const stepSix = verify.slice(verify.indexOf("[6/6]"));
    expect(stepSix).not.toMatch(/^\.\/scripts\/dev-reset\.sh --yes/m);
    expect(stepSix).not.toMatch(/^\.\/scripts\/dev-up\.sh/m);
  });
});
