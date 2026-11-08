<#
.SYNOPSIS
  DSH × Lark 机器人 —— Windows 管理脚本

.EXAMPLE
  .\botctl.ps1 status
  .\botctl.ps1 logs
  .\botctl.ps1 restart
  .\botctl.ps1 doctor
  .\botctl.ps1 test "你好"
  .\botctl.ps1 uninstall
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'status', 'start', 'stop', 'restart', 'logs', 'doctor', 'test', 'uninstall', 'help')]
    [string]$Command = 'status',

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Args2
)

$ErrorActionPreference = 'Continue'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BotJs = Join-Path $Dir 'bot.mjs'
$TaskName = 'DSH-Lark-Bot'
$VbsFile = Join-Path $Dir 'run-hidden.vbs'
$Root = Join-Path $env:USERPROFILE '.dsh-lark-bot'
$PidFile = Join-Path $Root 'bot.pid'

function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }

function Get-BotProcess {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*bot.mjs*' }
}

function Stop-Bot {
    # 1) 停计划任务（会终止 wscript 看门狗）
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch {}
    # 2) 停手工启动的看门狗
    Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*run-hidden.vbs*' } |
        ForEach-Object { try { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null } catch {} }
    # 3) 停机器人体本体（优先 pid 文件，兜底按命令行匹配）
    $pids = @()
    if (Test-Path $PidFile) { $pids += (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1) }
    $pids += (Get-BotProcess).ProcessId
    foreach ($p in ($pids | Where-Object { $_ } | Select-Object -Unique)) {
        try { Stop-Process -Id ([int]$p) -Force -ErrorAction Stop } catch {}
    }
    Start-Sleep -Milliseconds 800
    if (Get-BotProcess) { Warn '仍有 bot.mjs 进程残留，可手工 taskkill /IM node.exe /F 处理' } else { Ok '已停止' }
}

switch ($Command) {
    'install' {
        & (Join-Path $Dir 'install-windows.ps1')
    }
    'start' {
        if (-not (Test-Path $VbsFile)) {
            Warn "缺少 $VbsFile，请先运行 .\install-windows.ps1"
            return
        }
        if (Get-BotProcess) { Ok '已在运行'; return }
        try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop; Ok '计划任务已启动' }
        catch { Start-Process (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + $VbsFile + '"'); Ok '已用看门狗启动' }
        Start-Sleep -Seconds 3
        & node $BotJs --status
    }
    'stop' { Stop-Bot }
    'restart' {
        Stop-Bot
        Start-Sleep -Seconds 1
        & $PSCommandPath start
    }
    'status' {
        Write-Host '── 计划任务 ──'
        try {
            $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
            $i = Get-ScheduledTaskInfo -TaskName $TaskName
            Ok ("状态: {0}  上次结果: {1}  上次运行: {2}" -f $t.State, $i.LastTaskResult, $i.LastRunTime)
        } catch { Warn "未注册计划任务（$TaskName）" }
        Write-Host '── 进程 ──'
        $p = Get-BotProcess
        if ($p) { Ok ("bot.mjs 运行中 PID {0}，内存 {1:N1} MB" -f ($p.ProcessId -join ','), (($p.WorkingSetSize | Measure-Object -Sum).Sum / 1MB)) }
        else { Warn 'bot.mjs 未运行' }
        Write-Host '── bot 状态 ──'
        & node $BotJs --status
        Write-Host '── 最近日志 ──'
        $log = Get-ChildItem (Join-Path $Root 'logs') -Filter 'bot-*.log' -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($log) { Get-Content $log.FullName -Tail 8 } else { Warn '暂无日志' }
    }
    'logs' {
        $log = Get-ChildItem (Join-Path $Root 'logs') -Filter 'bot-*.log' -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $log) { Warn '暂无日志'; return }
        Write-Host "跟踪 $($log.FullName)（Ctrl+C 退出）" -ForegroundColor DarkGray
        Get-Content $log.FullName -Tail 30 -Wait
    }
    'doctor' {
        & node $BotJs --doctor
    }
    'test' {
        $text = if ($Args2) { $Args2 -join ' ' } else { '回复：跨平台链路自测正常' }
        & node $BotJs --simulate $text
    }
    'uninstall' {
        Stop-Bot
        try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Ok '计划任务已删除' } catch {}
        $startupVbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'DSH-Lark-Bot.vbs'
        if (Test-Path $startupVbs) { Remove-Item $startupVbs -Force; Ok '启动文件夹快捷方式已删除' }
        Ok "卸载完成（配置和日志保留在 $Root）"
    }
    default {
        @'
用法：.\botctl.ps1 <命令>

  install     安装（等同运行 install-windows.ps1）
  status      查看计划任务 / 进程 / bot 状态 / 最近日志
  start       启动
  stop        停止（含看门狗）
  restart     重启
  logs        实时跟踪日志
  doctor      环境自检
  test "文本"  端到端自测（会真的在 Lark 里发消息）
  uninstall   卸载开机自启

'@ | Write-Host
    }
}
