/* eslint-disable */
/**
 * postinstall — friendly hint only. Never writes to the user's filesystem.
 *
 * Some package managers (pnpm, bun) skip postinstall by default for untrusted
 * packages. Some users have CI environments where any console output looks
 * noisy. We therefore:
 *   1. Detect whether we are actually being installed into a *consumer*
 *      project (INIT_CWD set, and not equal to our own package dir).
 *   2. Print a short tip with the exact command to run, and exit 0.
 *   3. Never call fs.writeFile, never reach the network.
 */

const path = require("node:path");
const fs = require("node:fs");

function silent() {
  // Honor the universal opt-out used across the npm ecosystem.
  if (process.env.GBLIN_SKIP_HINT) return true;
  if (process.env.CI) return true; // never noise up CI logs
  if (process.env.npm_config_silent === "true") return true;
  return false;
}

function isConsumerInstall() {
  const initCwd = process.env.INIT_CWD;
  if (!initCwd) return false; // e.g. plain `npm i` inside our own repo
  const pkgRoot = path.resolve(__dirname, "..");
  if (path.resolve(initCwd) === pkgRoot) return false;
  // Make sure the consumer actually has a package.json — i.e. they are a
  // real project, not a temporary npx cache directory.
  try {
    return fs.existsSync(path.join(initCwd, "package.json"));
  } catch {
    return false;
  }
}

if (silent() || !isConsumerInstall()) {
  process.exit(0);
}

const lines = [
  "",
  "  \x1b[32m✓\x1b[0m @gblin-protocol/mcp-server installed",
  "",
  "  \x1b[2mTip:\x1b[0m drop the GBLIN treasury policy into this repo so",
  "  Claude Code, Cursor, Windsurf and Copilot auto-discover GBLIN:",
  "",
  "    \x1b[1mnpx -p @gblin-protocol/mcp-server gblin-init\x1b[0m",
  "",
  "  Docs: https://gblin.digital/agents",
  "  Opt out of this message: export GBLIN_SKIP_HINT=1",
  "",
];

// eslint-disable-next-line no-console
console.log(lines.join("\n"));
