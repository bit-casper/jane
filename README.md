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

Commands: `/clear`, `/model [name]`, `/permissions [mode]`, `/settings`, `/skills`, `/<skill> [request]`, `/prompt [init|diff]`, `/undo`, `/compact [focus]`, `/host [name]`, `/hooks [allow]`, `/mcp [name]`, `/help`, `/exit`.

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
  up to you. To set up the other machine, see
  [Connecting a model on another machine](#connecting-a-model-on-another-machine).

### Hooks

Hooks are your own commands that Jane runs at certain moments. Add them as
`[[hooks]]` in `~/.config/jane/config.toml`:

| Event | When | Exit code 2 |
|---|---|---|
| `before_tool` | before a tool runs | the tool doesn't run; the hook's message goes to the model |
| `after_tool` | after a tool ran | the hook's message goes to the model (e.g. lint errors) |
| `prompt_submit` | when you send a message | the message isn't sent. Anything the hook prints (exit 0) is added to your message as context |
| `turn_end` | Jane finished replying | |
| `waiting` | Jane is waiting for your permission | |
| `session_start`, `session_end` | Jane starts or quits | |

A hook gets the details as JSON on stdin (`event`, `tool_name`, `tool_input`,
`tool_result`, `prompt`, `cwd`, `session_id`) and as variables: `$JANE_EVENT`,
`$JANE_TOOL`, `$JANE_FILE` (for read, write and edit), `$JANE_COMMAND` (for
bash), `$JANE_PROJECT_DIR` and `$JANE_SESSION_ID`. It runs in the project
folder with bash. Exit code 0 means fine, 2 blocks or talks to the model (see
the table), and anything else, or running past `timeout` (60 seconds by
default), is shown to you as a warning. This is the same style as Claude
Code's hooks, so scripts are easy to adapt.

```toml
# Format files after Jane changes them.
[[hooks]]
event = "after_tool"
tools = ["write", "edit"]
command = 'npx prettier --write "$JANE_FILE" >/dev/null'

# Show lint problems to the model, so it fixes them.
[[hooks]]
event = "after_tool"
tools = ["write", "edit"]
command = 'npx eslint "$JANE_FILE" >&2 || exit 2'

# A desktop notification when Jane is done or needs you.
[[hooks]]
event = "turn_end"
command = 'notify-send "Jane" "Done"'

[[hooks]]
event = "waiting"
command = 'notify-send "Jane" "Waiting for your permission ($JANE_TOOL)"'

# Never push from Jane.
[[hooks]]
event = "before_tool"
tools = ["bash"]
command = 'case "$JANE_COMMAND" in *"git push"*) echo "Pushing is not allowed; ask the user to push." >&2; exit 2;; esac'

# Tell Jane which branch you're on with every message.
[[hooks]]
event = "prompt_submit"
command = 'echo "Current git branch: $(git branch --show-current 2>/dev/null)"'
```

For tools, the block list is checked first, then `before_tool` hooks, then
the permission prompt, so a hook can refuse before you're asked.

**Project hooks.** A project's `.jane/config.toml` can define hooks too. Since
those would run someone else's commands on your computer, Jane shows them and
asks before running them, and remembers your answer for that project. If the
project's hooks change (say, after a `git pull`), Jane asks again. `/hooks`
lists all hooks and whether they're on; `/hooks allow` turns on a project's
hooks after you said "not now".

### Web tools

Jane can read web pages and search the web, but only once you turn it on:

```toml
[web]
enabled = true
search_url = "http://127.0.0.1:8888"   # your SearXNG; leave empty for fetching only
```

- **`web_fetch`** gets a page and gives the model its main content as
  Markdown: the article, without menus, scripts or footers (Readability, the
  library behind Firefox's reader view). Long pages come in parts. Plain text
  and JSON come through as they are. Images and PDFs aren't supported.
- **`web_search`** searches through **SearXNG**, a meta-search engine you run
  yourself, so there's no account, no API key, and no search company
  building a profile of you.
- In always-ask mode, Jane asks before fetching from a website, and "yes for
  this session" covers that website. Searches don't ask.
- Everything from the web is marked as untrusted for the model: pages can
  contain text written to manipulate AI assistants, and the model is told to
  treat it as information, never as instructions.
- `web.max_results` sets how many results a search returns (8 by default).

**Setting up SearXNG** (with Docker; it uses about 150 MB of memory):

1. Make `~/.config/searxng/settings.yml` with JSON results turned on (Jane
   needs them) and the rate limiter off (it's only for you):
   ```yaml
   use_default_settings: true
   server:
     secret_key: "<run: openssl rand -hex 32>"
     limiter: false
     image_proxy: false
   search:
     formats:
       - html
       - json
   ```
2. Start it, reachable only from this computer:
   ```sh
   docker run -d --name searxng --restart unless-stopped \
     -p 127.0.0.1:8888:8080 -v ~/.config/searxng:/etc/searxng:rw searxng/searxng
   ```
3. Check it: `curl "http://127.0.0.1:8888/search?q=test&format=json"` should
   print JSON. If Docker only starts on demand (it does on Arch/Omarchy),
   `sudo systemctl enable --now docker` makes SearXNG start at boot too.

### MCP servers

[MCP](https://modelcontextprotocol.io) servers give Jane more tools: a
browser to drive, an issue tracker, a database, and so on. Add each server as
an `[mcp.<name>]` section in `~/.config/jane/config.toml`: either a `command`
that Jane starts, or the `url` of a server running somewhere else.

```toml
# A browser Jane can drive (Playwright). Headless, with a throwaway profile.
[mcp.browser]
command = ["npx", "-y", "@playwright/mcp@latest", "--headless", "--isolated"]

# A server on a URL, with only some of its tools.
[mcp.tracker]
url = "https://mcp.example.com/mcp"
headers = { Authorization = "Bearer <token>" }
tools = ["search_issues", "get_issue"]
```

Other settings per server: `env` (environment variables for a local
server), `enabled = false` to keep it without starting it, and `timeout` for
a tool call (120 seconds by default).

- Servers start in the background when Jane starts, so they don't slow it
  down; Jane says when each one is ready. They keep running until you quit.
- The model sees their tools as `<server>__<tool>`; on screen they show as
  `browser: browser_navigate`.
- **Context:** every tool's description goes with every request. The
  Playwright server's 25 tools take about 4k tokens. Use `tools = [...]` to
  load only the ones you need; `/mcp` shows what each server costs.
- **Permissions:** in always-ask mode, MCP tools ask first like `bash`,
  except tools the server marks as read-only. Hooks apply to them too.
- **Memory:** local servers run on this computer, even when the model runs on
  another host. A browser takes a lot of memory; on a laptop that also runs
  the model, that can slow the model down badly.
- `/mcp` lists the servers and their status, `/mcp <name>` a server's tools,
  `/mcp restart <name>` tries a server again.
- **Project servers** in a project's `.jane/config.toml` start programs on
  your computer, so Jane asks first, like project hooks, and asks again if
  they change. `/mcp allow` turns them on later. A project can't redefine a
  server you already have under the same name.

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

### Your own system prompt

There are two ways to shape how Jane works:

- **`JANE.md` adds** instructions: your preferences, conventions and project
  rules (see [Project instructions](#project-instructions)). This is what you
  want most of the time.
- **`prompt.file` replaces** Jane's built-in instructions, meaning who she is
  and how she works. Use it when the built-in text doesn't suit the model
  you run (local models respond differently to the same wording), or for a
  different personality.

`/prompt init` writes the built-in instructions to `~/.config/jane/system.md`
as a starting point and sets `prompt.file` to that file. Edit it in any
editor; the changes apply from your next message. `/prompt` shows the full
prompt the model gets, and which parts it's made of.

Only that first part is replaced: Jane still adds the environment (working
directory, date, platform), the skills list and your `JANE.md` after it, so
tools and skills keep working. Instructions in `JANE.md` still apply, so keep
the two from contradicting each other. To go back to the built-in prompt,
reset *System prompt* in `/settings`.

Your file is a copy, so later improvements to Jane's built-in prompt don't
reach it by themselves. `/prompt init` also keeps the text it started from
(`system.md.base`); when Jane's built-in prompt changes, Jane says so once at
startup. `/prompt diff` then shows what changed in the built-in prompt since
you made your file, and how your prompt differs from the current built-in one.

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

[prompt]
file = ""                     # your own system prompt, e.g. "~/.config/jane/system.md"

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

[[hooks]]                     # your own commands at certain moments (see Hooks)
event = "turn_end"
command = 'notify-send "Jane" "Done"'

[web]                         # web tools: off until you turn them on (see Web tools)
enabled = false
search_url = ""               # your SearXNG, e.g. "http://127.0.0.1:8888"
max_results = 8

[mcp.browser]                 # MCP servers: more tools for Jane (see MCP servers)
command = ["npx", "-y", "@playwright/mcp@latest", "--headless", "--isolated"]

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

## Connecting a model on another machine

A stronger computer (a desktop at home, a GPU server) can run the model while
you work in Jane on your laptop. Jane only talks to it over HTTP, so the other
machine can run any operating system, GPU and model server, as long as it
offers the following.

### What the other machine needs

- **An OpenAI-compatible Chat Completions API** at a URL ending in `/v1`,
  with **streaming** and **tool calling** (function calling). Jane works
  through tools, so a model or server without tool calling won't be able to
  do much. Servers that offer this include llama.cpp's `llama-server`
  (started with `--jinja`), vLLM, LM Studio and Ollama; check your server's
  documentation for how to turn tool calling on.
- **A model that's good at tool calling**, with a large enough context. Jane's
  requests start at about 6,000 tokens and grow during a session.
- **To listen on the network**, not only on `127.0.0.1`. For `llama-server`
  that's `--host 0.0.0.0 --port 8080`.
- **An API key.** Anyone on the same network could otherwise use the server.
  `llama-server` and vLLM take `--api-key <key>`; for servers without one, put
  them behind a reverse proxy that checks a key. Make a key with, for
  example, `openssl rand -hex 16`.

A `llama-server` example (adjust the model, context size and GPU options to
the machine):

```sh
llama-server -m model.gguf --alias my-model --jinja -c 131072 \
  --host 0.0.0.0 --port 8080 --api-key <key>
```

### Making it reachable

1. **Open the port** in the other machine's firewall, for your home or local
   network only. On Windows, the network must be set to *Private*.
2. **Give the machine a fixed address**, for example a DHCP reservation in
   your router, so its address doesn't change.
3. **Keep it running:** start the server automatically at boot or login, and
   turn off sleep.
4. **Check it from your computer.** It should list the model, and refuse the
   request without the key (HTTP 401):
   ```sh
   curl -H "Authorization: Bearer <key>" http://<address>:8080/v1/models
   curl -i http://<address>:8080/v1/models
   ```

Jane only needs a URL. Reaching the machine from outside your home (with
Tailscale, a VPN or similar) is up to you; once a URL works, Jane can use it.

### Adding it to Jane

Add a `[[hosts]]` entry to `~/.config/jane/config.toml` (see
[Other machines](#other-machines-hosts)):

```toml
[[hosts]]
name = "home"
base_url = "http://<address>:8080/v1"
model = "my-model"            # the name the server reports in /v1/models
context_window = 131072       # the server's context size (-c for llama-server)
api_key = "<key>"
```

Start Jane: the banner says which host it's using, and `/host` shows all hosts
and whether they're reachable. If the host is down, Jane uses this machine and
says so.

### Testing it properly

Test with a **long request of real text**, like asking Jane to read and
summarise a big file, not only a short chat. Problems often only show up with
long prompts: running out of GPU memory, and on some GPUs backend bugs that
repetitive test text doesn't trigger. If the server crashes, Jane switches to
this machine and tells you when the other one is back. A start script that
restarts the server and keeps its log makes crashes easier to live with and to
diagnose.

### Example: Windows with an Intel Arc GPU

[`examples/windows-intel-arc/`](examples/windows-intel-arc/) is the setup that
was tested with a Windows PC with an Intel Arc A770 (16 GB): start scripts with
a crash log and automatic restart, a crash report script, and what we found
along the way. The short version: on Arc, use llama.cpp's **SYCL** build; the
Vulkan build crashed on long prompts of normal text.

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
