# Example: Windows with an Intel Arc GPU

A setup that was tested with Jane: a Windows 11 PC with an **Intel Arc A770
(16 GB)** and 32 GB of RAM, running llama.cpp's `llama-server` with
**Huihui Qwen3.6-35B-A3B abliterated** at Q4_K_M quality and a 128k context.
Jane runs on a laptop on the same network and uses this PC as a host.

For what any host needs and how to add it to Jane, see
[Connecting a model on another machine](../../README.md#connecting-a-model-on-another-machine).
This page is the specific setup.

## Files

| File | What it is |
|---|---|
| [`start-llm.bat`](start-llm.bat) | The tested start script. Logs to `C:\llm\llama-server.log`, keeps the previous run's log as `llama-server.prev.log` (so a crash's log survives), and restarts the server a minute after it stops. |
| [`start-llm-minimal.bat`](start-llm-minimal.bat) | The same settings without the automatic restart; only keeps the previous log. |
| [`collect-crash-report.ps1`](collect-crash-report.ps1) | Copies the end of both logs, recent crashes of `llama-server.exe` and graphics driver resets to the clipboard. |

## Setup

Everything goes in `C:\llm`. Commands are for PowerShell.

1. **Model** (21.2 GB; `-C -` resumes an interrupted download):
   ```powershell
   mkdir C:\llm\models -Force
   curl.exe -L -C - -o C:\llm\models\Huihui-Qwen3.6-35B-A3B-abliterated.i1-Q4_K_M.gguf https://huggingface.co/mradermacher/Huihui-Qwen3.6-35B-A3B-abliterated-i1-GGUF/resolve/main/Huihui-Qwen3.6-35B-A3B-abliterated.i1-Q4_K_M.gguf
   ```
2. **Driver:** the latest Intel Arc driver (Intel Driver & Support Assistant).
3. **llama.cpp, SYCL build.** Builds are releases named like `b11435`; the
   Windows files are under *Assets* of each build (the release marked
   "Latest" doesn't have them). The SYCL zip includes Intel's runtime.
   ```powershell
   curl.exe -L -o C:\llm\llama-sycl.zip https://github.com/ggml-org/llama.cpp/releases/download/b11435/llama-b11435-bin-win-sycl-x64.zip
   Expand-Archive C:\llm\llama-sycl.zip -DestinationPath C:\llm\llama-sycl -Force
   C:\llm\llama-sycl\llama-server.exe --list-devices   # lists the A770 as a SYCL device
   ```
4. **Chat template:** the laptop runs the model with its own chat template
   (`--chat-template-file`); copy the same file to `C:\llm\qwen3.6-chat.jinja`
   so tool calls behave the same on both machines. With its text on the
   clipboard, this saves it without the BOM Notepad would add:
   ```powershell
   [IO.File]::WriteAllText('C:\llm\qwen3.6-chat.jinja', (Get-Clipboard -Raw))
   ```
   Without a template file, remove `--chat-template-file` from the script to
   use the one built into the model.
5. **API key:**
   ```powershell
   $key = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
   Set-Content -Path C:\llm\api-key.txt -Value $key -NoNewline
   $key
   ```
6. **Start script:**
   ```powershell
   curl.exe -L -o C:\llm\start-llm.bat https://raw.githubusercontent.com/bit-casper/jane/main/examples/windows-intel-arc/start-llm.bat
   ```
   Double-click it; it's ready when it says `listening on http://0.0.0.0:8080`.
7. **Network** (PowerShell as administrator): the home network must be
   *Private*; open port 8080 for private networks only, and find the address.
   ```powershell
   Get-NetConnectionProfile
   New-NetFirewallRule -DisplayName "llama-server (Jane)" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
   Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -like '192.168.*'
   ```
8. **Start at login, no sleep:** put a shortcut to `start-llm.bat` in the
   folder `Win+R` → `shell:startup` opens, and set *Make my device sleep
   after* to *Never* when plugged in.
9. **In Jane** (on the laptop):
   ```toml
   [[hosts]]
   name = "home"
   base_url = "http://<pc-address>:8080/v1"
   model = "qwen3.6-abliterated-q4"
   context_window = 131072
   api_key = "<key>"
   ```

## Tested settings

| Setting | Value | What it does |
|---|---|---|
| `N_CPU_MOE` | `20` | Layers whose experts stay in system RAM. Higher uses less GPU memory but is slower. 20 uses about 14.2 of 16 GB when idle. |
| `UBATCH` | `256` | Prompt tokens the GPU works on at once. Smaller uses less memory. |
| `CTX` | `131072` | Context size; Jane's `context_window` must match. |
| `KV` | `f16` | How the context is stored. `q8_0` uses less memory. |

Speed with these settings: about **132 tokens/s** reading the prompt and
**21 tokens/s** writing. For comparison, the laptop (RTX 4050 6 GB, the same
model at Q3_K, 64k context) does about 156 and 40. So this PC's gain is
quality and context, not speed.

## What we found: Vulkan crashes, SYCL works

The **Vulkan** build (`win-vulkan-x64`) crashed on every long prompt of
*normal* text: llama-server exited with `-1073740791` (`0xc0000409` in the
Application event log, an abort in `ucrtbase.dll`), with nothing in its log
and no graphics driver reset. Repetitive test text of the same or greater
length (10,000 tokens) worked, and so did short chats.

None of these helped: a smaller `UBATCH`, more `N_CPU_MOE`, an `f16` KV
cache, or `GGML_VK_DISABLE_COOPMAT=1`. The model is a mixture of experts, and
varied text uses many more of them than repetitive text, which seems to
trigger a Vulkan backend bug on Arc. The **SYCL** build ran every request that
crashed Vulkan, including Jane sessions with 11k tokens of context, and reads
prompts faster too (132 vs 83 tokens/s).

If the SYCL build crashes too, run `collect-crash-report.ps1`. A failed memory
allocation in the log means the GPU needs more room (it also drives the
screen, so what else is open matters): raise `N_CPU_MOE` by 2, or lower `CTX`.
