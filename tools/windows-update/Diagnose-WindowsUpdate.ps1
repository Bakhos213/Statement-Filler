#Requires -Version 5.1
<#
.SYNOPSIS
    Read-only diagnostic for "Windows Update detects updates but will not download them".

.DESCRIPTION
    Collects the evidence that actually decides this symptom, in priority order:

      1. How Windows classifies the network (NCSI / Network Location Awareness).
         The Update Orchestrator defers downloads when it believes the connection
         is unusable or metered - regardless of whether browsing works.
      2. Whether the connection is marked metered (per-profile or machine-wide
         via DefaultMediaCost).
      3. Whether policy, MDM, WSUS or a pause window is suppressing downloads.
      4. Whether Windows Update's service stack has been tampered with (start
         types and scheduled tasks compared against Windows 11 defaults).
      5. Whether the update CDN is actually reachable - DNS answers, TCP, and
         the TLS certificate issuer (which detects interception appliances).
      6. The real error codes, from the Windows Update / Delivery Optimization
         / BITS operational event logs.

    Nothing is modified. Run Repair-WindowsUpdate.ps1 afterwards to act on the
    findings.

.PARAMETER OutputPath
    Directory for the transcript and report. Defaults to the desktop.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Diagnose-WindowsUpdate.ps1

.NOTES
    Run from an elevated PowerShell prompt. Some checks (event logs, service
    configuration, NetworkList) return nothing useful without administrator
    rights, and the script will say so rather than reporting a false "OK".
#>

[CmdletBinding()]
param(
    [string] $OutputPath = [Environment]::GetFolderPath('Desktop')
)

# Deliberately no Set-StrictMode: this script must survive missing properties on
# a damaged system and still print the rest of the report.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# Findings collector
# ---------------------------------------------------------------------------

$script:Findings = New-Object System.Collections.ArrayList

function Add-Finding {
    param(
        [ValidateSet('CRITICAL', 'WARN', 'INFO', 'OK')]
        [string] $Severity,
        [string] $Area,
        [string] $Message,
        [string] $Action = ''
    )
    $null = $script:Findings.Add([pscustomobject]@{
        Severity = $Severity
        Area     = $Area
        Message  = $Message
        Action   = $Action
    })
}

function Write-Section {
    param([string] $Title)
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkCyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor DarkCyan
}

function Write-Item {
    param([string] $Label, $Value, [string] $Colour = 'Gray')
    if ($null -eq $Value -or "$Value" -eq '') { $Value = '(not set)' }
    Write-Host ('  {0,-46}' -f $Label) -NoNewline
    Write-Host $Value -ForegroundColor $Colour
}

function Get-RegValue {
    param([string] $Path, [string] $Name)
    try {
        $key = Get-Item -LiteralPath $Path -ErrorAction Stop
        $v = $key.GetValue($Name, $null)
        return $v
    } catch {
        return $null
    }
}

function Test-IsAdmin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $p = New-Object Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Test-PrivateIPv4 {
    param([string] $Address)
    if ($Address -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { return $false }
    $o = $Address.Split('.') | ForEach-Object { [int] $_ }
    if ($o[0] -eq 10) { return $true }
    if ($o[0] -eq 127) { return $true }
    if ($o[0] -eq 0) { return $true }
    if ($o[0] -eq 192 -and $o[1] -eq 168) { return $true }
    if ($o[0] -eq 172 -and $o[1] -ge 16 -and $o[1] -le 31) { return $true }
    if ($o[0] -eq 169 -and $o[1] -eq 254) { return $true }
    if ($o[0] -eq 100 -and $o[1] -ge 64 -and $o[1] -le 127) { return $true }   # CGNAT
    return $false
}

function Test-TcpPort {
    param([string] $ComputerName, [int] $Port, [int] $TimeoutMs = 4000)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($ComputerName, $Port, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if ($ok -and $client.Connected) {
            $client.EndConnect($async)
            return $true
        }
        return $false
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# ---------------------------------------------------------------------------

$isAdmin = Test-IsAdmin
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not (Test-Path -LiteralPath $OutputPath)) {
    $OutputPath = $env:TEMP
}
$reportFile = Join-Path $OutputPath ("WindowsUpdate-Diagnostics-$stamp.txt")

try { Start-Transcript -Path $reportFile -Force | Out-Null } catch { }

Write-Host ''
Write-Host '  Windows Update download diagnostic' -ForegroundColor White
Write-Host "  Report: $reportFile" -ForegroundColor DarkGray

if (-not $isAdmin) {
    Write-Host ''
    Write-Host '  NOT RUNNING AS ADMINISTRATOR - several checks will be incomplete.' -ForegroundColor Yellow
    Add-Finding 'WARN' 'Setup' 'Script was not run elevated; service, event log and policy checks may be incomplete.' 'Re-run from an elevated PowerShell prompt.'
}

# ---------------------------------------------------------------------------
Write-Section '1. System'
# ---------------------------------------------------------------------------

try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
    Write-Item 'Product'            $os.Caption
    Write-Item 'Build'              ("{0} (UBR {1})" -f $os.Version, (Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' 'UBR'))
    Write-Item 'Display version'    (Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' 'DisplayVersion')
    Write-Item 'Installed'          $os.InstallDate
    Write-Item 'Last boot'          $os.LastBootUpTime
    Write-Item 'Manufacturer/Model' ("{0} / {1}" -f $cs.Manufacturer, $cs.Model)
    Write-Item 'Part of domain'     $cs.PartOfDomain
    if ($cs.PartOfDomain) {
        Write-Item 'Domain' $cs.Domain
        Add-Finding 'WARN' 'Management' "Device is joined to domain '$($cs.Domain)'. Update behaviour may be centrally controlled." 'Confirm with whoever administers the domain before changing update policy.'
    }
} catch {
    Write-Host "  Could not read system information: $($_.Exception.Message)" -ForegroundColor Red
}

# Clock skew breaks TLS to the update CDN and is silent in the UI.
try {
    $utcNow = (Get-Date).ToUniversalTime()
    Write-Item 'Local time'  (Get-Date)
    Write-Item 'UTC time'    $utcNow
    Write-Item 'Time zone'   (Get-TimeZone -ErrorAction SilentlyContinue).Id
    $hdr = $null
    try {
        $req = [Net.HttpWebRequest]::Create('http://www.msftconnecttest.com/connecttest.txt')
        $req.Method = 'HEAD'
        $req.Timeout = 8000
        $resp = $req.GetResponse()
        $hdr = $resp.Headers['Date']
        $resp.Close()
    } catch { }
    if ($hdr) {
        $serverUtc = ([datetime]$hdr).ToUniversalTime()
        $skew = [Math]::Abs(($utcNow - $serverUtc).TotalMinutes)
        Write-Item 'Clock skew vs Microsoft (minutes)' ([Math]::Round($skew, 1))
        if ($skew -gt 5) {
            Add-Finding 'CRITICAL' 'Clock' ("System clock is off by {0:N1} minutes versus Microsoft's servers. TLS to the update CDN will fail." -f $skew) 'Enable automatic time and time zone, then run: w32tm /resync /force'
        }
    }
} catch { }

# ---------------------------------------------------------------------------
Write-Section '2. Network classification (NCSI / NLA)  <-- primary suspect'
# ---------------------------------------------------------------------------
# Windows Update does not ask "can I ping Microsoft". It asks the Network List
# Service whether the active profile has internet connectivity, and asks the
# Network Cost Manager whether the link is metered. Browsers ignore both.

try {
    $profiles = Get-NetConnectionProfile -ErrorAction Stop
    foreach ($p in $profiles) {
        Write-Host ''
        Write-Item 'Interface'          $p.InterfaceAlias
        Write-Item 'Network name'       $p.Name
        Write-Item 'Category'           $p.NetworkCategory
        Write-Item 'IPv4 connectivity'  $p.IPv4Connectivity ('Green', 'Red')[[int]($p.IPv4Connectivity -ne 'Internet')]
        Write-Item 'IPv6 connectivity'  $p.IPv6Connectivity

        if ($p.IPv4Connectivity -ne 'Internet' -and $p.IPv6Connectivity -ne 'Internet') {
            Add-Finding 'CRITICAL' 'NCSI' "Windows classifies '$($p.Name)' as '$($p.IPv4Connectivity)', not 'Internet'. The Update Orchestrator will refuse to download while this is true - this is exactly the 'we'll try once you're connected' message." 'See section 2b/2c: fix NCSI probing or the network profile. This is the single most likely cause.'
        }
    }
    if (($profiles | Where-Object { $_.IPv4Connectivity -eq 'Internet' -or $_.IPv6Connectivity -eq 'Internet' }).Count -eq 0) {
        Add-Finding 'CRITICAL' 'NCSI' 'No network profile reports internet connectivity.' 'Windows Update, the Store and Defender updates will all stall until this is corrected.'
    }
} catch {
    Write-Host "  Get-NetConnectionProfile failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ''
Write-Host '  -- NCSI probe configuration --' -ForegroundColor DarkGray
$ncsiPath = 'HKLM:\SYSTEM\CurrentControlSet\Services\NlaSvc\Parameters\Internet'
$ncsiDefaults = @{
    'EnableActiveProbing'         = 1
    'ActiveWebProbeHost'          = 'www.msftconnecttest.com'
    'ActiveWebProbePath'          = 'connecttest.txt'
    'ActiveWebProbeContent'       = 'Microsoft Connect Test'
    'ActiveDnsProbeHost'          = 'dns.msftncsi.com'
    'ActiveDnsProbeContent'       = '131.107.255.255'
    'ActiveWebProbeHostV6'        = 'ipv6.msftconnecttest.com'
    'ActiveDnsProbeHostV6'        = 'dns.msftncsi.com'
    'ActiveDnsProbeContentV6'     = 'fd3e:4f5a:5b81::1'
}
foreach ($name in ($ncsiDefaults.Keys | Sort-Object)) {
    $actual = Get-RegValue $ncsiPath $name
    $expected = $ncsiDefaults[$name]
    $colour = 'Gray'
    if ($null -ne $actual -and "$actual" -ne "$expected") {
        $colour = 'Yellow'
        Add-Finding 'WARN' 'NCSI' "NCSI probe setting '$name' is '$actual' (Windows default is '$expected'). A redirected probe makes Windows think it is offline." 'Reset to the default value, or delete the value so Windows uses its built-in default.'
    }
    Write-Item $name $actual $colour
}
if ((Get-RegValue $ncsiPath 'EnableActiveProbing') -eq 0) {
    Add-Finding 'CRITICAL' 'NCSI' 'Active probing is disabled (EnableActiveProbing = 0). Windows cannot confirm internet access and will report "no internet".' 'Set EnableActiveProbing to 1 and restart NlaSvc.'
}
$ncsiPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\NetworkConnectivityStatusIndicator'
if (Test-Path -LiteralPath $ncsiPolicy) {
    Write-Host '  NCSI Group Policy overrides present:' -ForegroundColor Yellow
    try {
        (Get-Item -LiteralPath $ncsiPolicy).GetValueNames() | ForEach-Object {
            Write-Item "  policy: $_" (Get-RegValue $ncsiPolicy $_) 'Yellow'
        }
        Add-Finding 'WARN' 'NCSI' 'Group Policy is overriding NCSI connectivity checks.' "Review HKLM\SOFTWARE\Policies\Microsoft\Windows\NetworkConnectivityStatusIndicator"
    } catch { }
}

Write-Host ''
Write-Host '  -- Live NCSI probe replication --' -ForegroundColor DarkGray
# Reproduce exactly what NlaSvc does. A captive portal or filtering appliance
# returns HTTP 200 with the wrong body, which nslookup and a browser will
# never reveal.
try {
    $req = [Net.HttpWebRequest]::Create('http://www.msftconnecttest.com/connecttest.txt')
    $req.Timeout = 8000
    $req.AllowAutoRedirect = $false
    $req.UserAgent = 'Microsoft NCSI'
    $resp = $req.GetResponse()
    $code = [int] $resp.StatusCode
    $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    $resp.Close()
    Write-Item 'HTTP probe status' $code
    Write-Item 'HTTP probe body'   ("'" + $body.Trim() + "'")
    if ($code -ne 200) {
        Add-Finding 'CRITICAL' 'NCSI' "NCSI web probe returned HTTP $code instead of 200 - a redirect means a captive portal or filtering proxy is in the path." 'Identify and bypass the intercepting device or software.'
    } elseif ($body.Trim() -ne 'Microsoft Connect Test') {
        Add-Finding 'CRITICAL' 'NCSI' "NCSI web probe returned the wrong body ('$($body.Trim())'). Something is rewriting HTTP responses." 'Identify the intercepting proxy, filter or DNS appliance.'
    } else {
        Write-Host '  Web probe OK.' -ForegroundColor Green
    }
} catch {
    Write-Item 'HTTP probe' "FAILED: $($_.Exception.Message)" 'Red'
    Add-Finding 'CRITICAL' 'NCSI' "NCSI web probe failed: $($_.Exception.Message)" 'Windows will report no internet access until this probe succeeds.'
}

try {
    $dnsProbe = Resolve-DnsName -Name 'dns.msftncsi.com' -Type A -ErrorAction Stop |
                Where-Object { $_.QueryType -eq 'A' } | Select-Object -First 1
    Write-Item 'DNS probe (dns.msftncsi.com)' $dnsProbe.IPAddress
    if ($dnsProbe.IPAddress -ne '131.107.255.255') {
        Add-Finding 'CRITICAL' 'NCSI' "NCSI DNS probe returned $($dnsProbe.IPAddress) instead of 131.107.255.255. DNS is being intercepted." 'Windows treats this as "no internet" no matter how well browsing works.'
    } else {
        Write-Host '  DNS probe OK.' -ForegroundColor Green
    }
} catch {
    Write-Item 'DNS probe' "FAILED: $($_.Exception.Message)" 'Red'
}

# ---------------------------------------------------------------------------
Write-Section '3. Metered connection'
# ---------------------------------------------------------------------------
# A metered link is the second way to produce "we'll download later" with a
# perfectly healthy internet connection.

$mediaCostPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\NetworkList\DefaultMediaCost'
$costNames = @{ 1 = 'Unrestricted'; 2 = 'Fixed / METERED'; 4 = 'Variable / METERED' }
foreach ($media in @('Default', 'Ethernet', 'WiFi', '3G', '4G')) {
    $v = Get-RegValue $mediaCostPath $media
    $label = '(unreadable - needs admin)'
    $colour = 'Gray'
    if ($null -ne $v) {
        $label = "$v"
        if ($costNames.ContainsKey([int]$v)) { $label = "$v = $($costNames[[int]$v])" }
        if ([int]$v -ne 1 -and $media -in @('Ethernet', 'WiFi', 'Default')) {
            $colour = 'Red'
            Add-Finding 'CRITICAL' 'Metered' "DefaultMediaCost\$media = $v (metered). Every $media connection is treated as metered machine-wide, so Windows Update will not auto-download." 'This value is not set by Windows for Ethernet/WiFi - it is set by "update blocker" and debloat tools. Reset it to 1.'
        }
    }
    Write-Item "DefaultMediaCost\$media" $label $colour
}

# Per-profile metered flag as seen by the modern networking stack.
try {
    $null = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]
    $conn = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
    if ($conn) {
        $cost = $conn.GetConnectionCost()
        Write-Item 'Connection cost type'       $cost.NetworkCostType
        Write-Item 'Approaching data limit'     $cost.ApproachingDataLimit
        Write-Item 'Over data limit'            $cost.OverDataLimit
        Write-Item 'Roaming'                    $cost.Roaming
        if ("$($cost.NetworkCostType)" -ne 'Unrestricted') {
            Add-Finding 'CRITICAL' 'Metered' "The active connection reports cost type '$($cost.NetworkCostType)'. Windows Update defers downloads on metered links." 'Settings > Network & internet > Wi-Fi > (network) > Metered connection = Off.'
        }
        if ($cost.OverDataLimit -or $cost.ApproachingDataLimit) {
            Add-Finding 'CRITICAL' 'Metered' 'The connection is flagged as at/over its data limit. Downloads are suppressed.' 'Settings > Network & internet > Data usage - remove the data limit for this network.'
        }
    }
} catch {
    Write-Host '  (WinRT connection-cost API unavailable in this host; rely on the registry values above.)' -ForegroundColor DarkGray
}

$meteredPolicy = Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' 'AllowAutoWindowsUpdateDownloadOverMeteredNetwork'
Write-Item 'AllowAutoWUDownloadOverMetered (policy)' $meteredPolicy

# ---------------------------------------------------------------------------
Write-Section '4. Windows Update policy / WSUS / MDM'
# ---------------------------------------------------------------------------

$policyPaths = @(
    'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate',
    'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU',
    'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update',
    'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings',
    'HKLM:\SOFTWARE\Microsoft\PolicyManager\current\device\Update'
)

$blockingValues = @{
    'UseWUServer'                                  = 'Points the client at a WSUS server instead of Microsoft.'
    'DoNotConnectToWindowsUpdateInternetLocations' = 'Explicitly forbids contacting Microsoft Update on the internet.'
    'DisableWindowsUpdateAccess'                   = 'Disables user access to Windows Update.'
    'NoAutoUpdate'                                 = 'Automatic updating is turned off.'
    'DeferQualityUpdatesPeriodInDays'              = 'Quality updates are deferred.'
    'DeferFeatureUpdatesPeriodInDays'              = 'Feature updates are deferred.'
    'PauseQualityUpdates'                          = 'Quality updates are paused.'
    'PauseFeatureUpdates'                          = 'Feature updates are paused.'
    'TargetReleaseVersion'                         = 'Client is pinned to a specific Windows release.'
    'SetPolicyDrivenUpdateSourceForQualityUpdates' = 'Update source for quality updates is policy-controlled.'
    'SetPolicyDrivenUpdateSourceForFeatureUpdates' = 'Update source for feature updates is policy-controlled.'
    'SetPolicyDrivenUpdateSourceForDriverUpdates'  = 'Update source for drivers is policy-controlled.'
    'SetPolicyDrivenUpdateSourceForOtherUpdates'   = 'Update source for other updates is policy-controlled.'
    'DisableDualScan'                              = 'Dual-scan behaviour is being overridden.'
    'ExcludeWUDriversInQualityUpdate'              = 'Driver updates are excluded from quality updates.'
    'PausedQualityStatus'                          = 'Quality updates are currently in a paused state.'
    'PausedFeatureStatus'                          = 'Feature updates are currently in a paused state.'
    'PauseUpdatesExpiryTime'                       = 'An update pause window is set.'
}

$foundPolicy = $false
foreach ($path in $policyPaths) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    Write-Host ''
    Write-Host "  $path" -ForegroundColor White
    try {
        $key = Get-Item -LiteralPath $path -ErrorAction Stop
        $names = $key.GetValueNames()
        if ($names.Count -eq 0) {
            Write-Host '    (key exists but has no values)' -ForegroundColor DarkGray
            continue
        }
        foreach ($n in ($names | Sort-Object)) {
            $val = $key.GetValue($n)
            $colour = 'Gray'
            if ($blockingValues.ContainsKey($n)) {
                $isSet = $true
                if ($val -is [int] -and [int]$val -eq 0) { $isSet = $false }
                if ($isSet) {
                    $foundPolicy = $true
                    $colour = 'Red'
                    Add-Finding 'CRITICAL' 'Policy' "$n = $val at $path - $($blockingValues[$n])" 'Remove this value unless it is intentionally managed by your organisation.'
                }
            }
            Write-Item "    $n" $val $colour
        }
    } catch {
        Write-Host "    Could not read: $($_.Exception.Message)" -ForegroundColor Red
    }
}
if (-not $foundPolicy) {
    Write-Host ''
    Write-Host '  No blocking Windows Update policy values detected.' -ForegroundColor Green
    Add-Finding 'OK' 'Policy' 'No WSUS / "do not connect to internet locations" / pause policy is set.' ''
}

# WSUS server addresses
foreach ($n in @('WUServer', 'WUStatusServer', 'UpdateServiceUrlAlternate')) {
    $v = Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' $n
    if ($v) {
        Write-Item $n $v 'Red'
        Add-Finding 'CRITICAL' 'Policy' "$n is set to '$v'. The client is trying to download from this server, not from Microsoft." 'Remove the WSUS configuration if this machine is not meant to be managed.'
    }
}

# MDM enrolment
Write-Host ''
try {
    $enrolments = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Enrollments' -ErrorAction SilentlyContinue |
        Where-Object { $_.GetValue('EnrollmentState', 0) -eq 1 -and $_.GetValue('ProviderID', '') -ne '' }
    if ($enrolments) {
        foreach ($e in $enrolments) {
            Write-Item 'MDM enrolment' ("{0} / {1}" -f $e.GetValue('ProviderID'), $e.GetValue('UPN')) 'Yellow'
        }
        Add-Finding 'WARN' 'Management' 'The device is enrolled in MDM. Update policy may be pushed from Intune or another MDM.' 'Check with whoever manages the device before altering update settings.'
    } else {
        Write-Item 'MDM enrolment' 'none'
    }
} catch { }

try {
    $dsreg = & dsregcmd.exe /status 2>$null
    if ($dsreg) {
        foreach ($line in $dsreg) {
            if ($line -match 'AzureAdJoined|DomainJoined|WorkplaceJoined|TenantName') {
                Write-Host "  $($line.Trim())" -ForegroundColor DarkGray
            }
        }
    }
} catch { }

# ---------------------------------------------------------------------------
Write-Section '5. Service stack integrity'
# ---------------------------------------------------------------------------
# The report noted NlaSvc was not set to Automatic. That is not a Windows
# default, so something changed it. If one service was tampered with, the rest
# of the update stack must be audited too.

$expected = [ordered]@{
    'wuauserv'      = @{ Name = 'Windows Update';                    Start = @('Manual', 'Auto') }
    'bits'          = @{ Name = 'Background Intelligent Transfer';   Start = @('Manual', 'Auto') }
    'DoSvc'         = @{ Name = 'Delivery Optimization';             Start = @('Auto') }
    'UsoSvc'        = @{ Name = 'Update Orchestrator';               Start = @('Auto') }
    'WaaSMedicSvc'  = @{ Name = 'Windows Update Medic';              Start = @('Manual') }
    'cryptsvc'      = @{ Name = 'Cryptographic Services';            Start = @('Auto') }
    'NlaSvc'        = @{ Name = 'Network Location Awareness';        Start = @('Auto') }
    'netprofm'      = @{ Name = 'Network List Service';              Start = @('Manual') }
    'nsi'           = @{ Name = 'Network Store Interface';           Start = @('Auto') }
    'Dhcp'          = @{ Name = 'DHCP Client';                       Start = @('Auto') }
    'Dnscache'      = @{ Name = 'DNS Client';                        Start = @('Auto') }
    'NcaSvc'        = @{ Name = 'Network Connectivity Assistant';    Start = @('Manual') }
    'WlanSvc'       = @{ Name = 'WLAN AutoConfig';                   Start = @('Auto') }
    'TrustedInstaller' = @{ Name = 'Windows Modules Installer';      Start = @('Manual') }
    'AppIDSvc'      = @{ Name = 'Application Identity';              Start = @('Manual') }
    'gpsvc'         = @{ Name = 'Group Policy Client';               Start = @('Auto') }
}

Write-Host ''
Write-Host ('  {0,-18} {1,-34} {2,-10} {3,-10}' -f 'SERVICE', 'DISPLAY', 'STATE', 'STARTUP') -ForegroundColor White
Write-Host ('  ' + '-' * 74) -ForegroundColor DarkGray

foreach ($svcName in $expected.Keys) {
    $meta = $expected[$svcName]
    $svc = $null
    try { $svc = Get-CimInstance Win32_Service -Filter "Name='$svcName'" -ErrorAction Stop } catch { }
    if (-not $svc) {
        Write-Host ('  {0,-18} {1,-34} {2,-10} {3,-10}' -f $svcName, $meta.Name, 'MISSING', '-') -ForegroundColor Red
        Add-Finding 'CRITICAL' 'Services' "Service '$svcName' ($($meta.Name)) does not exist on this system." 'The service was deleted. Windows Update cannot work without it.'
        continue
    }

    # Win32_Service.StartMode returns Boot / System / Auto / Manual / Disabled.
    $startMode = $svc.StartMode

    $colour = 'Gray'
    if ($startMode -eq 'Disabled') {
        $colour = 'Red'
        Add-Finding 'CRITICAL' 'Services' "$svcName ($($meta.Name)) is DISABLED." 'Windows never disables this service. Re-enable it - see Repair-WindowsUpdate.ps1.'
    } elseif ($meta.Start -notcontains $startMode) {
        $colour = 'Yellow'
        Add-Finding 'WARN' 'Services' "$svcName ($($meta.Name)) startup is '$startMode'; Windows default is '$($meta.Start -join ' or ')'." 'Restore the default startup type.'
    }

    Write-Host ('  {0,-18} {1,-34} {2,-10} {3,-10}' -f $svcName, $meta.Name, $svc.State, $startMode) -ForegroundColor $colour
}

Write-Host ''
Write-Host '  Note: BITS and wuauserv are trigger-started. Finding them Stopped while idle is NORMAL' -ForegroundColor DarkGray
Write-Host '        and is not evidence of a fault.' -ForegroundColor DarkGray

# Scheduled tasks the orchestrator depends on
Write-Host ''
Write-Host '  -- Update scheduled tasks --' -ForegroundColor DarkGray
try {
    $tasks = Get-ScheduledTask -ErrorAction Stop |
        Where-Object { $_.TaskPath -like '\Microsoft\Windows\UpdateOrchestrator\*' -or
                       $_.TaskPath -like '\Microsoft\Windows\WindowsUpdate\*' -or
                       $_.TaskPath -like '\Microsoft\Windows\InstallService\*' }
    if (-not $tasks) {
        Add-Finding 'CRITICAL' 'Tasks' 'No UpdateOrchestrator / WindowsUpdate scheduled tasks found - they appear to have been deleted.' 'Update blocker tools delete these. They are difficult to restore without an in-place repair install.'
    }
    foreach ($t in $tasks) {
        $colour = 'Gray'
        if ($t.State -eq 'Disabled') {
            $colour = 'Red'
            Add-Finding 'WARN' 'Tasks' "Scheduled task '$($t.TaskPath)$($t.TaskName)' is disabled." 'Re-enable it so the Update Orchestrator can run.'
        }
        Write-Host ('    {0,-12} {1}{2}' -f $t.State, $t.TaskPath, $t.TaskName) -ForegroundColor $colour
    }
} catch {
    Write-Host "    Could not enumerate scheduled tasks: $($_.Exception.Message)" -ForegroundColor Red
}

# ---------------------------------------------------------------------------
Write-Section '6. Delivery Optimization'
# ---------------------------------------------------------------------------
# On Windows 11 the payload is fetched by Delivery Optimization, not by BITS.
# Chasing BITS while DoSvc is broken finds nothing.

$doMode = Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization' 'DODownloadMode'
if ($null -eq $doMode) {
    $doMode = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\DeliveryOptimization\Settings' 'DownloadMode'
}
Write-Item 'DODownloadMode' $doMode
if ($null -ne $doMode -and [int]$doMode -eq 100) {
    Add-Finding 'CRITICAL' 'DeliveryOptimization' 'DODownloadMode = 100 ("bypass"). This mode was removed in Windows 11 and leaves downloads with no working transport.' 'Delete the DODownloadMode policy value, or set it to 1 (LAN) / 0 (HTTP only).'
}

try {
    $doStatus = Get-DeliveryOptimizationStatus -ErrorAction Stop
    if ($doStatus) {
        $doStatus | Select-Object FileId, FileSize, TotalBytesDownloaded, Status, DownloadMode, BytesFromHttp |
            Format-Table -AutoSize | Out-String | Write-Host
    } else {
        Write-Host '  No active Delivery Optimization jobs.' -ForegroundColor DarkGray
    }
} catch {
    Write-Host "  Get-DeliveryOptimizationStatus unavailable: $($_.Exception.Message)" -ForegroundColor DarkGray
}

try {
    # Property names differ across builds, so print the whole snapshot.
    Get-DeliveryOptimizationPerfSnap -ErrorAction Stop | Format-List | Out-String | Write-Host
} catch {
    Write-Host "  Get-DeliveryOptimizationPerfSnap unavailable: $($_.Exception.Message)" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
Write-Section '7. Update endpoint reachability'
# ---------------------------------------------------------------------------
# nslookup does NOT consult the hosts file, so every nslookup test so far is
# blind to a hosts-file block. Resolve-DnsName -DnsOnly is likewise. We check
# the hosts file separately, then test what the OS actually resolves and
# whether TCP and TLS complete.

Write-Host ''
Write-Host '  -- hosts file --' -ForegroundColor DarkGray
$hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
try {
    $hostsLines = Get-Content -LiteralPath $hostsFile -ErrorAction Stop |
        Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*#' }
    $badHosts = $hostsLines | Where-Object {
        $_ -match 'microsoft|windowsupdate|msftncsi|msftconnecttest|delivery\.mp|update|msedge|dsp\.mp'
    }
    if ($badHosts) {
        foreach ($l in $badHosts) { Write-Host "    $l" -ForegroundColor Red }
        Add-Finding 'CRITICAL' 'DNS' "The hosts file contains $($badHosts.Count) entry/entries for Microsoft update domains. These override all DNS and are invisible to nslookup." 'Remove those lines from C:\Windows\System32\drivers\etc\hosts.'
    } elseif ($hostsLines) {
        Write-Host "    $($hostsLines.Count) active entry/entries, none matching Microsoft update domains." -ForegroundColor Green
    } else {
        Write-Host '    Empty (default).' -ForegroundColor Green
    }
} catch {
    Write-Host "    Could not read hosts file: $($_.Exception.Message)" -ForegroundColor Red
}

$endpoints = @(
    @{ Host = 'download.windowsupdate.com';           Port = 80  },
    @{ Host = 'au.download.windowsupdate.com';        Port = 443 },
    @{ Host = 'ctldl.windowsupdate.com';              Port = 80  },
    @{ Host = 'fe3cr.delivery.mp.microsoft.com';      Port = 443 },
    @{ Host = 'tlu.dl.delivery.mp.microsoft.com';     Port = 443 },
    @{ Host = 'dl.delivery.mp.microsoft.com';         Port = 443 },
    @{ Host = 'geo.prod.do.dsp.mp.microsoft.com';     Port = 443 },
    @{ Host = 'slscr.update.microsoft.com';           Port = 443 },
    @{ Host = 'emdl.ws.microsoft.com';                Port = 443 },
    @{ Host = 'settings-win.data.microsoft.com';      Port = 443 }
)

Write-Host ''
Write-Host ('  {0,-40} {1,-18} {2,-8} {3}' -f 'HOSTNAME', 'RESOLVES TO', 'TCP', 'NOTE') -ForegroundColor White
Write-Host ('  ' + '-' * 90) -ForegroundColor DarkGray

foreach ($ep in $endpoints) {
    $ips = @()
    $note = ''
    $colour = 'Gray'
    try {
        # GetHostAddresses uses the full OS resolution path, including hosts.
        $ips = [Net.Dns]::GetHostAddresses($ep.Host) |
               Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
               ForEach-Object { $_.IPAddressToString }
    } catch {
        $note = 'DNS FAILED'
        $colour = 'Red'
    }

    $first = '-'
    if ($ips.Count -gt 0) { $first = $ips[0] }

    if ($ips.Count -gt 0 -and (Test-PrivateIPv4 $ips[0])) {
        $colour = 'Red'
        $note = 'PRIVATE/HIJACKED ADDRESS'
        Add-Finding 'CRITICAL' 'DNS' "$($ep.Host) resolves to $($ips[0]), a private/non-routable address. Something on the network is redirecting Microsoft update traffic." 'This is DNS interception by the router, ISP or a filtering appliance. Test on a phone hotspot to confirm.'
    }

    $tcp = '-'
    if ($ips.Count -gt 0) {
        if (Test-TcpPort -ComputerName $ips[0] -Port $ep.Port) {
            $tcp = "OK:$($ep.Port)"
        } else {
            $tcp = "BLOCKED:$($ep.Port)"
            $colour = 'Red'
            if (-not $note) { $note = 'TCP connect failed' }
            Add-Finding 'CRITICAL' 'Connectivity' "Cannot open TCP $($ep.Port) to $($ep.Host) ($($ips[0]))." 'The update payload cannot be fetched. Check firewall, router filtering and security software.'
        }
    }

    Write-Host ('  {0,-40} {1,-18} {2,-8} {3}' -f $ep.Host, $first, $tcp, $note) -ForegroundColor $colour
}

# TLS certificate issuer - detects an interception appliance rewriting HTTPS.
Write-Host ''
Write-Host '  -- TLS inspection check --' -ForegroundColor DarkGray
foreach ($tlsHost in @('fe3cr.delivery.mp.microsoft.com', 'slscr.update.microsoft.com')) {
    try {
        $tcpClient = New-Object System.Net.Sockets.TcpClient($tlsHost, 443)
        $ssl = New-Object System.Net.Security.SslStream($tcpClient.GetStream(), $false, { $true })
        $ssl.AuthenticateAsClient($tlsHost)
        $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
        $issuer = $cert.Issuer
        $ssl.Dispose(); $tcpClient.Close()

        $trusted = $issuer -match 'Microsoft|DigiCert|Akamai|Verizon|Baltimore|Entrust|GlobalSign'
        $colour = 'Green'
        if (-not $trusted) { $colour = 'Red' }
        Write-Item $tlsHost $issuer $colour
        if (-not $trusted) {
            Add-Finding 'CRITICAL' 'TLS' "$tlsHost presents a certificate issued by '$issuer', not a Microsoft/CDN CA. HTTPS is being intercepted." 'A security product, router or appliance is doing TLS inspection and Windows Update rejects it. Exempt Microsoft update domains or remove the interceptor.'
        }
    } catch {
        Write-Item $tlsHost "TLS handshake FAILED: $($_.Exception.Message)" 'Red'
        Add-Finding 'CRITICAL' 'TLS' "TLS handshake to $tlsHost failed: $($_.Exception.Message)" 'Windows Update cannot establish a secure channel to this endpoint.'
    }
}

# ---------------------------------------------------------------------------
Write-Section '8. Proxy configuration'
# ---------------------------------------------------------------------------

Write-Host '  -- WinHTTP (used by Windows Update) --' -ForegroundColor DarkGray
& netsh winhttp show proxy | ForEach-Object { if ($_.Trim()) { Write-Host "    $_" } }

Write-Host ''
Write-Host '  -- WinINET (per-user, used by browsers) --' -ForegroundColor DarkGray
$inet = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
foreach ($n in @('ProxyEnable', 'ProxyServer', 'AutoConfigURL', 'ProxyOverride')) {
    $v = Get-RegValue $inet $n
    Write-Item "    $n" $v
    if ($n -eq 'AutoConfigURL' -and $v) {
        Add-Finding 'WARN' 'Proxy' "A proxy auto-config script is set for the user ($v). It does not affect WinHTTP, but it can mask a network that is otherwise filtered." 'Confirm whether this PAC file is expected.'
    }
}

# ---------------------------------------------------------------------------
Write-Section '9. Third-party security / filtering software'
# ---------------------------------------------------------------------------

try {
    $av = Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop
    foreach ($a in $av) {
        Write-Item 'Antivirus' $a.displayName
        if ($a.displayName -notmatch 'Windows Defender|Microsoft Defender') {
            Add-Finding 'WARN' 'Security software' "Third-party antivirus present: $($a.displayName). Web-shield / firewall components commonly block the update CDN." 'Temporarily disable its web protection and firewall, then retry Windows Update.'
        }
    }
} catch { Write-Host '  (SecurityCenter2 unavailable)' -ForegroundColor DarkGray }

try {
    $fw = Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName FirewallProduct -ErrorAction SilentlyContinue
    foreach ($f in $fw) { Write-Item 'Firewall product' $f.displayName }
} catch { }

Write-Host ''
Write-Host '  -- Installed software of interest --' -ForegroundColor DarkGray
$suspectPattern = 'VPN|Proxy|AdGuard|Pi-hole|DNS|Firewall|Norton|McAfee|Avast|AVG|Kaspersky|Bitdefender|ESET|Malwarebytes|Trend Micro|Sophos|Webroot|Comodo|GlassWire|NetLimiter|Update Blocker|ShutUp|Spybot|O&O|Armoury|AiProtection|Killer|Rivet|cFosSpeed|SmartByte|Dell Optimizer'
$uninstallPaths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$seen = @{}
foreach ($up in $uninstallPaths) {
    try {
        Get-ItemProperty $up -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -and $_.DisplayName -match $suspectPattern } |
            ForEach-Object {
                if (-not $seen.ContainsKey($_.DisplayName)) {
                    $seen[$_.DisplayName] = $true
                    Write-Host "    $($_.DisplayName)" -ForegroundColor Yellow
                }
            }
    } catch { }
}
if ($seen.Count -eq 0) {
    Write-Host '    Nothing matching known VPN / filtering / tweaking software.' -ForegroundColor Green
} else {
    Add-Finding 'WARN' 'Security software' "Software that can filter or redirect network traffic is installed: $($seen.Keys -join ', ')." 'Uninstall or fully disable these, reboot, and retry. "Bandwidth optimiser" utilities on ASUS/Killer network stacks are a frequent cause.'
}

Write-Host ''
Write-Host '  -- Non-Microsoft network filter drivers (LSPs / NDIS filters) --' -ForegroundColor DarkGray
try {
    Get-NetAdapterBinding -ErrorAction Stop |
        Where-Object { $_.Enabled -and $_.ComponentID -notmatch '^ms_' } |
        Select-Object -Unique DisplayName, ComponentID |
        ForEach-Object {
            Write-Host "    $($_.DisplayName)  [$($_.ComponentID)]" -ForegroundColor Yellow
            Add-Finding 'WARN' 'Network stack' "Non-Microsoft network filter bound to the adapter: $($_.DisplayName) [$($_.ComponentID)]." 'These can silently drop or reshape traffic. Disable to test.'
        }
} catch { }

# Firewall rules that block update binaries
Write-Host ''
Write-Host '  -- Block rules touching update components --' -ForegroundColor DarkGray
try {
    $blockRules = Get-NetFirewallRule -Action Block -Enabled True -ErrorAction Stop
    $hits = 0
    foreach ($r in $blockRules) {
        $af = $null
        try { $af = $r | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue } catch { }
        $prog = ''
        if ($af) { $prog = "$($af.Program)" }
        if ($r.DisplayName -match 'update|wuau|svchost|delivery|BITS' -or $prog -match 'wuauclt|MoUsoCoreWorker|usoclient|svchost|DeliveryOptimization') {
            $hits++
            Write-Host "    BLOCK: $($r.DisplayName)  ->  $prog" -ForegroundColor Red
            Add-Finding 'CRITICAL' 'Firewall' "An enabled outbound/inbound BLOCK rule targets update components: '$($r.DisplayName)' ($prog)." 'Disable or delete this rule.'
        }
    }
    if ($hits -eq 0) { Write-Host '    None found.' -ForegroundColor Green }
} catch {
    Write-Host "    Could not enumerate firewall rules: $($_.Exception.Message)" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
Write-Section '10. Event logs - the actual error codes'
# ---------------------------------------------------------------------------

$hresults = @{
    '0x80240438' = 'No connection to the update service (proxy/WSUS unreachable).'
    '0x8024402C' = 'Cannot reach the configured update server - usually a stale WSUS/proxy setting.'
    '0x8024002E' = 'Access to Windows Update is disabled by policy.'
    '0x8024500C' = 'Scan failed - conflicting MDM/WSUS policy (dual scan).'
    '0x80072EE2' = 'Connection timed out reaching the update service.'
    '0x80072EFD' = 'Could not connect to the server.'
    '0x80072EE7' = 'Server name could not be resolved (DNS).'
    '0x80072F8F' = 'Security/TLS failure - almost always a wrong system clock or an intercepting certificate.'
    '0x80244022' = 'HTTP 503 from the update server.'
    '0x80D02002' = 'Delivery Optimization timed out downloading.'
    '0x80D05001' = 'Delivery Optimization could not contact its cloud service.'
    '0x80D03002' = 'Delivery Optimization download failed.'
    '0x800705B4' = 'Operation timed out.'
    '0x80070005' = 'Access denied.'
    '0x80246007' = 'The update was not downloaded.'
    '0x80246008' = 'Download failed because BITS could not transfer the file.'
}

$logs = @(
    'Microsoft-Windows-WindowsUpdateClient/Operational',
    'Microsoft-Windows-DeliveryOptimization/Operational',
    'Microsoft-Windows-Bits-Client/Operational',
    'Microsoft-Windows-NetworkProfile/Operational'
)

foreach ($log in $logs) {
    Write-Host ''
    Write-Host "  -- $log --" -ForegroundColor DarkGray
    try {
        $events = Get-WinEvent -FilterHashtable @{ LogName = $log; Level = 1, 2, 3; StartTime = (Get-Date).AddDays(-7) } -MaxEvents 25 -ErrorAction Stop
        if (-not $events) {
            Write-Host '    No warnings or errors in the last 7 days.' -ForegroundColor Green
            continue
        }
        foreach ($e in $events) {
            $msg = ($e.Message -replace '\s+', ' ')
            if ($msg.Length -gt 190) { $msg = $msg.Substring(0, 190) + '...' }
            Write-Host ("    [{0}] id={1} {2}" -f $e.TimeCreated, $e.Id, $msg) -ForegroundColor Yellow

            foreach ($code in $hresults.Keys) {
                if ($e.Message -match [regex]::Escape($code)) {
                    Add-Finding 'CRITICAL' 'Event log' "$code in $log - $($hresults[$code])" "Seen at $($e.TimeCreated)."
                }
            }
            # Catch codes we do not have text for. Normalise as 0x + uppercase
            # hex so it matches the key format above (the 'x' stays lowercase).
            $m = [regex]::Match($e.Message, '0x[0-9A-Fa-f]{8}')
            $norm = ''
            if ($m.Success) { $norm = '0x' + $m.Value.Substring(2).ToUpper() }
            if ($m.Success -and -not $hresults.ContainsKey($norm)) {
                Add-Finding 'INFO' 'Event log' "Error code $($m.Value) recorded in $log at $($e.TimeCreated)." 'Look this code up if the findings above do not explain the failure.'
            }
        }
    } catch {
        Write-Host "    Unavailable: $($_.Exception.Message)" -ForegroundColor DarkGray
    }
}

# ---------------------------------------------------------------------------
Write-Section '11. Pending update state'
# ---------------------------------------------------------------------------

try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    Write-Item 'Search service' $searcher.ServerSelection
    $hist = $searcher.GetTotalHistoryCount()
    Write-Item 'History entries' $hist
    if ($hist -gt 0) {
        $recent = $searcher.QueryHistory(0, [Math]::Min(10, $hist))
        Write-Host ''
        foreach ($h in $recent) {
            $res = switch ($h.ResultCode) { 1 { 'InProgress' } 2 { 'Succeeded' } 3 { 'SucceededWithErrors' } 4 { 'FAILED' } 5 { 'Aborted' } default { "Code$($h.ResultCode)" } }
            $colour = 'Gray'
            if ($h.ResultCode -ge 3) { $colour = 'Red' }
            $hr = '0x{0:X8}' -f $h.HResult
            Write-Host ("    {0,-20} {1,-20} {2}  {3}" -f $h.Date, $res, $hr, $h.Title) -ForegroundColor $colour
            if ($h.ResultCode -ge 3 -and $hresults.ContainsKey($hr)) {
                Add-Finding 'CRITICAL' 'Update history' "$hr on '$($h.Title)' - $($hresults[$hr])" ''
            }
        }
    }
} catch {
    Write-Host "  Could not query the update agent: $($_.Exception.Message)" -ForegroundColor Red
}

# ---------------------------------------------------------------------------
Write-Section 'FINDINGS'
# ---------------------------------------------------------------------------

$order = @{ 'CRITICAL' = 0; 'WARN' = 1; 'INFO' = 2; 'OK' = 3 }
$sorted = $script:Findings | Sort-Object { $order[$_.Severity] }

if (-not $sorted -or $sorted.Count -eq 0) {
    Write-Host '  No findings recorded.' -ForegroundColor Green
} else {
    $n = 0
    foreach ($f in $sorted) {
        $n++
        $colour = switch ($f.Severity) {
            'CRITICAL' { 'Red' }
            'WARN'     { 'Yellow' }
            'INFO'     { 'Gray' }
            default    { 'Green' }
        }
        Write-Host ''
        Write-Host ("  {0}. [{1}] {2}" -f $n, $f.Severity, $f.Area) -ForegroundColor $colour
        Write-Host ("     $($f.Message)")
        if ($f.Action) { Write-Host ("     -> $($f.Action)") -ForegroundColor DarkGray }
    }
}

$criticalCount = ($script:Findings | Where-Object { $_.Severity -eq 'CRITICAL' }).Count

Write-Host ''
Write-Host ('=' * 78) -ForegroundColor DarkCyan
Write-Host "  $criticalCount critical finding(s). Full report saved to:" -ForegroundColor White
Write-Host "  $reportFile" -ForegroundColor White
Write-Host ''
Write-Host '  DECISIVE NEXT TEST if nothing above is conclusive:' -ForegroundColor White
Write-Host '  Tether the PC to a phone hotspot (mobile data, not the same Wi-Fi) and retry' -ForegroundColor Gray
Write-Host '  Windows Update. If it downloads there, the fault is the network/router/ISP,' -ForegroundColor Gray
Write-Host '  not this PC, and no amount of SFC/DISM/service resetting will fix it.' -ForegroundColor Gray
Write-Host ('=' * 78) -ForegroundColor DarkCyan

try { Stop-Transcript | Out-Null } catch { }
