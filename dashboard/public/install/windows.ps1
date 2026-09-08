# 社員のWindows PCで1行だけ実行してもらうインストーラー(直接アップロード方式・新)。
# docs/decisions/0003-direct-upload.md 参照。git clone・npm installは不要。
#
# 使い方(PowerShellで):
#   $env:ORG_ID="<組織ID>"; $env:EMPLOYEE_NAME="<社員スラッグ>"; $env:UPLOAD_TOKEN="<トークン>"; irm https://log.bonkers.llc/install/windows.ps1 | iex
#
# irmでスクリプト本文を取得してiexでその場実行するため、.ps1ファイルとして保存されず
# ExecutionPolicyの制限は関係ない(署名なしスクリプトのブロックを回避できる)。
#
# 何度実行してもよい(冪等): .env・export-daily-log.mjs・タスクスケジューラ登録を上書きして最新化する。
$ErrorActionPreference = "Stop"

$DashboardUrl = if ($env:DASHBOARD_URL) { $env:DASHBOARD_URL } else { "https://log.bonkers.llc" }
$OrgId = $env:ORG_ID
$EmployeeName = $env:EMPLOYEE_NAME
$UploadToken = $env:UPLOAD_TOKEN

Write-Host "=== Windows操作ログ収集ツール セットアップ(直接アップロード方式) ==="

if (-not $OrgId -or -not $EmployeeName -or -not $UploadToken) {
  Write-Host "エラー: ORG_ID・EMPLOYEE_NAME(社員スラッグ)・UPLOAD_TOKENが必要です。" -ForegroundColor Red
  Write-Host "ダッシュボードの「社員」画面で発行されたコマンドをそのまま実行してください。" -ForegroundColor Red
  exit 1
}

# --- 1. 保存先ディレクトリ ---
$AgentDir = Join-Path $env:LOCALAPPDATA "mac-activity-agent"
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null

$WingetAvailable = [bool](Get-Command winget -ErrorAction SilentlyContinue)
if (-not $WingetAvailable) {
  Write-Host "wingetが見つかりません。GitHub/nodejs.orgから直接ダウンロードしてインストールします。"
}

# --- 2. Node.js ---
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
    Write-Host "Node.jsのインストールに失敗しました: $_" -ForegroundColor Red
    exit 1
  }
  Write-Host "Node.jsのインストール後、このウィンドウを閉じて新しくPowerShellを開き直してから、もう一度この手順を実行してください(PATHの反映のため)。"
  exit 0
} else {
  Write-Host "Node.jsは導入済みです ($(node --version))。"
}
$NodeExePath = (Get-Command node).Source

# --- 3. ActivityWatch ---
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
    Write-Host "自動インストールに失敗しました。手動で https://activitywatch.net/downloads/ からインストールしてから、もう一度この手順を実行してください。" -ForegroundColor Red
    exit 1
  }
  $AwExePath = Find-ActivityWatchExe
} else {
  Write-Host "ActivityWatchは導入済みです。"
}

# --- 4. 書き出しスクリプトと.envの配置 ---
Write-Host "書き出しスクリプトをダウンロードします..."
Invoke-WebRequest -Uri "$DashboardUrl/install/export-daily-log.mjs" -OutFile (Join-Path $AgentDir "export-daily-log.mjs")

$EnvPath = Join-Path $AgentDir ".env"
@"
ORG_ID=$OrgId
EMPLOYEE_NAME=$EmployeeName
UPLOAD_TOKEN=$UploadToken
DASHBOARD_URL=$DashboardUrl
AW_EXE_PATH=$AwExePath
"@ | Set-Content -Path $EnvPath -Encoding UTF8
Write-Host "設定を保存しました: $EnvPath (トークンは表示しません)"

# --- 5. タスクスケジューラ登録(PCが起動している間、30分おきに自動送信) ---
# 特定の時刻(旧: 毎日23:50)固定だと、その時間にPCを閉じている人のデータが取れない。
# 人によって稼働時間がバラバラなため、起動中は30分おきに「今日の分」を送り直す方式にする
# (同じ日付は上書きされる設計なので、何度送っても壊れない)。
$TaskName = "MacActivityReport-Export"
$ScriptPath = Join-Path $AgentDir "export-daily-log.mjs"
$RunLog = Join-Path $AgentDir "export.log"
$VbsPath = Join-Path $AgentDir "run-export.vbs"

# node.exeを直接タスクにすると30分おきに黒いコンソール窓が一瞬出て目障りなので、
# VBScript経由で窓を出さずに実行する(出力は export.log に追記)。
# VBScriptの文字列内では " を "" と書く。cmd /c には全体をもう一段 " で囲む必要がある。
$VbsContent = @"
' 送信スクリプトをコンソール窓を出さずに実行する(タスクスケジューラから30分おきに呼ばれる)
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c """"$NodeExePath"" ""$ScriptPath"" >> ""$RunLog"" 2>&1""", 0, False
"@
# パスに日本語(ユーザー名など)が入っていても壊れないよう、BOM付きUTF-16で保存する(wscriptが正しく読める形式)
Set-Content -Path $VbsPath -Value $VbsContent -Encoding Unicode

$Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //Nologo `"$VbsPath`"" -WorkingDirectory $AgentDir
# 「無期限」を [TimeSpan]::MaxValue で表すと環境によって登録エラーになるため、10年で表す
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings | Out-Null
Write-Host "PCが起動している間、30分おきに自動アップロードするタスク($TaskName)を登録しました。"

# --- 6. ActivityWatchをスタートアップに登録 & 起動 ---
# 登録しないと再起動後にActivityWatchが止まったままになり、30分おきの送信が全部空振りする(docs/decisions/0004)。
# 送信スクリプト側にも「応答が無ければ AW_EXE_PATH を起動する」自己修復があるが、スタートアップ登録が本命。
if ($AwExePath) {
  try {
    $StartupDir = [Environment]::GetFolderPath("Startup")
    $ShortcutPath = Join-Path $StartupDir "ActivityWatch.lnk"
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = $AwExePath
    $Shortcut.WorkingDirectory = Split-Path $AwExePath
    $Shortcut.Save()
    Write-Host "ActivityWatchをスタートアップに登録しました(再起動後も自動で起動します)。"
  } catch {
    Write-Host "警告: スタートアップへの登録ができませんでした: $_ (送信ジョブ側でも起動を試みるので、そのままでも動きます)" -ForegroundColor Yellow
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

# --- 7. 即時テスト実行 ---
Write-Host "動作確認のため、今すぐ1回書き出しを実行します..."
& $NodeExePath "$ScriptPath"
if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "セットアップ完了です。PCが起動している間、30分おきに自動でログをアップロードします。"
} else {
  Write-Host ""
  Write-Host "セットアップは完了しましたが、動作確認は失敗しました(上記のエラーを確認してください、終了コード $LASTEXITCODE)。" -ForegroundColor Yellow
  Write-Host "ActivityWatchの起動直後は少し待ってから、以下で手動テストしてください: $NodeExePath `"$ScriptPath`""
}
Write-Host ""
Write-Host "手動でテストする場合: $NodeExePath `"$ScriptPath`""
Write-Host "タスクを今すぐ試す場合: Start-ScheduledTask -TaskName '$TaskName'"
