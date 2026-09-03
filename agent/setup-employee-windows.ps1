# 社員のWindows PC1台につき1回、これを実行してもらうだけでセットアップ完了する。
# ActivityWatch・Node.jsを自動インストールし、毎日23:50にログを共有フォルダへ書き出すタスクを登録する。
# wingetがあればそれを使い、無い環境(古いWindows・社内ポリシーでブロック等)では
# GitHub/nodejs.orgから直接ダウンロードしてインストールする。
# APIキー・Notion・Claudeとの通信は一切行わない。
#
# 使い方(PowerShellで): EMPLOYEE_NAME・ORG_ID を環境変数で渡して実行
#   $env:EMPLOYEE_NAME="tanaka"; $env:ORG_ID="<組織ID>"; powershell -ExecutionPolicy Bypass -File .\agent\setup-employee-windows.ps1
$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
$ProjectDir = Split-Path -Parent $ScriptDir

Write-Host "=== Windows操作ログ収集ツール セットアップ ==="

$WingetAvailable = [bool](Get-Command winget -ErrorAction SilentlyContinue)
if (-not $WingetAvailable) {
  Write-Host "wingetが見つかりません。GitHub/nodejs.orgから直接ダウンロードしてインストールします。"
}

# --- Node.js ---

function Install-NodeJsDirect {
  Write-Host "Node.jsをnodejs.orgから直接ダウンロードします..."
  $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
  $latestLts = $index | Where-Object { $_.lts } | Select-Object -First 1
  if (-not $latestLts) { throw "最新のLTS版情報が取得できませんでした" }
  $version = $latestLts.version
  $msiUrl = "https://nodejs.org/dist/$version/node-$version-x64.msi"
  $msiPath = Join-Path $env:TEMP "node-$version-x64.msi"
  Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath
  $p = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", $msiPath, "/quiet", "/norestart" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "msiexec の終了コード: $($p.ExitCode)" }
  Remove-Item $msiPath -ErrorAction SilentlyContinue
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.jsをインストールします..."
  try {
    if ($WingetAvailable) {
      winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
      if ($LASTEXITCODE -ne 0) { throw "winget の終了コード: $LASTEXITCODE" }
    } else {
      Install-NodeJsDirect
    }
  } catch {
    Write-Host "Node.jsのインストールに失敗しました: $_"
    exit 1
  }
  Write-Host "Node.jsのインストール後、このウィンドウを閉じて新しくPowerShellを開き直してから、もう一度このスクリプトを実行してください(PATHの反映のため)。"
  exit 0
} else {
  Write-Host "Node.jsは導入済みです ($(node --version))。"
}

# --- ActivityWatch ---
# wingetパッケージ(Inno Setupインストーラー)はPATHへ自動登録されないため、コマンド名では検出できない。
# 次の順で確実性の高い方法から場所を探す:
# 1. インストーラーが登録するアンインストール情報(レジストリのInstallLocation、最も確実)
# 2. よくあるインストール先のフォルダを直接探す
# 3. LOCALAPPDATA/ProgramFiles配下をaw-qt.exeで再帰検索(それでも見つからない場合の最終手段)
function Find-ActivityWatchExe {
  $productCode = "{F226B8F4-3244-46E6-901D-0CE8035423E4}_is1"
  $uninstallKeys = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$productCode",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$productCode",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\$productCode"
  )
  foreach ($key in $uninstallKeys) {
    try {
      $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
      if ($props -and $props.InstallLocation) {
        $exe = Join-Path $props.InstallLocation "aw-qt.exe"
        if (Test-Path $exe) { return $exe }
      }
    } catch {}
  }

  $candidates = @(
    "$env:LOCALAPPDATA\Programs\ActivityWatch\aw-qt.exe",
    "$env:LOCALAPPDATA\ActivityWatch\aw-qt.exe",
    "${env:ProgramFiles}\ActivityWatch\aw-qt.exe",
    "${env:ProgramFiles(x86)}\ActivityWatch\aw-qt.exe"
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }

  foreach ($root in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $root -or -not (Test-Path $root)) { continue }
    $found = Get-ChildItem -Path $root -Filter "aw-qt.exe" -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.FullName }
  }

  return $null
}

function Install-ActivityWatchDirect {
  Write-Host "ActivityWatchをGitHubから直接ダウンロードします..."
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/ActivityWatch/activitywatch/releases/latest"
  $asset = $release.assets | Where-Object { $_.name -match "windows-x86_64-setup\.exe$" } | Select-Object -First 1
  if (-not $asset) { throw "Windows用インストーラーが見つかりませんでした" }
  $exePath = Join-Path $env:TEMP $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exePath
  $p = Start-Process -FilePath $exePath -ArgumentList "/VERYSILENT", "/NORESTART", "/CURRENTUSER" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "ActivityWatchインストーラーの終了コード: $($p.ExitCode)" }
  Remove-Item $exePath -ErrorAction SilentlyContinue
}

$AwExePath = Find-ActivityWatchExe
if (-not $AwExePath) {
  Write-Host "ActivityWatchをインストールします..."
  try {
    if ($WingetAvailable) {
      winget install --id ActivityWatch.ActivityWatch -e --silent --accept-package-agreements --accept-source-agreements
      if ($LASTEXITCODE -ne 0) { throw "winget の終了コード: $LASTEXITCODE" }
    } else {
      Install-ActivityWatchDirect
    }
  } catch {
    Write-Host "自動インストールに失敗しました。手動で https://activitywatch.net/downloads/ からインストールしてから、もう一度実行してください。"
    exit 1
  }
  $AwExePath = Find-ActivityWatchExe
} else {
  Write-Host "ActivityWatchは導入済みです。"
}

Set-Location $ProjectDir
Write-Host "依存パッケージをインストールします..."
npm install
if ($LASTEXITCODE -ne 0) {
  Write-Host "npm install に失敗しました(終了コード $LASTEXITCODE)。"
  exit 1
}

$EnvPath = Join-Path $ProjectDir "agent\.env"
if (-not (Test-Path $EnvPath)) {
  $DashboardUrl = "https://log.bonkers.llc"
  $EmpName = $env:EMPLOYEE_NAME
  $OrgId = $env:ORG_ID
  $SharedPath = ""

  if (-not $OrgId) {
    Write-Host "ORG_ID が指定されていません。ダッシュボードの「社員」で発行されたセットアップコマンドをそのまま実行してください。"
    $OrgId = Read-Host "組織ID"
  }

  if ($EmpName -and $OrgId) {
    try {
      $resp = Invoke-RestMethod -Uri "$DashboardUrl/api/employees/by-slug/$OrgId/$EmpName/public"
      if ($resp.drive_path) { $SharedPath = $resp.drive_path }
    } catch {}
  }
  if (-not $SharedPath -and $OrgId) {
    try {
      $resp = Invoke-RestMethod -Uri "$DashboardUrl/api/settings?org=$OrgId"
      if ($resp.shared_drive_path) { $SharedPath = $resp.shared_drive_path }
    } catch {}
  }

  if ($SharedPath) {
    Write-Host "共有フォルダのパスをダッシュボード($DashboardUrl)から自動取得しました: $SharedPath"
  } else {
    Write-Host "共有フォルダのパスを設定してください。"
    $SharedPath = Read-Host "共有フォルダのフルパス(例: C:\Users\xxx\Google ドライブ\社員稼働ログ)"
  }
  if (-not $EmpName) {
    $EmpName = Read-Host "あなたの名前(半角英数、例: tanaka)"
  }

  @"
SHARED_DRIVE_PATH=$SharedPath
EMPLOYEE_NAME=$EmpName
ORG_ID=$OrgId
"@ | Set-Content -Path $EnvPath -Encoding UTF8

  Write-Host ".envを作成しました。"

  if ($SharedPath) {
    Write-Host "共有フォルダを一度開いて、Googleドライブの同期を先に済ませておきます..."
    try {
      New-Item -ItemType Directory -Force -Path $SharedPath -ErrorAction SilentlyContinue | Out-Null
      Invoke-Item $SharedPath -ErrorAction SilentlyContinue
    } catch {}
  }
}

Write-Host "ActivityWatchを起動します..."
if ($AwExePath) {
  Start-Process $AwExePath -ErrorAction SilentlyContinue
} else {
  Write-Host "インストール先が自動で見つかりませんでした。スタートメニューから「ActivityWatch」を検索して手動で起動してください。"
}
Write-Host ""
Write-Host "★ 手動でお願いしたいこと ★"
Write-Host "  初回起動時にWindowsのセキュリティ確認(SmartScreen等)が出た場合は「実行」を選んでください。"
Write-Host "  ActivityWatchが自動起動しなかった場合は、スタートメニューから手動で起動してください。"
Write-Host ""

& "$ScriptDir\install-windows.ps1"

Write-Host ""
Write-Host "セットアップ完了です。毎日23:50に自動でログが共有フォルダへ書き出されます。"
