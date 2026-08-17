# Windows Update detects updates but will not download them

Analysis of the troubleshooting report dated 17 August 2026.
Machine: Windows 11, build 10.0.26200.7623 (25H2), ASUS hardware, Wi-Fi.
Symptom: updates are detected; every one shows *"We'll try to download this
update once you're connected to the internet."*

---

## Summary

The twelve steps already completed have conclusively ruled out the things they
test — component store corruption, system file corruption, update cache
corruption, and a WinHTTP proxy. None of them test the thing that actually
produces this message, so the symptom is unchanged.

**Windows Update does not decide whether it is online the way a browser does.**
It asks two OS components:

1. the **Network List Service / Network Location Awareness** (`NlaSvc` +
   `netprofm`) for the connectivity state of the active network profile, and
2. the **Network Cost Manager** for whether the link is metered.

If either answers unfavourably, the Update Orchestrator defers the download and
the UI prints exactly the sentence above. Chrome, WhatsApp Web, `ping` and
`curl` consult neither, which is why they all work perfectly while Windows
Update sits still. Everything in the report that established "the internet
works" is true and does not bear on the fault.

One finding in the report is genuinely anomalous and reframes the whole
investigation. It is discussed in *The finding that matters* below.

---

## Why the testing done so far cannot see the fault

These are not criticisms of the work — they are the reason twelve correct
procedures produced no change.

| Test performed | What it actually proves | What it cannot see |
| --- | --- | --- |
| `ping www.microsoft.com` succeeds | ICMP reaches one Microsoft host | Nothing about the update CDN, which is different hostnames on different networks |
| Chrome / WhatsApp Web work | User-mode apps can reach the internet | Nothing — browsers never consult NCSI or the network cost manager |
| `nslookup <host>` and `nslookup <host> 8.8.8.8` | What a given DNS server answers | **`nslookup` does not read the hosts file**, and it queries the named server directly instead of going through the OS resolver. A hosts-file block, or a different answer on the real resolution path, is invisible to it |
| `curl http://www.msftconnecttest.com/connecttest.txt` returns the right text | The endpoint is reachable *from a user process* | Not that `NlaSvc`'s own probe succeeded. NlaSvc probes from a service context and caches its verdict in the network profile |
| `net start bits` / BITS found stopped again | BITS was started | Nothing. **BITS is trigger-started and stops itself after ~90 seconds idle. Finding it stopped is normal Windows behaviour, not a fault** |
| Deleting `qmgr*.dat` | The BITS queue is empty | On Windows 11 the update payload is fetched by **Delivery Optimization (`DoSvc`)**, not BITS. The BITS queue is largely irrelevant to this symptom |
| `sfc /scannow`, `DISM /RestoreHealth` clean | No file or component store corruption | Correct, and it means these should not be run again. This is a configuration fault, not corruption |
| `netsh winhttp show proxy` = direct | No WinHTTP proxy | Not whether traffic is intercepted transparently on the wire, which needs no client proxy setting at all |

The report's own "Current Situation" list treats "Windows Update service, BITS,
Cryptographic Services, NLA all started" as verification. Started is not the
same as correctly configured, and for BITS and `wuauserv` running is not even
the expected state.

---

## The finding that matters

> `sc query nlasvc` showed `STATE : 1 STOPPED`, `WIN32_EXIT_CODE : 1077`, and
> it had to be fixed with `sc config nlasvc start= auto`.

Windows ships **NlaSvc as Automatic**. Exit code 1077 means "no attempt to
start the service has been made since the last boot" — consistent with a
startup type of Manual or Disabled. Windows does not change this itself, and no
Windows update sets it to Manual.

**Something on this machine altered service startup configuration.** The usual
candidates, in rough order of likelihood on a consumer ASUS machine:

- an "update blocker" / debloat / privacy utility (Windows Update Blocker,
  O&O ShutUp10, WinUtil, Sophia Script and similar),
- an OEM or gaming "network optimiser" (ASUS Armoury Crate, GameFirst,
  Killer/Rivet Control Center, cFosSpeed),
- third-party security software,
- a well-meant "speed up Windows" registry script.

This matters because those tools do not change one service. They change a
consistent set:

| What they change | Effect on this symptom |
| --- | --- |
| `NlaSvc` → Manual/Disabled | **Windows reports "no internet"** → updates defer. *Already observed on this machine.* |
| `DoSvc` (Delivery Optimization) → Disabled | Windows 11 has no working download transport |
| `UsoSvc` (Update Orchestrator) → Disabled | Nothing schedules or drives the download |
| `WaaSMedicSvc` → Disabled | Windows cannot self-repair the above |
| `DefaultMediaCost\WiFi` → `2` | **Every Wi-Fi network is metered machine-wide** → auto-download suppressed |
| `\Microsoft\Windows\UpdateOrchestrator\*` tasks disabled | The orchestrator never runs |
| Policy keys under `...\Policies\Microsoft\Windows\WindowsUpdate` | Downloads blocked by policy |
| hosts-file entries for `*.windowsupdate.com` | All update traffic blackholed, **and invisible to `nslookup`** |

NlaSvc was the one that happened to get noticed. The rest of that list has not
been checked. That is the gap.

---

## Ranked hypotheses

### 1. Windows classifies the network as "no internet" (NCSI / NLA) — most likely

This is the only hypothesis that explains the *literal wording* of the message
rather than merely being compatible with it. NlaSvc having been stopped is
direct supporting evidence.

**One-line test:**

```powershell
Get-NetConnectionProfile
```

`IPv4Connectivity` must read `Internet`. If it reads `LocalNetwork`,
`NoTraffic` or `Unknown`, that is the answer, and no amount of SFC, DISM or
cache resetting will change it.

**Confirm visually:** the network icon in the system tray. A globe, or a
warning triangle/exclamation over the Wi-Fi bars, while browsing works, is this
fault exactly.

Causes to check next, in order: the NCSI probe registry values under
`HKLM\SYSTEM\CurrentControlSet\Services\NlaSvc\Parameters\Internet` (redirected
probe host/content is a classic debloat leftover), `netprofm` and `nsi` service
state, and whether a Group Policy key exists at
`HKLM\SOFTWARE\Policies\Microsoft\Windows\NetworkConnectivityStatusIndicator`.

### 2. The connection is metered

The second mechanism that produces "we'll download later" on a healthy link.
Three separate places can set it:

- `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\NetworkList\DefaultMediaCost`
  → `WiFi` or `Ethernet` or `Default` set to `2`. Windows does not write these
  values for Wi-Fi/Ethernet; blocker tools do. This makes **every** network
  metered and survives forgetting and re-joining the Wi-Fi network.
- Settings → Network & internet → Wi-Fi → *(network)* → **Metered connection**.
- Settings → Network & internet → **Data usage** → a data limit that has been
  reached.

A fast confirmation that costs nothing: set
`HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AllowAutoWindowsUpdateDownloadOverMeteredNetwork`
to `1`. If downloads start, metering was the cause.

### 3. Delivery Optimization is disabled or misconfigured

On Windows 11 `DoSvc` fetches the payload. If it is Disabled, or if
`DODownloadMode` is `100` ("bypass" — a mode **removed in Windows 11**, which
leaves the client with no transport), downloads never begin while scanning
continues to work normally. That split — scan works, download does not — is
precisely the reported symptom.

### 4. Policy / WSUS / MDM / pause

The report's own recommended next step. Worth checking, but on an unmanaged
consumer machine it ranks below the above. `UseWUServer=1` pointing at a WSUS
server that does not exist, `DoNotConnectToWindowsUpdateInternetLocations=1`,
or an active pause window under `HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings`
would all do it.

### 5. Network-level interception — the `10.149.1.116` result

This is the most interesting observation in the report and it deserves a
careful reading.

`download.windowsupdate.com` resolved to `10.149.1.116` via **both** the router
(`192.168.2.1`) **and** `8.8.8.8`. Google's public resolver does not return
RFC1918 addresses. Getting the same private address from both means **something
between this PC and the internet is intercepting DNS on port 53 and answering
on its own behalf** — the query never reached Google.

Two plausible explanations, both consistent with the evidence:

- **ISP-side update cache steering.** Some ISPs run a Microsoft Connected Cache
  and steer `*.windowsupdate.com` to a local node on `10.x`. Legitimate, and
  transparent when it works. When the node is unreachable from the customer's
  subnet or is down, the result is: everything browses fine, Windows Update
  downloads fail. Fits perfectly.
- **Router-level DNS forcing.** Many routers, ASUS included ("DNS Director",
  formerly DNSFilter), redirect all LAN port-53 traffic to themselves, which
  would explain `8.8.8.8` returning the router's answer.

Why changing the client to Cloudflare did not fix it: the interception is on
the wire, not in the client configuration. Changing which server you *ask* does
not help if something rewrites the answer in transit — and `1.1.1.1` may have
escaped only because Windows 11 auto-upgrades it to encrypted DNS (DoH), which
the interceptor cannot rewrite. Even with correct DNS, the same device may
still be filtering the traffic itself at IP or TLS level.

**This hypothesis is cheap to test and should be tested first** — see below.

---

## What to do next, in order

### Step 1 — the decisive test (5 minutes)

**Tether the PC to a phone hotspot on mobile data** (not the same Wi-Fi) and
retry Windows Update.

- **Downloads work on the hotspot** → the fault is the network, router or ISP.
  Hypothesis 5. Stop touching the PC; investigate the router's DNS/filtering
  settings and contact the ISP about `download.windowsupdate.com` resolving to
  `10.149.1.116`.
- **Downloads still fail on the hotspot** → the fault is on the PC.
  Hypotheses 1–4. Continue below.

No test in the report so far separates these two possibilities, and almost all
of the remaining work depends on the answer. It should have been step one.

### Step 2 — one command that reads the machine's own verdict

```powershell
Get-NetConnectionProfile
```

If `IPv4Connectivity` is anything other than `Internet`, hypothesis 1 is
confirmed and that is where all remaining effort should go.

### Step 3 — read the actual error codes

Twelve troubleshooting steps were performed and **not one of them looked at an
error code.** Windows records exactly why the download did not start:

```powershell
Get-WinEvent -LogName Microsoft-Windows-WindowsUpdateClient/Operational -MaxEvents 30 |
    Format-List TimeCreated, Id, Message

Get-WinEvent -LogName Microsoft-Windows-DeliveryOptimization/Operational -MaxEvents 30

# And the full merged log:
Get-WindowsUpdateLog
```

An HRESULT here replaces all guesswork. `0x8024002E` means access is disabled
by policy; `0x80D05001` means Delivery Optimization cannot reach its cloud
service; `0x80072F8F` means a TLS/clock failure; `0x8024402C` means the client
is pointed at an update server it cannot reach.

### Step 4 — run the automated diagnostic

`tools/windows-update/Diagnose-WindowsUpdate.ps1` in this repository performs
every check above in one pass and prints a ranked findings list. See *Using the
scripts* below.

---

## Using the scripts

Both scripts are Windows PowerShell 5.1 compatible and must be run from an
**elevated** prompt (right-click Start → Terminal (Admin)).

```powershell
cd tools\windows-update

# Read-only. Changes nothing. Writes a full report to the desktop.
powershell -ExecutionPolicy Bypass -File .\Diagnose-WindowsUpdate.ps1
```

`Diagnose-WindowsUpdate.ps1` checks: network profile classification, the NCSI
probe configuration *and* a live replication of the probe Windows itself
performs, metered/media-cost state, Windows Update and Delivery Optimization
policy, WSUS and MDM enrolment, startup types for sixteen services against
Windows defaults, Update Orchestrator scheduled tasks, the hosts file, DNS
answers **through the real OS resolver** plus TCP reachability for ten update
endpoints, the TLS certificate issuer on two of them (which detects an
interception appliance), proxy configuration, third-party security and
filtering software, non-Microsoft network filter drivers, firewall block rules,
clock skew against Microsoft's servers, and the last seven days of the Windows
Update, Delivery Optimization and BITS operational event logs with HRESULT
decoding.

```powershell
# Preview every change without making any.
powershell -ExecutionPolicy Bypass -File .\Repair-WindowsUpdate.ps1 -All -WhatIf

# Apply.
powershell -ExecutionPolicy Bypass -File .\Repair-WindowsUpdate.ps1 -All
```

`Repair-WindowsUpdate.ps1` restores NCSI probing, clears metered state
(including taking ownership of the `DefaultMediaCost` key if it has been
tampered with), restores Windows-default service startup types, re-enables the
Update Orchestrator scheduled tasks, strips update-blocking hosts entries, and
removes WSUS/pause/blocking policy values. Individual switches (`-FixNcsi`,
`-FixMetered`, `-FixServices`, `-FixTasks`, `-FixHosts`, `-RemovePolicy`) let
you apply one change at a time.

Everything it touches is exported to a timestamped backup folder on the desktop
first, with a generated `Undo.cmd` alongside it.

**Two cautions.** Do not use `-RemovePolicy` on a machine managed by an
employer, domain or MDM without asking whoever administers it — those values may
be deliberate, and Group Policy will re-apply them anyway. And `-ResetCaches` is
deliberately excluded from `-All`, because `SoftwareDistribution` and `catroot2`
have already been reset on this machine; repeating it will not help.

---

## Things not to spend more time on

Based on the results already obtained:

- **`sfc /scannow` and `DISM /RestoreHealth`.** Both came back clean. This is a
  configuration fault, not corruption. Running them again is guaranteed to
  change nothing.
- **Resetting `SoftwareDistribution` and `catroot2` again.** Already done
  successfully. A second reset tests the same hypothesis that was already
  falsified.
- **Chasing BITS.** It is trigger-started; stopping when idle is correct
  behaviour, and on Windows 11 it is not the primary download transport anyway.
- **Further `ping` / `nslookup` connectivity testing.** Connectivity in the
  general sense is established. The open questions are what the OS resolver
  returns on the real path, and what Windows *believes* about the connection —
  neither of which these tools can answer.
