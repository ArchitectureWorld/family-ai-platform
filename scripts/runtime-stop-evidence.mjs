#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { die, parseArgs, requireAbsolute, requireHex, requireSafeId, sealJson, sha256 } from "./runtime-release-lib.mjs";

const PREFIX = "RUNTIME_STOP_EVIDENCE_FAILED";
const phases = {
  "formal-production": new Set(["prepare-backup", "cutover-final-backup", "candidate-exchange", "candidate-rollback", "restore-previous", "activate-validation-stop", "activate-acceptance-stop", "attachment-integrity-repair"]),
  "fixture-rehearsal": new Set(["fixture-source-snapshot", "fixture-work-copy-stop", "candidate-exchange", "candidate-rollback", "restore-previous"])
};

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function listenerAbsent(expectedBind) {
  if (expectedBind === "none") return true;
  const match = expectedBind.match(/^127\.0\.0\.1:([1-9][0-9]{0,4})$/);
  if (!match) throw new Error("EXPECTED_BIND_INVALID");
  const result = spawnSync("ss", ["-H", "-ltn", `sport = :${match[1]}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("LISTENER_CHECK_FAILED");
  return result.stdout.trim() === "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    command: "capture",
    required: ["--scope", "--phase", "--release-id", "--expected-preflight-sha256", "--controller", "--expected-bind", "--output"],
    optional: ["--project-name", "--service", "--unit"]
  });
  const scope = args["--scope"];
  const phase = args["--phase"];
  if (!phases[scope]?.has(phase)) throw new Error("SCOPE_PHASE_INVALID");
  const releaseId = requireSafeId(args["--release-id"], "RELEASE_ID");
  const preflightSha = requireHex(args["--expected-preflight-sha256"], 64, "EXPECTED_PREFLIGHT_SHA256");
  const output = requireAbsolute(args["--output"], "OUTPUT", { exists: false });
  if ((scope === "formal-production" && args["--expected-bind"] === "none") || (scope === "fixture-rehearsal" && args["--expected-bind"] !== "none")) throw new Error("SCOPE_BIND_INVALID");
  const controller = args["--controller"];
  let identity;
  if (controller === "docker-compose") {
    const project = requireSafeId(args["--project-name"], "PROJECT_NAME");
    const service = args["--service"];
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(service ?? "") || args["--unit"]) throw new Error("DOCKER_CONTROLLER_ARGUMENTS_INVALID");
    const ids = run("docker", ["ps", "-aq", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`]).split("\n").filter(Boolean);
    if (ids.length !== 1 || !/^[0-9a-f]{64}$/.test(ids[0])) throw new Error("CONTROLLER_CONTAINER_NOT_UNIQUE");
    const inspection = JSON.parse(run("docker", ["inspect", ids[0]]));
    const container = inspection[0];
    if (container.State?.Running || container.State?.Restarting || container.State?.Paused) throw new Error("CONTROLLER_STILL_RUNNING");
    identity = { kind: controller, projectName: project, service, containerId: ids[0], imageId: container.Image, createdAt: container.Created, configSha256: sha256(Buffer.from(JSON.stringify({ image: container.Config?.Image, labels: container.Config?.Labels, mounts: container.HostConfig?.Binds, portBindings: container.HostConfig?.PortBindings }))) };
  } else if (controller === "systemd-user" || controller === "systemd-system") {
    const unit = args["--unit"];
    if (!/^[A-Za-z0-9@_.-]+\.service$/.test(unit ?? "") || args["--project-name"] || args["--service"]) throw new Error("SYSTEMD_CONTROLLER_ARGUMENTS_INVALID");
    const systemctlArgs = controller === "systemd-user" ? ["--user"] : [];
    const active = spawnSync("systemctl", [...systemctlArgs, "is-active", "--quiet", unit]);
    if (active.status === 0) throw new Error("CONTROLLER_STILL_RUNNING");
    const fragment = run("systemctl", [...systemctlArgs, "show", unit, "--property=FragmentPath", "--value"]);
    identity = { kind: controller, unit, fragmentPath: fragment || null, activeState: run("systemctl", [...systemctlArgs, "show", unit, "--property=ActiveState", "--value"]) };
  } else {
    throw new Error("CONTROLLER_INVALID");
  }
  if (!listenerAbsent(args["--expected-bind"])) throw new Error("LISTENER_STILL_PRESENT");
  const evidence = { manifestKind: "runtime-stop-evidence-v1", formatVersion: 1, scope, phase, releaseId, expectedPreflightSha256: preflightSha, capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), expectedBind: args["--expected-bind"], controller: identity, listenerAbsent: true };
  process.stdout.write(`${sealJson(output, evidence)}\n`);
}

main().catch(error => die(PREFIX, error));
