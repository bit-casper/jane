@echo off
rem Jane's model server on a Windows PC (tested: Intel Arc A770 16 GB, 32 GB RAM,
rem llama.cpp SYCL build b11435 in C:\llm\llama-sycl).
rem Put a shortcut to this file in shell:startup to start it at login.
rem It keeps a log, keeps the previous run's log after a crash, and restarts itself.
set MODEL=C:\llm\models\Huihui-Qwen3.6-35B-A3B-abliterated.i1-Q4_K_M.gguf
set /p KEY=<C:\llm\api-key.txt
set LOG=C:\llm\llama-server.log
set PREVLOG=C:\llm\llama-server.prev.log

rem N_CPU_MOE: how many layers keep their experts in system RAM instead of the GPU.
rem   Higher = less GPU memory, slower. 20 uses about 14.2 of 16 GB when idle.
rem UBATCH: how many prompt tokens the GPU works on at once.
rem   Smaller = less GPU memory and shorter GPU jobs, but long prompts read slower.
rem KV: how the conversation memory is stored. f16 is what was tested here;
rem   q8_0 (as on the laptop) needs less GPU memory.
set N_CPU_MOE=20
set UBATCH=256
set CTX=131072
set KV=f16

:start
if exist %LOG% move /y %LOG% %PREVLOG% >nul
C:\llm\llama-sycl\llama-server.exe -m "%MODEL%" --alias qwen3.6-abliterated-q4 ^
  -ngl 99 --n-cpu-moe %N_CPU_MOE% -fa on --parallel 1 ^
  -c %CTX% -ctk %KV% -ctv %KV% -ub %UBATCH% ^
  --jinja --chat-template-file C:\llm\qwen3.6-chat.jinja ^
  --host 0.0.0.0 --port 8080 --api-key %KEY% --log-file %LOG%

echo.
echo llama-server stopped (exit code %ERRORLEVEL%) at %time%.
echo The end of the log usually says why:  Get-Content %LOG% -Tail 20
echo Restarting in 60 seconds. Press Ctrl+C to stop, or any key to restart now.
timeout /t 60
goto start
