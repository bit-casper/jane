# Jane — Plan & Spec

Jane is a terminal coding agent for local AI models. It works like Claude Code in
the terminal, but every part of it runs on your machine, under your control, in
your style.

## Principles

1. **Local only.** No telemetry, no update checks, no accounts. The only network
   traffic is to the model server you configure (plus web tools, later, if you
   turn them on).
2. **You decide.** The only checks are the ones you set up: the permission mode,
   and (later) the block list.
3. **Built for local models.** Short system prompt, few simple tools, careful
   use of context, and tolerance for messy tool calls.
4. **Make it yours.** Everything visible can be configured: colours, banner,
   instructions file name, paths.
5. **Small steps.** First a minimal v1 that works, then one branch and one PR
   per feature.

## Environment (as of 2026-10-05)

| | |
|---|---|
| Machine | Omarchy (Arch), RTX 4050 Laptop 6 GB VRAM, 23 GB RAM |
| Model | `qwen3.6-abliterated`: Huihui Qwen3.6-35B-A3B abliterated, Q3_K GGUF |
| Server | `llama-server` (llama.cpp) via `llm.service`, `127.0.0.1:8080`, 64k context, `--jinja` with a Qwen chat template (tool calling supported) |
| Runtime | Node 26 (via mise), ripgrep available |
| Later | A stronger home PC as a second host (roadmap item 8). |

## Technical decisions

- **Language:** TypeScript on Node.
- **Terminal UI:** [Ink](https://github.com/vadimdemedes/ink) (React for the
  terminal), the same approach Claude Code uses.
- **Model API:** OpenAI-compatible `/v1/chat/completions` with streaming and
  tool calls. A small `fetch`-based client of our own, with no vendor SDK, so
  every byte that leaves the process is visible in our code.
- **Build:** `tsc` to `dist/`. `npm run build` rebuilds.
- **Install:** `~/.local/bin/jane` is a symlink to the repo's `bin/jane.js`, so
  a rebuild takes effect immediately.
- **Config format:** TOML.
- **Tests:** `vitest` for unit tests, a fake OpenAI-compatible server for
  end-to-end tests of the agent loop, and a manual check against the real local
  model before each PR.

## File locations

| What | Where |
|---|---|
| User config | `~/.config/jane/config.toml` |
| Project config (overrides user) | `<project>/.jane/config.toml` |
| Sessions | `~/.local/share/jane/sessions/<project-slug>/<session-id>.jsonl` |
| Logs | `~/.local/state/jane/` |
| User skills (later) | `~/.config/jane/skills/` |

All of these follow `XDG_*` variables when set.

## v1 spec

### Startup and banner

- `jane` starts a new session in the current directory.
- `jane --continue` (`-c`) reopens the most recent session for this directory.
- `jane --resume` (`-r`) shows a list of this directory's sessions (date, first
  prompt, message count) to choose from. `jane --resume <id>` opens one
  directly.
- `jane --version` and `jane --help`.
- The banner shows "JANE" in shaded block letters (in the accent colour), plus
  the Jane version, the model name and the working directory.

### Conversation

- Replies stream in as the model writes them.
- **Esc** interrupts the current reply or tool run. The partial reply is kept.
- Your prompts and Jane's replies have their own colours (set in config).
- Replies are rendered as Markdown in the terminal: code blocks, lists and
  bold text.
- Model "thinking" (`reasoning_content`) is shown dimmed and collapsed to one
  line. A setting can show it in full or hide it.
- A status line at the bottom shows the permission mode, the model and how full
  the context is (e.g. `31k / 64k`).
- Multi-line input: Enter sends, Shift+Enter (or `\` + Enter) adds a new line.
  Up and Down move through your previous prompts.

### Tools

| Tool | What it does |
|---|---|
| `read` | Read a file with line numbers. Optional offset and limit. |
| `write` | Create or overwrite a file. |
| `edit` | Replace an exact string in a file. It must match exactly once unless `replace_all` is set. |
| `bash` | Run a shell command in the project directory, with a timeout (default 2 min). Output is truncated if too long. |
| `glob` | Find files by pattern. Respects `.gitignore`. |
| `grep` | Search file contents with ripgrep. |

- `write` and `edit` show a coloured diff of the change, like Claude Code does.
- Tool results that are too big are shortened, with a note telling the model it
  can read more.
- When a tool call is malformed (bad JSON, unknown tool, missing argument), the
  model gets a clear error message and tries again. After 3 failures in a row,
  Jane stops and tells you.

### Permission modes

- **`unrestricted`:** Jane runs every tool without asking.
- **`always-ask`:** `read`, `glob` and `grep` run without asking. `write`,
  `edit` and `bash` show what they're about to do (the diff or the command) and
  ask:
  - **yes**
  - **yes, and don't ask again for this tool this session**
  - **no, and tell Jane what to do instead**
- Shift+Tab or `/permissions` switches modes. The default mode is set in config.

### Project instructions

- At startup, Jane looks for the first file found from
  `instructions.filenames` (default `["JANE.md"]`), and adds it to the system
  prompt.
- It reads the file in the project root, plus a user-wide one at
  `~/.config/jane/JANE.md`.
- `instructions.filenames` is an ordered list, so it can be set to
  `["JANE.md", "AGENTS.md", "CLAUDE.md"]` to fall back to other tools' files.

### Slash commands (v1)

- `/clear`: start a fresh session
- `/model`: show or change the model
- `/permissions`: switch permission mode
- `/help`: list commands and keys
- `/exit`: quit (Ctrl+C twice also quits)

### Sessions

- Every message and tool call is appended to a JSONL file as it happens, so
  nothing is lost if Jane crashes.
- A resumed session restores the full conversation and the permission mode.

### Config (v1)

```toml
[model]
base_url = "http://127.0.0.1:8080/v1"
name = "qwen3.6-abliterated"
context_window = 65536
# api_key = ""   # only needed for servers that require one

[permissions]
default_mode = "always-ask"   # or "unrestricted"

[instructions]
filenames = ["JANE.md"]

[ui]
show_thinking = "collapsed"   # "full" | "collapsed" | "hidden"

[ui.colors]
user = "cyan"
assistant = "white"
thinking = "gray"
accent = "magenta"
diff_add = "green"
diff_remove = "red"
```

Colours accept names or hex (`#rrggbb`).

### Not in v1

Anything not listed above, including skills, `/compact`, checkpoints and
`/settings`. See the roadmap below.

## Roadmap (one branch and one PR each, roughly in this order)

Done:

1. ✅ **v1 core**: everything in the v1 spec (#3)
2. ✅ **`/settings` menu** (#4)
3. ✅ **Omarchy theme**: colours from `~/.local/state/omarchy/current/theme/colors.toml`, following theme changes (#5)
4. ✅ **Skills**: Jane, Claude Code and Omarchy skills, the `skill` tool, `/skills` and `/<skill-name>` (#6)
5. ✅ **Checkpoints and `/undo`** (#8)
6. ✅ **Block list** (#9)

Next:

7. ✅ **Context management**: `/compact`, plus automatic summarising when the
   context is nearly full
8. ✅ **Remote hosts**: use a stronger machine (the home PC) when it's
   reachable, and fall back to the laptop's local model when it isn't.
   - A list of hosts in the config, each with its own name, URL, model,
     context window and API key, in order of preference
   - At startup Jane quickly checks each host (about one second each) and
     uses the first that answers. The status line shows the host in use.
   - `/host` shows the hosts and whether they're reachable, and switches
     between them
   - If the host in use stops answering mid-session, Jane says so and falls
     back to the next reachable one. If the conversation is too big for the
     smaller context, it's compacted first (needs item 7).
   - When a preferred host comes back mid-session, Jane only says it's
     available; you switch with `/host`. It never switches back on its own,
     so the model doesn't change halfway through a task.
   - Scope: the home network. Jane only needs a URL. How it's reached (home
     Wi-Fi, Tailscale, a VPN) is set up outside Jane and out of scope; the
     README can mention it. The home server should require an API key
     (`llama-server --api-key`).
9. ✅ **Custom system prompt**: let the user replace Jane's built-in
   instructions (who Jane is, how she works) with their own text through a
   `prompt.file` setting, while Jane still adds the parts tools and skills
   depend on (environment, skills list, `JANE.md`). Plus `/prompt` to show
   the full prompt the model actually gets.
10. ✅ **Hooks**: run your own scripts before or after tool calls and at session
   start and end
11. ✅ **MCP servers**: use external tool servers
12. ✅ **Sub-agents**: let Jane hand tasks to helper agents that work in the
    background, each with its own conversation.
    - Run them on the other hosts: a background agent uses the first
      reachable host that isn't busy, and falls back to the laptop. A small
      machine can then run background work it couldn't handle alone.
    - Only the model's thinking runs on the host; its tool calls (reading,
      editing, running commands) still happen on the laptop, where the code
      is.
    - A llama-server with `--parallel 1` answers one request at a time, so the
      main conversation and an agent on the same host queue. Either keep the
      main conversation on the laptop, or start the host with `--parallel 2`
      (each slot then gets half the context).
13. ✅ **Web tools**: fetch pages and search the web. Off by default.
14. **Import Claude Code history**: convert Claude Code sessions into Jane
    sessions

## Workflow

- Repo: `github.com/bit-casper/jane` (public, MIT licence), with merged
  branches deleted automatically.
- Each change goes on its own branch from an up-to-date `main`, and is built,
  run and tested locally before a PR is opened.
- Each PR says what changed and how it was tested. Casper reviews and merges.
- After a merge: switch to `main`, pull, `git fetch --prune`, delete the
  branch.
