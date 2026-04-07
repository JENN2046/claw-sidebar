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

$nodeScript = @'
let Database;
try {
  Database = require("better-sqlite3");
} catch (_) {
  try {
    Database = require("A:/VCP/VCPToolBox/node_modules/better-sqlite3");
  } catch (e) {
    console.error("Cannot load better-sqlite3. Install dependencies in VCPToolBox first.");
    process.exit(2);
  }
}

const db = new Database(process.argv[2], { readonly: true });
const row = db
  .prepare("SELECT settings_config FROM providers WHERE app_type='claude' AND is_current=1 LIMIT 1")
  .get();

if (!row) {
  console.error("No current Claude provider found in cc-switch.db.");
  process.exit(3);
}

let cfg = {};
try {
  cfg = JSON.parse(row.settings_config || "{}");
} catch (_) {}

process.stdout.write(JSON.stringify(cfg.env || {}));
'@

$dbPath = Join-Path $ccSwitchDir "cc-switch.db"
$envJson = $nodeScript | node - $dbPath
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
