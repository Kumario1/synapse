export interface GitHubAppConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
}

export type GitHubAppConfigResult =
  | { status: "disabled"; webhookSecret?: string }
  | { status: "configured"; config: GitHubAppConfig; webhookSecret: string }
  | { status: "incomplete"; missing: string[]; webhookSecret?: string };

const APP_ENV_NAMES = [
  "SYNAPSE_GITHUB_APP_ID",
  "SYNAPSE_GITHUB_APP_CLIENT_ID",
  "SYNAPSE_GITHUB_APP_CLIENT_SECRET",
  "SYNAPSE_GITHUB_APP_PRIVATE_KEY"
] as const;

const REQUIRED_ENV_NAMES = [...APP_ENV_NAMES, "SYNAPSE_GITHUB_WEBHOOK_SECRET"] as const;

type RequiredEnvName = (typeof REQUIRED_ENV_NAMES)[number];

export function loadGitHubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfigResult {
  const webhookSecret = envValue(env, "SYNAPSE_GITHUB_WEBHOOK_SECRET");
  const hasAppEnv = APP_ENV_NAMES.some((name) => envValue(env, name));

  if (!hasAppEnv) {
    return webhookSecret ? { status: "disabled", webhookSecret } : { status: "disabled" };
  }

  const missing = REQUIRED_ENV_NAMES.filter((name) => !envValue(env, name));
  if (missing.length > 0) {
    return webhookSecret
      ? { status: "incomplete", missing, webhookSecret }
      : { status: "incomplete", missing };
  }

  const appId = envValue(env, "SYNAPSE_GITHUB_APP_ID")!;
  const clientId = envValue(env, "SYNAPSE_GITHUB_APP_CLIENT_ID")!;
  const clientSecret = envValue(env, "SYNAPSE_GITHUB_APP_CLIENT_SECRET")!;
  const privateKey = envValue(env, "SYNAPSE_GITHUB_APP_PRIVATE_KEY")!.replace(/\\n/g, "\n");

  return {
    status: "configured",
    webhookSecret: webhookSecret!,
    config: {
      appId,
      clientId,
      clientSecret,
      privateKey,
      webhookSecret: webhookSecret!
    }
  };
}

function envValue(env: NodeJS.ProcessEnv, name: RequiredEnvName): string | undefined {
  const value = env[name];
  return value && value.trim() ? value : undefined;
}
