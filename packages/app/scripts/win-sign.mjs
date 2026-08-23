#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const requiredEnvironment = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SIGNING_ENDPOINT",
  "AZURE_SIGNING_ACCOUNT",
  "AZURE_SIGNING_PROFILE",
];

const missingEnvironment = requiredEnvironment.filter(
  (name) => !process.env[name]?.trim(),
);

if (missingEnvironment.length > 0) {
  console.log(
    `Windows signing skipped; missing Azure Trusted Signing environment: ${missingEnvironment.join(", ")}`,
  );
  process.exit(0);
}

const [file] = process.argv.slice(2);
if (!file) {
  console.error("Windows signing failed: no file path was provided by Tauri.");
  process.exit(1);
}

const result = spawnSync(
  "trusted-signing-cli",
  [
    "--endpoint",
    process.env.AZURE_SIGNING_ENDPOINT,
    "--account",
    process.env.AZURE_SIGNING_ACCOUNT,
    "--certificate",
    process.env.AZURE_SIGNING_PROFILE,
    "--fd",
    "SHA256",
    "--tr",
    "http://timestamp.acs.microsoft.com",
    "--td",
    "SHA256",
    file,
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`Windows signing failed: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
