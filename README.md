# laex

Local Overleaf-style LaTeX editor, built for writing CVs with Claude. Left
half: source editor (top) and a real shell (bottom) for running `claude`.
Right half: live PDF, saved versions, job match and ATS checks.

```bash
npm install                     # also builds the frontend
bin/laex                        # opens laex/files as a Chrome app window
bin/laex ~/path/to/project      # or any other folder
```

Put it on your PATH with `ln -s "$PWD/bin/laex" ~/.local/bin/laex`, then run
`laex` (or `laex .` for the current directory). For a Dock app instead, see
[Desktop app](#desktop-app).

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
- **Edits from outside** (Claude, sed, git checkout) are picked up by a file
  watcher and shown as a diff to review: accept or reject each change, or all
  at once. This can be turned off in Settings, in which case clean files just
  update in place. If you had unsaved edits, a banner asks which version wins.
- **Errors** are listed above the PDF and underlined in the editor; click one
  to jump to the line. Overfull lines are underlined too.
- **SyncTeX both ways**: double-click the PDF to jump to the source, or use
  Show in PDF (Cmd+.) to jump from the cursor to the PDF.
- **PDF links** are clickable: web and mail links open in your browser, and
  links inside the document scroll to their target.
- **Zoom**: pinch, or two-finger swipe (up zooms out, down zooms in). Drag or
  Cmd+swipe to move the page. Swipe can be set back to scrolling in Settings.

## Versions

Save version (Cmd+Shift+S) keeps a named copy of every text file in the
project plus the built PDF. Rebuilding never creates a version; only saving
does. The Versions tab lists them, and Compare shows what changed since:

- **Source changes**, side by side, with unchanged lines folded away.
- **PDF changes**, both PDFs rendered page by page with changed areas
  outlined.

Restoring a version first saves your current files as a version, so a
restore can always be undone. Versions live in the project's `.laex/`
folder, which ignores itself in git.

## CV tools

- **Job match**: paste a job description. laex extracts its skills and
  keywords, checks them against the text of your PDF (with synonyms such as
  k8s and Kubernetes), and weights each by how often the description mentions
  it. From there you can make a tailored copy (`cv_company.tex`, set as the
  main document) or ask Claude to tailor it.
- **ATS text**: the text an applicant tracking system reads from your PDF,
  via `pdftotext` if installed (pdf.js otherwise), with checks for:
  - more pages than your limit (Settings, default 1)
  - lines running past the margin
  - headings that extract as split words (small caps: "P ROFILE")
  - ligatures that don't turn back into letters
  - missing email address or phone number
  - symbols some ATS drop
  - links that show only a word, not the address
  - PDF title and author metadata
  - spelling
  
  Page count and outstanding checks also show as tags in the status bar.
- **Spelling**: British English by default (American in Settings). Only
  prose is checked; commands, maths, URLs and the preamble are skipped.
  Common tech words are built in (`dict/tech-words.txt`), and your own words
  go in a personal dictionary at `~/.config/laex/dictionary.txt`. Select an
  underlined word for suggestions, Add to dictionary, or Ignore.
- **Download name**: set a pattern in Settings using `{name}`, `{company}`,
  `{main}` and `{date}`. The default, `{name} CV {company}`, gives
  `Your Name CV Monzo.pdf` for `cv_monzo.tex`.
- **Second document**: show another document next to the main one (Show,
  above the preview), for example a cover letter or another tailored CV.

## Editor

- **Sidebar tabs**:
  - **Files**: new file (a name without an extension gets `.tex`), new
    folder, rename (or F2), delete (moves to the Bin), and Main to choose
    which document gets built.
  - **Outline**: sections, roles and projects in the open file, with the
    one under the cursor highlighted.
  - **Search**: find and replace across files, with match case, whole word
    and regex.
  
  Cmd+B shows or hides the sidebar.
- **Snippets**: type `\` for completions, including every macro defined in
  your document (`\role`, `\company`, ...) with one field per argument.
- **Project folder**: click the folder name in the header to browse to
  another folder or pick a recent one. The terminal restarts there.
- **Themes**: dark, or light (GOV.UK as it ships), in Settings.

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

**Ask Claude** (Cmd+K, above the editor) sends a ready-made request about
the selection or the line under the cursor. Options include improve this
bullet, make it shorter, suggest a metric, British spelling and tone, fix the
build errors, fit it on one page, review the whole CV, tailor to the job
description, or anything you type. If Claude is already running in the
terminal, the request is sent to it. If the terminal is at a shell prompt,
Claude is started with it. If the terminal is running something else, laex
leaves it alone.

For zsh, laex sets `ZDOTDIR` to `shim/zsh`, which runs your own startup files
and then puts `shim/` first on PATH. Outside laex, `claude` is unchanged.

## Shortcuts

All of these can be changed in Settings > Shortcuts (select a box and press
the new keys). They work from the editor and the terminal.

| Default | Action |
| --- | --- |
| Cmd+Enter | Recompile |
| Cmd+S | Save and recompile |
| Cmd+Shift+S | Save version |
| Cmd+D | Download PDF |
| Cmd+K | Ask Claude |
| Cmd+. | Show in PDF |
| Cmd+Shift+F | Find in files |
| Cmd+B | Show or hide sidebar |
| Cmd+1 / Cmd+2 | Focus editor / terminal |

Fixed: Shift+Enter in the terminal sends a newline to Claude. Double-click
the PDF to jump to the source line. Double-click a divider to reset the split.

## Desktop app

`desktop/` wraps laex in Electron: its own window, Dock icon and menus
(File > Open Folder, Cmd+O). It runs the laex server with Electron's built-in
Node, so it works when launched from Finder.

```bash
cd desktop
npm install
npm start                       # run it
npm run package                 # build desktop/dist/LAEX-darwin-arm64/LAEX.app
```

The packaged app runs the checkout it was built from, so pulling updates here
updates the app. Rebuild it only if you move the checkout.

## Security

The server runs a shell, so it binds to `127.0.0.1` only, rejects requests
whose `Host` isn't localhost (DNS rebinding), and rejects writes and
WebSocket connections from any other origin. File access is confined to the
project directory. Ask Claude only ever types into a shell prompt or a
running Claude.

## Settings

`LAEX_PORT` (default 4777; the next free port is used if it's taken).
Everything else is in the Settings menu:

- **Per project**: main document, engine (pdfLaTeX / XeLaTeX / LuaLaTeX),
  refresh interval, dark PDF and text sizes.
- **Global**: page limit, download name, spelling, theme, Claude options and
  shortcuts.
