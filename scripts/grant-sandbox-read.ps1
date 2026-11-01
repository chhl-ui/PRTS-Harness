<#
.SYNOPSIS
  Grant read access on given directories to PRTS's AppContainer profile.

.DESCRIPTION
  AppContainer read isolation only lets the container reach the workspace and the
  --read-path list. A pwsh *inside* the container cannot start programs under
  C:\Program Files\... because CreateProcess checks the image against the CALLING
  side's token: the host can read it, the container's restricted token cannot.
  Symptom: inside the container `where.exe node` finds nothing and a direct call
  reports "not recognized".

  Running this once, as administrator, makes node/git usable from the sandboxed shell.

  Deriving the SID needs no elevation (DeriveAppContainerSidFromAppContainerName is
  read-only). Changing the DACL on Program Files does. So when not elevated the
  script only prints the SID and the commands to run, and exits 2 -- it does not fail.

.PARAMETER ProfileName
  AppContainer profile name. Default matches src/sandbox/provider.ts.

.PARAMETER Paths
  Directories to grant. Default: node and git install locations.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\grant-sandbox-read.ps1

.EXAMPLE
  # from an elevated PowerShell
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\grant-sandbox-read.ps1
#>
param(
  [string]$ProfileName = 'PRTS.Sandbox',
  [string[]]$Paths = @('C:\Program Files\nodejs', 'C:\Program Files\Git')
)

$ErrorActionPreference = 'Stop'

if (-not ('Win32.AppContainerSid' -as [type])) {
  Add-Type -Namespace Win32 -Name AppContainerSid -MemberDefinition @'
[DllImport("userenv.dll", CharSet = CharSet.Unicode)]
public static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
public static extern bool ConvertSidToStringSid(IntPtr sid, out string str);
[DllImport("kernel32.dll")]
public static extern IntPtr LocalFree(IntPtr h);
'@
}

$sidPtr = [IntPtr]::Zero
$hr = [Win32.AppContainerSid]::DeriveAppContainerSidFromAppContainerName($ProfileName, [ref]$sidPtr)
if ($hr -ne 0 -or $sidPtr -eq [IntPtr]::Zero) {
  Write-Error "Cannot derive AppContainer SID (hr=$hr). Profile '$ProfileName' may not exist yet - run PRTS once so ensureProfile creates it."
  exit 1
}

$sid = $null
if (-not [Win32.AppContainerSid]::ConvertSidToStringSid($sidPtr, [ref]$sid)) {
  Write-Error 'ConvertSidToStringSid failed'
  exit 1
}
[void][Win32.AppContainerSid]::LocalFree($sidPtr)

Write-Host "AppContainer profile : $ProfileName"
Write-Host "SID                  : $sid"
Write-Host ''

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host 'Not elevated: printing the commands only, no changes made.' -ForegroundColor Yellow
  Write-Host 'Re-run this script from an elevated PowerShell, or run manually:'
  Write-Host ''
  foreach ($p in $Paths) {
    Write-Host "  icacls `"${p}`" /grant `"*${sid}:(OI)(CI)(RX)`""
  }
  exit 2
}

foreach ($p in $Paths) {
  if (-not (Test-Path -LiteralPath $p)) {
    Write-Warning "Skipping (path does not exist): $p"
    continue
  }
  Write-Host "Granting read on $p ..."
  & icacls.exe $p /grant "*${sid}:(OI)(CI)(RX)" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Error "icacls failed (exit $LASTEXITCODE): $p"
    exit 1
  }
  Write-Host '  ok'
}

Write-Host ''
Write-Host 'Done. Verify from inside the sandbox (prts chat, let the model run):'
Write-Host '  where.exe node'
Write-Host '  node --version'
