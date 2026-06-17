import assert from "node:assert/strict";
import test from "node:test";
import { loadGitHubAppConfig } from "./github-app-config.js";

test("empty env disables GitHub App config", () => {
  assert.deepEqual(loadGitHubAppConfig({}), { status: "disabled" });
});

test("standalone webhook secret stays disabled for App auth", () => {
  assert.deepEqual(
    loadGitHubAppConfig({
      SYNAPSE_GITHUB_WEBHOOK_SECRET: "webhook-secret"
    }),
    { status: "disabled", webhookSecret: "webhook-secret" }
  );
});

test("complete env configures GitHub App and normalizes private key newlines", () => {
  const result = loadGitHubAppConfig({
    SYNAPSE_GITHUB_APP_ID: "12345",
    SYNAPSE_GITHUB_APP_CLIENT_ID: "Iv1.fakeclient",
    SYNAPSE_GITHUB_APP_CLIENT_SECRET: "fake-client-secret",
    SYNAPSE_GITHUB_APP_PRIVATE_KEY: "-----BEGIN\\nKEY\\n-----END",
    SYNAPSE_GITHUB_WEBHOOK_SECRET: "webhook-secret"
  });

  if (result.status !== "configured") {
    assert.fail(`expected configured, got ${result.status}`);
  }

  assert.equal(result.webhookSecret, "webhook-secret");
  assert.deepEqual(result.config, {
    appId: "12345",
    clientId: "Iv1.fakeclient",
    clientSecret: "fake-client-secret",
    privateKey: "-----BEGIN\nKEY\n-----END",
    webhookSecret: "webhook-secret"
  });
});

test("partial App env reports only missing variable names", () => {
  const result = loadGitHubAppConfig({
    SYNAPSE_GITHUB_APP_ID: "12345",
    SYNAPSE_GITHUB_APP_CLIENT_SECRET: "fake-client-secret"
  });

  if (result.status !== "incomplete") {
    assert.fail(`expected incomplete, got ${result.status}`);
  }

  assert.deepEqual(result.missing, [
    "SYNAPSE_GITHUB_APP_CLIENT_ID",
    "SYNAPSE_GITHUB_APP_PRIVATE_KEY",
    "SYNAPSE_GITHUB_WEBHOOK_SECRET"
  ]);
  assert.ok(!result.missing.includes("fake-client-secret"));
});

test("blank strings are treated as missing", () => {
  const blankOnly = loadGitHubAppConfig({
    SYNAPSE_GITHUB_APP_ID: "  ",
    SYNAPSE_GITHUB_WEBHOOK_SECRET: "\t"
  });
  assert.deepEqual(blankOnly, { status: "disabled" });

  const partial = loadGitHubAppConfig({
    SYNAPSE_GITHUB_APP_ID: "  ",
    SYNAPSE_GITHUB_APP_CLIENT_ID: "Iv1.fakeclient",
    SYNAPSE_GITHUB_APP_CLIENT_SECRET: "",
    SYNAPSE_GITHUB_APP_PRIVATE_KEY: "-----BEGIN\\nKEY\\n-----END",
    SYNAPSE_GITHUB_WEBHOOK_SECRET: "\n"
  });

  if (partial.status !== "incomplete") {
    assert.fail(`expected incomplete, got ${partial.status}`);
  }

  assert.deepEqual(partial.missing, [
    "SYNAPSE_GITHUB_APP_ID",
    "SYNAPSE_GITHUB_APP_CLIENT_SECRET",
    "SYNAPSE_GITHUB_WEBHOOK_SECRET"
  ]);
});
