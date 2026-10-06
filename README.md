# Jane

A terminal coding agent for local AI models. Jane works like Claude Code in the
terminal, but talks only to a model server you run yourself: no accounts, no
telemetry, no outside checks.

```
   ▄▄▄▄▄  ▄▄▄  ▄▄  ▄▄ ▄▄▄▄▄
     ██  ██▀██ ███▄██ ██▄▄
  ▄  ██  ██▀██ ██▀███ ██▀▀
  ▀███▀  ██ ██ ██  ██ ██▄▄▄
   ░░░   ░░ ░░ ░░  ░░ ░░░░░
```

## Requirements

- Node.js 22 or newer
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`)
- A model server with an OpenAI-compatible API and tool calling, such as
  `llama-server` from llama.cpp started with `--jinja`

## Install

```sh
git clone https://github.com/bit-casper/jane.git
cd jane
npm install
npm run build
ln -s "$PWD/bin/jane.js" ~/.local/bin/jane
```

After changing the code, `npm run build` again; the `jane` command picks up the
new build right away.

## Use

```sh
jane                 # new session in the current directory
jane --continue      # continue the most recent session here
jane --resume        # pick a session to resume
jane --resume <id>   # resume a specific session
jane --model <name>  # use another model for this run
jane --mode unrestricted
jane --host home     # use this host instead of the first one that answers
```

| Key | Action |
|---|---|
| Enter | Send |
| Shift+Enter, `\` + Enter, Ctrl+J | New line |
| ↑ / ↓ | Previous prompts |
| Esc | Interrupt Jane |
| Shift+Tab | Switch permission mode |
| Ctrl+C | Clear the input, or press twice to quit |

Commands: `/clear`, `/model [name]`, `/permissions [mode]`, `/settings`, `/skills`, `/<skill> [request]`, `/undo`, `/compact [focus]`, `/host [name]`, `/help`, `/exit`.

### Permission modes

- **always-ask** (default): reading and searching files happens without asking.
  Writing and editing files and running commands show what will happen and
  ask first.
- **unrestricted**: Jane runs every tool without asking.

### Long sessions

The context window (64k tokens on the laptop) fills up as a session goes on;
the status line shows how full it is. When it passes 80%, Jane compacts the
conversation: the model writes a summary (requests, work done, current state,
next steps, key facts) and that replaces the history, even in the middle of a
task. If the server says the conversation doesn't fit, Jane compacts and tries
again. `/compact` does it by hand, optionally with a focus:
`/compact keep the details of the API errors`.

Nothing disappears from your screen, and `--resume` still shows the whole
conversation; only the model works from the summary. Turn automatic compaction
off or change when it happens with `compact.auto` and `compact.at_percent`.

### Other machines (hosts)

Jane can use a stronger machine, like a PC at home, whenever it's reachable,
and fall back to the model on this machine when it isn't. Add each machine as
a `[[hosts]]` entry; `[model]` stays as this machine and is called `local`.

```toml
[[hosts]]
name = "home"
base_url = "http://192.168.86.42:8080/v1"
model = "qwen3.6-abliterated-q4"
context_window = 131072
api_key = "…"                 # the key the server was started with (--api-key)
```

- At startup Jane checks all hosts at once (about a second and a half at most)
  and uses the first one in the list that answers; the status line shows which
  (`home · model · 12k / 128k`). A host that's down or has the wrong API key
  is mentioned and skipped.
- If the host in use stops answering, even in the middle of a reply, Jane
  says so, switches to the next host that answers, and sends the request
  again. A smaller context on the new host is handled by compaction.
- When a host higher in the list is reachable again, Jane says so once; it
  doesn't switch by itself. `/host` shows all hosts and whether they're
  reachable, `/host <name>` switches, and `jane --host <name>` starts on one.
- Jane only needs a URL. How it's reached (home network, Tailscale, a VPN) is
  up to you.

### Undo

Before Jane writes or edits a file, it saves a copy. `/undo` lists Jane's
changes, newest first; pick one to undo it and every change after it. If a file
was changed after Jane's edit (by you or a command), Jane asks before
overwriting it. Jane also tells the model about the undo, so it doesn't redo
the change on its own. Undo works after `--resume` too. Changes made by `bash`
commands can't be undone. Turn it off with `checkpoints.enabled = false`.

### Block list

Some bash commands are always refused, in every permission mode: `rm -r` on
`/` or your home folder, formatting or wiping disks (`mkfs`, `wipefs`, `dd`
onto a disk, `shred /dev/…`), `chmod`/`chown -R` on `/`, and fork bombs. Jane
tells the model the command was blocked and that you can run it yourself if
it's really needed. It's a safety net against accidents, not a security
boundary. The patterns are regular expressions in `block_list.patterns`, so
you can add your own; turn it off with `block_list.enabled = false`.

### Project instructions

Put instructions for Jane in a `JANE.md` file in your project, and/or in
`~/.config/jane/JANE.md` for every project. The file names are configurable,
so Jane can also read `AGENTS.md` or `CLAUDE.md`.

### Skills

Skills are folders with a `SKILL.md`: a short YAML header (`name`,
`description`) and Markdown instructions. It's the same format as Claude Code
skills, so existing skills work in Jane as they are.

Jane lists each skill's name and description for the model, and the model loads
a skill's full instructions with its `skill` tool when a task matches. You can
also run one yourself with `/<skill-name> [request]`, and see them all with
`/skills`. A skill with `disable-model-invocation: true` only runs when you type
it.

Jane looks in these folders; when two skills share a name, the first wins:

| Folder | Source |
|---|---|
| `<project>/.jane/skills/` | `jane` |
| `<project>/.claude/skills/` | `claude` |
| `~/.config/jane/skills/` | `jane` |
| `~/.claude/skills/` | `claude` |
| `/usr/share/omarchy/default/agents/skills/` | `omarchy` |
| anything in `skills.extra_dirs` | |

Turn sources on or off with `skills.sources`.

## Configuration

The easiest way to change settings is `/settings` inside Jane: pick a
setting, change it, and it's saved and applied right away. Tab switches between
saving to your user config and to the project's config, and `r` resets a
setting to the default. Comments in your config files are kept.

The files are `~/.config/jane/config.toml`, overridden per project by
`.jane/config.toml`. Every setting is optional; these are the defaults:

```toml
[model]
base_url = "http://127.0.0.1:8080/v1"
name = "qwen3.6-abliterated"
context_window = 65536
api_key = ""                  # only for servers that need one

[permissions]
default_mode = "always-ask"   # or "unrestricted"

[instructions]
filenames = ["JANE.md"]       # first one found wins, e.g. ["JANE.md", "AGENTS.md"]

[skills]
sources = ["jane", "claude", "omarchy"]
extra_dirs = []               # more folders with skills in them

[compact]
auto = true                   # summarise automatically when the context fills up
at_percent = 80               # how full (10–95%) before compacting

[[hosts]]                     # other machines, tried first in this order (see above)
name = "home"
base_url = "http://192.168.86.42:8080/v1"
model = "qwen3.6-abliterated-q4"
context_window = 131072
api_key = ""

[checkpoints]
enabled = true                # save a copy before each write/edit, for /undo

[block_list]
enabled = true
patterns = [ … ]              # regular expressions; the built-in ones by default

[ui]
show_thinking = "collapsed"   # "full" | "collapsed" | "hidden"
theme = "omarchy"             # "omarchy" | "none"

[ui.colors]                   # names ("cyan") or hex ("#88c0d0")
user = "cyan"
assistant = "white"
thinking = "gray"
accent = "magenta"
diff_add = "green"
diff_remove = "red"
```

### Omarchy theme

On [Omarchy](https://omarchy.org), Jane uses the colours of your current
theme, and follows along when you switch: new output uses the new colours
straight away, and the conversation so far is redrawn in them (after the
current reply finishes, if Jane is busy). Colours you set in `[ui.colors]` win
over the theme. Set `ui.theme = "none"` to use only the config colours.

| Jane | Omarchy theme colour |
|---|---|
| `user` | `cyan` |
| `assistant` | `foreground` |
| `thinking` | `foreground` mixed 40% with `background` |
| `accent` | `accent` |
| `diff_add` | `green` |
| `diff_remove` | `red` |

## Setting up another machine as a host

This is how the home PC was set up and tested: **Windows 11, Intel Arc A770
(16 GB), 32 GB RAM**, running [llama.cpp](https://github.com/ggml-org/llama.cpp)'s
SYCL build (Intel's own backend) with the same model as the laptop at higher quality (Q4_K_M) and
twice the context (128k). The scripts are in [`server/windows/`](server/windows/).
On Linux the steps are the same idea: build or install llama.cpp, then run the
same `llama-server` command (see `llm-serve` on the laptop for an example).

Everything goes in `C:\llm`. Commands are for PowerShell.

1. **Download the model** (21.2 GB; it takes a while, so start it first;
   `-C -` lets you resume an interrupted download):
   ```powershell
   mkdir C:\llm\models -Force
   curl.exe -L -C - -o C:\llm\models\Huihui-Qwen3.6-35B-A3B-abliterated.i1-Q4_K_M.gguf https://huggingface.co/mradermacher/Huihui-Qwen3.6-35B-A3B-abliterated-i1-GGUF/resolve/main/Huihui-Qwen3.6-35B-A3B-abliterated.i1-Q4_K_M.gguf
   ```
2. **Update the graphics driver** (for Intel: Intel Driver & Support
   Assistant).
3. **Install llama.cpp.** Builds are published as releases named like
   `b11435`; the Windows files are under *Assets* of each build (the release
   marked "Latest" doesn't have them). For an Intel Arc card, get the **SYCL**
   build, `llama-<build>-bin-win-sycl-x64.zip` (it includes Intel's runtime),
   and unzip it to `C:\llm\llama-sycl`:
   ```powershell
   curl.exe -L -o C:\llm\llama-sycl.zip https://github.com/ggml-org/llama.cpp/releases/download/b11435/llama-b11435-bin-win-sycl-x64.zip
   Expand-Archive C:\llm\llama-sycl.zip -DestinationPath C:\llm\llama-sycl -Force
   C:\llm\llama-sycl\llama-server.exe --list-devices   # should list the GPU as a SYCL device
   ```
   Don't use the Vulkan build on Arc: with this model it crashed on every
   long prompt of normal text (see *If the server crashes*). For an NVIDIA
   card use a `win-cuda` build, for AMD `win-vulkan` or `win-rocm`.
4. **Copy the chat template** from the laptop (`~/.config/llama/qwen3.6-chat.jinja`)
   to `C:\llm\qwen3.6-chat.jinja`, so tool calls work the same on both
   machines. If you copy its text to the clipboard on the PC, this saves it
   without the BOM Notepad would add:
   ```powershell
   [IO.File]::WriteAllText('C:\llm\qwen3.6-chat.jinja', (Get-Clipboard -Raw))
   ```
5. **Make an API key**, so only Jane can use the server:
   ```powershell
   $key = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
   Set-Content -Path C:\llm\api-key.txt -Value $key -NoNewline
   $key
   ```
6. **Get the start script** and save it as `C:\llm\start-llm.bat`:
   - [`start-llm.bat`](server/windows/start-llm.bat): **the version we
     tested and got working.** It logs to `C:\llm\llama-server.log`, keeps the
     previous run's log as `llama-server.prev.log` (so a crash's log survives
     the restart), and restarts the server a minute after it stops.
   - [`start-llm-minimal.bat`](server/windows/start-llm-minimal.bat): the
     same settings without the automatic restart, keeping only the crash log.

   ```powershell
   curl.exe -L -o C:\llm\start-llm.bat https://raw.githubusercontent.com/bit-casper/jane/main/server/windows/start-llm.bat
   ```
7. **Start it and check it fits.** Double-click the script; it's ready when it
   says `listening on http://0.0.0.0:8080`. Test with a **long** request
   (Jane's start at about 6,000 tokens; a short chat in the browser isn't
   enough), and watch Task Manager → Performance → GPU → *Dedicated GPU
   memory*. The tested settings:

   | Setting | Tested value | What it does |
   |---|---|---|
   | `N_CPU_MOE` | `20` | Layers whose experts stay in system RAM. Higher uses less GPU memory but is slower. 20 uses about 14.2 of 16 GB when idle. |
   | `UBATCH` | `256` | Prompt tokens the GPU works on at once. Smaller uses less memory. |
   | `CTX` | `131072` | Context size. Put the same number in Jane's `context_window`. |
   | `KV` | `f16` | How the context is stored. `q8_0` uses less memory. |

   With these, the A770 reads prompts at about 132 tokens/s and writes at
   about 21 tokens/s (the laptop's RTX 4050 with Q3: about 156 and 40). The
   home PC's gain is quality (Q4) and context (128k), not speed. Test with
   real text, like a README: repetitive test text can pass where real text
   crashes.

8. **Let the laptop reach it.** In PowerShell as administrator: make sure the
   home network is *Private*, and open port 8080 on private networks only.
   Then find the PC's address, and give it a fixed one in your router (a DHCP
   reservation) so it doesn't change.
   ```powershell
   Get-NetConnectionProfile                     # NetworkCategory should be Private
   New-NetFirewallRule -DisplayName "llama-server (Jane)" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
   Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -like '192.168.*'
   ```
9. **Start at login, and don't sleep.** Put a shortcut to `start-llm.bat` in
   the folder that `Win+R` → `shell:startup` opens, and set *Make my device
   sleep after* to *Never* when plugged in. Windows has to be logged in (it
   can be locked).
10. **Add it to Jane** as a `[[hosts]]` entry (see *Other machines* above)
    with the address, the model alias `qwen3.6-abliterated-q4`,
    `context_window = 131072` and the API key. Check from the laptop:
    ```sh
    curl -H "Authorization: Bearer <key>" http://<pc-address>:8080/v1/models
    ```
    and in Jane, `/host`.

### If the server crashes

A crash with exit code `-1073740791` (`0xc0000409` in Windows' event log)
means llama.cpp stopped itself. To see what happened, run
[`collect-crash-report.ps1`](server/windows/collect-crash-report.ps1): it
copies the end of both logs, recent crashes and graphics driver resets to the
clipboard.

What we found on the A770: the **Vulkan** build crashed like this on every
long prompt of normal text, with nothing in the log, while repetitive test
text of the same length and short chats worked. The model is a mixture of
experts, and varied text uses many more of them than repetitive text, which
seems to trigger a bug in the Vulkan backend on Arc (turning off its
cooperative-matrix path with `GGML_VK_DISABLE_COOPMAT=1` didn't help). Smaller
`UBATCH`, more `N_CPU_MOE` and an `f16` KV cache didn't help either. The
**SYCL** build runs the same requests without crashing.

If a crash does show up in the log as a failed memory allocation, give the GPU
more room: it also drives the screen, so what else is open matters. Raise
`N_CPU_MOE` by 2, or lower `CTX`. Either way, Jane switches to the laptop when
the PC stops answering, and says when it's back.

## Where Jane keeps things

| What | Where |
|---|---|
| Sessions | `~/.local/share/jane/sessions/` |
| Undo copies | next to each session, in `<session>.checkpoints/` |
| Error log | `~/.local/state/jane/jane.log` |

Both follow `XDG_DATA_HOME` and `XDG_STATE_HOME` when set.

## Development

```sh
npm run build      # compile to dist/
npm run dev        # compile on every change
npm test           # unit tests and agent-loop tests against a fake model server
```

See [PLAN.md](PLAN.md) for the spec and roadmap.

## Licence

MIT
