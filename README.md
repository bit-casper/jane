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

Commands: `/clear`, `/model [name]`, `/permissions [mode]`, `/settings`, `/skills`, `/<skill> [request]`, `/undo`, `/help`, `/exit`.

### Permission modes

- **always-ask** (default): reading and searching files happens without asking.
  Writing and editing files and running commands show what will happen and
  ask first.
- **unrestricted**: Jane runs every tool without asking.

### Undo

Before Jane writes or edits a file, it saves a copy. `/undo` lists Jane's
changes, newest first; pick one to undo it and every change after it. If a file
was changed after Jane's edit (by you or a command), Jane asks before
overwriting it. Jane also tells the model about the undo, so it doesn't redo
the change on its own. Undo works after `--resume` too. Changes made by `bash`
commands can't be undone. Turn it off with `checkpoints.enabled = false`.

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

[checkpoints]
enabled = true                # save a copy before each write/edit, for /undo

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
