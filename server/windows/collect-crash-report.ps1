# Collects what's needed to understand a llama-server crash and copies it to the clipboard:
# the end of both logs, recent crashes of llama-server.exe, and graphics driver resets.
# Run: powershell -ExecutionPolicy Bypass -File C:\llm\collect-crash-report.ps1
$since = (Get-Date).AddHours(-3)
@(
  '=== previous run (last 30 lines) ==='
  Get-Content C:\llm\llama-server.prev.log -Tail 30 -ErrorAction SilentlyContinue
  '=== current run (last 30 lines) ==='
  Get-Content C:\llm\llama-server.log -Tail 30 -ErrorAction SilentlyContinue
  '=== program crashes (Application log) ==='
  Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000; StartTime=$since} -MaxEvents 3 -ErrorAction SilentlyContinue | Format-List TimeCreated, Message | Out-String
  '=== graphics driver resets (System log) ==='
  Get-WinEvent -FilterHashtable @{LogName='System'; Id=4101; StartTime=$since} -MaxEvents 5 -ErrorAction SilentlyContinue | Format-List TimeCreated, Message | Out-String
) | Set-Clipboard
'Crash report copied to the clipboard.'
