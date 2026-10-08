#Requires -Version 5.1
<#
.SYNOPSIS
  Wink relay deployment: provision, update, move or pause the relay VM.

.DESCRIPTION
  Dry run unless -Apply is passed: the plan is printed and nothing changes.
  Needs Node 24+ and gcloud on PATH. With -Dns namecom (default) DNS
  credentials come from the NAMECOM_USER and NAMECOM_TOKEN environment
  variables, never arguments. -Dns manual needs no credentials.

.EXAMPLE
  .\wink-relay.ps1 provision -Project my-proj -Base wink.example.com -DnsZone example.com -OperatorKey C:\keys\operator.key -AcceptAcmeTerms

.EXAMPLE
  .\wink-relay.ps1 move -FromProject old-proj -Project new-proj -Base wink.example.com -DnsZone example.com -OperatorKey C:\keys\operator.key -AcceptAcmeTerms -Apply
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('provision', 'update', 'move', 'pause')]
  [string]$Action,
  [Parameter(Mandatory = $true)][string]$Project,
  [Parameter(Mandatory = $true)][string]$Base,
  [Parameter(Mandatory = $true)][string]$DnsZone,
  [string]$FromProject,
  [string]$Region = 'asia-northeast3',
  [string]$Zone,
  [ValidateSet('STANDARD', 'PREMIUM')][string]$NetworkTier = 'STANDARD',
  [string]$Machine = 'e2-small',
  [string]$Prefix = 'wink-relay',
  [string]$AddressName,
  [ValidateSet('namecom', 'manual')][string]$Dns = 'namecom',
  [string]$OperatorKey,
  [string]$AcmeDirectory,
  [string]$AcmeEmail,
  [switch]$AcceptAcmeTerms,
  [switch]$Offline,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node 24 or later is required on PATH.' }
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 24) { throw "Node 24 or later is required (found $major)." }
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw 'gcloud is required on PATH.' }

$cliArgs = @($Action, '--project', $Project, '--base', $Base, '--dns-zone', $DnsZone,
  '--region', $Region, '--network-tier', $NetworkTier, '--machine', $Machine, '--prefix', $Prefix, '--dns', $Dns)
if ($AddressName) { $cliArgs += @('--address-name', $AddressName) }
if ($Zone) { $cliArgs += @('--zone', $Zone) }
if ($FromProject) { $cliArgs += @('--from-project', $FromProject) }
if ($OperatorKey) { $cliArgs += @('--operator-key', (Resolve-Path -LiteralPath $OperatorKey).Path) }
if ($AcmeDirectory) { $cliArgs += @('--acme-directory', $AcmeDirectory) }
if ($AcmeEmail) { $cliArgs += @('--acme-email', $AcmeEmail) }
if ($AcceptAcmeTerms) { $cliArgs += '--accept-acme-terms' }
if ($Offline) { $cliArgs += '--offline' }
if ($Apply) { $cliArgs += '--apply' }

& node (Join-Path $PSScriptRoot 'cli.ts') @cliArgs
exit $LASTEXITCODE
