#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(new URL("../", import.meta.url).pathname);
const allowedIntents = new Set([
  "gateway-existing",
  "migrate-create-or-existing",
  "provision-existing",
  "test-create-or-existing"
]);

function filesUnder(path) {
  const result = [];
  for (const name of readdirSync(path)) {
    if (name === "dist" || name === "node_modules") continue;
    const candidate = join(path, name);
    const state = statSync(candidate);
    if (state.isDirectory()) result.push(...filesUnder(candidate));
    else if (/\.(?:[cm]?[jt]s|sh)$/u.test(name)) result.push(candidate);
  }
  return result;
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function intentFrom(expression) {
  const object = unwrap(expression);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name.getText().replaceAll(/["']/gu, "");
    if (name !== "intent") continue;
    const value = unwrap(property.initializer);
    return ts.isStringLiteral(value) ? value.text : undefined;
  }
  return undefined;
}

const sourceFiles = [
  ...filesUnder(join(root, "apps/gateway/src")),
  ...filesUnder(join(root, "apps/gateway/test"))
];
const failures = [];
let calls = 0;
for (const path of sourceFiles) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "openGatewayDatabase"
    ) {
      calls += 1;
      const intent = node.arguments[1] && intentFrom(node.arguments[1]);
      const appRequest = relative(root, path) === "apps/gateway/src/app.ts"
        && node.arguments[1]?.getText(source) === "options.databaseOpenRequest";
      if ((!intent || !allowedIntents.has(intent)) && !appRequest) {
        failures.push(`${relative(root, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}:MISSING_INTENT`);
      } else if (
        !path.includes("/test/")
        && intent === "test-create-or-existing"
      ) {
        failures.push(`${relative(root, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}:TEST_INTENT_IN_PRODUCTION`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const checkerPath = join(root, "scripts/check-database-open-intents.mjs");
for (const path of filesUnder(join(root, "scripts"))) {
  if (path === checkerPath) continue;
  const source = readFileSync(path, "utf8");
  if (/\bopenGatewayDatabase\s*\(/u.test(source)) {
    failures.push(`${relative(root, path)}:DIRECT_DATABASE_OPEN`);
  }
  if (/\btest-create-or-existing\b/u.test(source)) {
    failures.push(`${relative(root, path)}:TEST_DATABASE_INTENT`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`DATABASE_OPEN_INTENTS_INVALID\n${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`DATABASE_OPEN_INTENTS_OK files=${sourceFiles.length} calls=${calls}\n`);
