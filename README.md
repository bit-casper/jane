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
```

| Key | Action |
|---|---|
| Enter | Send |
| Shift+Enter, `\` + Enter, Ctrl+J | New line |
| ↑ / ↓ | Previous prompts |
| Esc | Interrupt Jane |
| Shift+Tab | Switch permission mode |
| Ctrl+C | Clear the input, or press twice to quit |

Commands: `/clear`, `/model [name]`, `/permissions [mode]`, `/help`, `/exit`.

### Permission modes

- **always-ask** (default): reading and searching files happens without asking.
  Writing and editing files and running commands show what will happen and
  ask first.
- **unrestricted**: Jane runs every tool without asking.

### Project instructions

Put instructions for Jane in a `JANE.md` file in your project, and/or in
`~/.config/jane/JANE.md` for every project. The file names are configurable,
so Jane can also read `AGENTS.md` or `CLAUDE.md`.

## Configuration

`~/.config/jane/config.toml`, overridden per project by `.jane/config.toml`.
Every setting is optional; these are the defaults:

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

[ui]
show_thinking = "collapsed"   # "full" | "collapsed" | "hidden"

[ui.colors]                   # names ("cyan") or hex ("#88c0d0")
user = "cyan"
assistant = "white"
thinking = "gray"
accent = "magenta"
diff_add = "green"
diff_remove = "red"
```

## Where Jane keeps things

| What | Where |
|---|---|
| Sessions | `~/.local/share/jane/sessions/` |
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
