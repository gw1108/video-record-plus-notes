# Lessons

Running tally of non-obvious repository gotchas. Entries are promoted by `python hack/lessons.py` after three sightings.

### Gitignore does not support trailing inline comments
_seen: 1 · home: .claude/docs/repository-hygiene.md_
Put an explanatory comment on its own line before an ignore pattern. Text after a pattern is treated as part of the pattern, so a line such as `artifact/ # explanation` does not ignore `artifact/`.

### A non-pure wheel relocates packages under the data scheme
_seen: 1 · home: .claude/docs/python-packaging.md_
Setting `root_is_pure = False` causes wheel to archive Python packages under `<distribution>.data/purelib/` instead of their direct package paths. When a release criterion requires direct archive entries but bundled package data is platform-specific, keep the purelib install scheme and set an explicit platform wheel tag.

### Reconfigure Windows verification-script stdout before echoing captured Unicode
_seen: 1 · home: .claude/docs/windows-verification.md_
A parent Python verification script can capture UTF-8 CLI output successfully and then fail while printing arrows or section symbols through a cp1252 console. Reconfigure `sys.stdout` to UTF-8 with replacement before printing captured output so the harness does not mask the product command's result.

### Windows PowerShell 5.1 lacks newer static hash and hex helpers
_seen: 1 · home: .claude/docs/windows-verification.md_
Windows PowerShell 5.1 on supported Windows hosts does not provide `SHA256.HashData` or `Convert.ToHexString`. For verification scripts that must run before PowerShell 7 is installed, use `SHA256.Create().ComputeHash(...)` and `BitConverter.ToString(...).Replace("-", "")` instead.

### Bind resumable machine acceptance and human confirmation together
_seen: 1 · home: .claude/docs/windows-verification.md_
When evidence needs both machine validation and human visual confirmation, persisting only the machine acceptance creates an interruption gap: resume can accidentally promote an unconfirmed artifact. Persist a separate host-only confirmation bound to the run, criterion, manifest/helper identities, and artifact hash, and require both records on resume and final validation.

### Split dependent Bash local assignments under nounset
_seen: 2 · home: .claude/docs/shell-wizards.md_
With `set -u`, a declaration such as `local source="$1" partial="${source}.part"` expands every right-hand side before the `local` command runs, so `source` is unbound and the script crashes. Declare the dependent local first, then assign it on a separate command. `bash -n` cannot catch this — fixing one instance is not enough; grep every `local` line for a name it also references, and cover the functions with a runtime test that sources them under `set -u` with their dependencies stubbed.

### Validate resumable trees below their top-level directories
_seen: 1 · home: .claude/docs/shell-wizards.md_
Checking only that a run root and its immediate writable directories are not links still lets a nested symbolic link or Windows junction redirect later writes outside the run. Walk the complete selected run without traversing reparse points before any resume write, reject the run on links or scan errors, and use replace-via-rename for generated files so the write primitive does not follow an existing destination link.

### A class rule on a log line outranks the UA `[hidden]` rule
_seen: 1 · home: .claude/docs/renderer-ui.md_
`#log .line { display: block; }` has higher specificity than the user-agent `[hidden] { display: none }`, so setting `el.hidden = true` marks the element hidden in the DOM while it stays fully visible on screen. Any filter built on `.hidden` needs its own `[hidden] { display: none }` rule at matching specificity, and the test must assert on `getComputedStyle(el).display`, not on `el.hidden` — the property assertion passes while the pane visibly shows every line.

### Top-level `await app.whenReady()` hangs an Electron ESM entry forever
_seen: 1 · home: .claude/docs/electron-harnesses.md_
In a `.mjs` main entry (`npx electron harness.mjs`), a top-level `await` before `app.whenReady()` resolves means `ready` never fires: the process sits at 100% idle with no output and no exit until it is killed. Put everything async inside `app.whenReady().then(main)` instead. The module body itself does run, so a marker written before the await proves the entry loaded and the hang is the await.

### Electron's stdout never reaches the parent shell on Windows
_seen: 1 · home: .claude/docs/electron-harnesses.md_
`electron.exe` is linked as a GUI-subsystem binary, so `console.log` from the main process is dropped when stdout is a pipe or a redirect — `npm run smoke` and any harness look silent even on success, and exit code is the only signal. Harnesses must write their report to a file (`verification/evidence/<name>.txt`) rather than to stdout.

### Never drive the real app with synthetic input against real data
_seen: 1 · home: .claude/docs/windows-verification.md_
Scripted `mouse_event` clicks at fixed screen coordinates keep firing while the app re-renders underneath them, so one intended click became six and moved six real session folders in `~/Videos/PlaytestSessions` to the Recycle Bin. Screenshot with `PrintWindow(hwnd, hdc, 2)` — it captures an occluded window's content and needs no focus or clicks. When a click genuinely has to be simulated, first point the app at a throwaway data directory. (Recovery, if it happens: each `C:\$Recycle.Bin\<SID>\$I<id>` file holds the original path as UTF-16LE at offset 28 with its length at offset 24; rename the matching `$R<id>` back and unlink the `$I`.)

### Heredocs through the Bash tool collapse a doubled backslash to a single one
_seen: 1 · home: .claude/docs/agent-tooling.md_
Even a quoted heredoc (`cat > f <<'EOF'`) halves a doubled backslash on the way to disk, so a JS literal written with an escaped backslash before `$Recycle.Bin` lands with a bare one — which JS then reads as the drive-relative `C:$Recycle.Bin`, and the failure surfaces as a confusing `ENOENT ... scandir 'C:\<cwd>\$Recycle.Bin'`. This corrupts silently: the script parses and runs, it just points somewhere else. Use forward slashes in Windows paths (Node accepts them), or write the file with the Write tool, which does no escaping. Verify what actually landed with `grep -n <pattern> <file> | cat -A`, not by re-reading your own heredoc.

### A wizard helper borrowed from another wizard must be copied, not just called
_seen: 1 · home: .claude/docs/shell-wizards.md_
Only the code above the `STAGES` marker is the shared wizard library; helpers such as `to_clip` live in one wizard's own stages section. Calling one in a new wizard without pasting its definition passes `bash -n` (an unknown command is valid syntax) and then aborts mid-run under `set -e` with `to_clip: command not found`, after the human has already done several irreversible browser steps. Before writing a stage, grep the file itself for every helper it calls.

### `explorer.exe URL` is the wrong way to open a browser from Git Bash
_seen: 1 · home: .claude/docs/shell-wizards.md_
Explorer only hands its argument to the shell's URL handler when it cannot read it as a path, so it often just opens a folder window instead of the browser, and it exits 1 whether it succeeded or failed — an `|| warn` fallback fires on every call. Use `URL="$url" WSLENV=URL powershell.exe -NoProfile -NonInteractive -Command 'Start-Process $env:URL'` instead: it returns a real exit status, and the env-var handoff keeps `&` and `?` in query strings intact without any quoting.

### Never edit a shell script while a human is running it
_seen: 1 · home: .claude/docs/shell-wizards.md_
Bash reads a script incrementally by byte offset, so an edit above the currently executing line shifts everything under the interpreter and the run dies with a bogus `syntax error near unexpected token` pointing at a line that is perfectly valid on disk. A wizard is exactly the case where this bites, since the human sits at a prompt for minutes at a time. Wait for the run to end (or have them Ctrl-C) before patching, and re-run from the top afterwards.
