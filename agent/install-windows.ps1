# 各社員のWindows PCで実行する: 毎日23:50に自動でログを書き出すタスクを登録する
# macOSのlaunchd(agent/install.sh)に相当。Windowsのタスクスケジューラを使う。
$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$TaskName = "MacActivityReport-Export"

$Action = New-ScheduledTaskAction -Execute "npm.cmd" -Argument "run export" -WorkingDirectory $ProjectDir
$Trigger = New-ScheduledTaskTrigger -Daily -At "23:50"
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings | Out-Null

Write-Host "登録しました。毎日23:50に自動でログを書き出します。"
Write-Host "手動でテストする場合: Start-ScheduledTask -TaskName '$TaskName'"
