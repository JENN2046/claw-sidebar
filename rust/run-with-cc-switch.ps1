param(
    [string]$Prompt = "Reply with OK only",
    [string]$Model = "",
    [int]$MaxOutputTokens = 4096,
    [switch]$Repl
)

$ErrorActionPreference = "Stop"

$clawPath = Join-Path $PSScriptRoot "target\\debug\\claw.exe"
if (!(Test-Path $clawPath)) {
    throw "claw executable not found: $clawPath"
}

$ccSwitchDir = Join-Path $env:USERPROFILE ".cc-switch"
if (!(Test-Path $ccSwitchDir)) {
    throw "CC switch config directory not found: $ccSwitchDir"
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "Node.js is required to read the CC switch database. Install Node.js 22+ and try again."
}

$nodeScript = @'
const query = "SELECT settings_config FROM providers WHERE app_type='claude' AND is_current=1 LIMIT 1";

function readWithNodeSqlite(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(query).get();
    return row ? row.settings_config : null;
  } finally {
    if (typeof db.close === "function") db.close();
  }
}

function readWithBetterSqlite3(dbPath) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(query).get();
    return row ? row.settings_config : null;
  } finally {
    db.close();
  }
}

const loaders = [
  { name: "node:sqlite", fn: readWithNodeSqlite },
  { name: "better-sqlite3", fn: readWithBetterSqlite3 }
];

const dbPath = process.argv[2];
let settingsConfig = null;
let readSucceeded = false;
const errors = [];

for (const loader of loaders) {
  try {
    settingsConfig = loader.fn(dbPath);
    readSucceeded = true;
    break;
  } catch (error) {
    errors.push(`${loader.name}: ${error.message}`);
  }
}

if (!readSucceeded) {
  console.error("Unable to read cc-switch.db.");
  console.error("Install Node.js 22+ so the built-in node:sqlite module is available, or install better-sqlite3.");
  console.error(errors.join("\n"));
  process.exit(2);
}

if (!settingsConfig) {
  console.error("No current Claude provider found in cc-switch.db.");
  process.exit(3);
}

let cfg = {};
try {
  cfg = JSON.parse(settingsConfig || "{}");
} catch (_) {}

process.stdout.write(JSON.stringify(cfg.env || {}));
'@

$dbPath = Join-Path $ccSwitchDir "cc-switch.db"
$env:NODE_NO_WARNINGS = "1"
$envJson = $nodeScript | & $nodeCommand.Source - $dbPath
$envMap = $envJson | ConvertFrom-Json

if (-not $envMap.ANTHROPIC_API_KEY -or -not $envMap.ANTHROPIC_BASE_URL) {
    throw "Current CC switch Claude provider is missing ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL."
}

$env:HOME = $env:USERPROFILE
$env:ANTHROPIC_API_KEY = $envMap.ANTHROPIC_API_KEY
$env:ANTHROPIC_BASE_URL = $envMap.ANTHROPIC_BASE_URL

if ($envMap.ANTHROPIC_MODEL) { $env:ANTHROPIC_MODEL = $envMap.ANTHROPIC_MODEL }
if ($envMap.ANTHROPIC_DEFAULT_SONNET_MODEL) { $env:ANTHROPIC_DEFAULT_SONNET_MODEL = $envMap.ANTHROPIC_DEFAULT_SONNET_MODEL }
if ($envMap.ANTHROPIC_DEFAULT_HAIKU_MODEL) { $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $envMap.ANTHROPIC_DEFAULT_HAIKU_MODEL }
if ($envMap.ANTHROPIC_DEFAULT_OPUS_MODEL) { $env:ANTHROPIC_DEFAULT_OPUS_MODEL = $envMap.ANTHROPIC_DEFAULT_OPUS_MODEL }
$env:CLAW_MAX_OUTPUT_TOKENS = [string]$MaxOutputTokens
$env:CLAW_MINIMAL_SYSTEM_PROMPT = "1"

$activeModel = if ($Model) { $Model } elseif ($env:ANTHROPIC_MODEL) { $env:ANTHROPIC_MODEL } else { "claude-sonnet-4-6" }

if ($Repl) {
    & $clawPath --model $activeModel
} else {
    & $clawPath --model $activeModel --output-format text prompt $Prompt
}
