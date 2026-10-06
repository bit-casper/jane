@echo off
rem Jane's model server on a Windows PC: the same tested settings as start-llm.bat,
rem without the automatic restart. The log of the previous run is kept as a crash log.
set /p KEY=<C:\llm\api-key.txt
if exist C:\llm\llama-server.log move /y C:\llm\llama-server.log C:\llm\llama-server.prev.log >nul

C:\llm\llama-sycl\llama-server.exe -m C:\llm\models\Huihui-Qwen3.6-35B-A3B-abliterated.i1-Q4_K_M.gguf ^
  --alias qwen3.6-abliterated-q4 -ngl 99 --n-cpu-moe 20 -fa on --parallel 1 ^
  -c 131072 -ctk f16 -ctv f16 -ub 256 ^
  --jinja --chat-template-file C:\llm\qwen3.6-chat.jinja ^
  --host 0.0.0.0 --port 8080 --api-key %KEY% --log-file C:\llm\llama-server.log
