# laex

Local Overleaf-style LaTeX editor. Left half: source editor (top) and a real
shell (bottom) for running `claude`. Right half: live PDF.

```bash
npm install                     # also builds the frontend
bin/laex                        # opens laex/files as a Chrome app window
bin/laex ~/path/to/project      # or any other folder
```

Put it on your PATH with `ln -s "$PWD/bin/laex" ~/.local/bin/laex`, then run
`laex` (or `laex .` for the current directory).

## How it works

- **Build**: `latexmk` with SyncTeX. Output goes to `~/Library/Caches/laex/`,
  so nothing is written into your project except your own edits.
- **Auto-refresh** (header checkbox, on by default): every second, unsaved
  edits are saved and the main document is rebuilt if anything changed.
  The interval is in Settings.
- **Terminal**: one persistent login shell per server, so a `claude` session
  survives a page reload. It uses the font and colours from your
  `~/.config/kitty/kitty.conf` (kitty's defaults otherwise). Shift+Enter sends
  a newline to Claude.
- **Edits from the terminal** (Claude, sed, git checkout) are picked up by a
  file watcher: clean buffers update in place, keeping your cursor; if you had
  unsaved edits you get a banner to choose which version wins.
- **Errors** are listed above the PDF; click one to jump to the line.
  Double-click the PDF to jump to the matching source line.

- **Files panel**: new file (a name without an extension gets `.tex`), new
  folder, rename (or F2), delete (moves to the Bin, so it can be recovered),
  and "Main" to choose which document gets built. Cmd+B shows or hides it.
- **Project folder**: click the folder name in the header to browse to
  another folder or pick a recent one. The terminal restarts there.
- **PDF links** are clickable: web and mail links open in your browser, and
  links inside the document scroll to their target.

## Claude

Type `claude` in the terminal pane (or click "Run claude"). In laex's shell,
`claude` is `shim/claude`, which starts the real Claude Code with:

- a `UserPromptSubmit` hook (`shim/claude-context-hook`) that, before every
  message, tells Claude the file you have open, your cursor line, any selected
  text, the surrounding lines and the last build result. So "tighten this
  bullet" means the bullet under your cursor.
- the resume-editor system prompt, `~/.config/laex/resume-editor.md`. This
  is seeded from `prompts/resume-editor.md`. Edit it from Settings, turn it
  off there, or reset it to the default. Changes apply the next time `claude`
  starts.

For zsh, laex sets `ZDOTDIR` to `shim/zsh`, which runs your own startup files
and then puts `shim/` first on PATH. Outside laex, `claude` is unchanged.

## Shortcuts

All of these can be changed in Settings > Shortcuts (select a box and press
the new keys). They work from the editor and the terminal.

| Default | Action |
| --- | --- |
| Cmd+Enter | Recompile |
| Cmd+S | Save and recompile |
| Cmd+D | Download PDF |
| Cmd+B | Show or hide files |
| Cmd+1 / Cmd+2 | Focus editor / terminal |

Fixed: Shift+Enter in the terminal sends a newline to Claude. Double-click
the PDF to jump to the source line. Double-click a divider to reset the split.

## Security

The server runs a shell, so it binds to `127.0.0.1` only, rejects requests
whose `Host` isn't localhost (DNS rebinding), and rejects writes and
WebSocket connections from any other origin. File access is confined to the
project directory.

## Settings

`LAEX_PORT` (default 4777; the next free port is used if it's taken).
Main document, engine (pdfLaTeX / XeLaTeX / LuaLaTeX), refresh interval, dark
PDF and text sizes are in the Settings menu and remembered per project.

