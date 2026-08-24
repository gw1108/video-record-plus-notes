---
name: wizard
description: Generate an interactive bash wizard that walks a human through steps only they can perform. Use when provisioning infrastructure, setting up credentials or CI secrets, walking an unfamiliar third-party dashboard, or running a one-off migration or cutover. Don't invoke this for steps the agent can perform itself.
---

# Wizard

A **wizard** is a bash script that walks a human, step by step, through a manual procedure that's tedious to do by hand and tedious to re-explain to an AI every time. It opens each URL, says exactly what to click and copy, captures the values, writes them where they belong (`.env`, GitHub secrets), confirms at every stage, and shows how many stages are left. It might configure third-party services, run a one-off migration, or move the project from one state to another.

The delightful UX is already solved by [template.sh](template.sh): stage-by-stage progress, confirmation gates, cross-platform URL opening (including WSL), hidden secret entry, idempotent `.env` upserts, `gh secret`/`gh variable` writes, and a closing summary. **Your job is only to scope the procedure and author its stages.** The library above the `STAGES` marker is identical in every wizard; that consistency is the point: never hand-edit it.

A wizard is ephemeral by default: built for one run, saved to a scratch or `scripts/` path, deleted when the job's done. Commit it only when the user wants a repeatable setup path that should live in the repo.

## The hand-holding rule

The human runs a wizard so that they never have to think about what comes next. A wizard therefore **does everything it can and instructs everything it can't** — and it does not give up:

- **Never exit on a recoverable state.** A missing file, an empty `.env`, an unbuilt package, a wrong path, a badly pasted value, a failed command that can be retried: the wizard fixes it itself (run the build, generate the artifact, run the pipeline), or asks the human for what it needs and **loops until the check passes**. `exit 1` is reserved for a truly unexpected error the wizard cannot describe a fix for — and even then it prints what to do before exiting.
- **Fail forward, not early.** A precondition check is the start of a repair path, not a gate: `[[ -f x ]] || { warn …; exit 1; }` is wrong; `until [[ -f x ]]; do <make it or ask for it>; done` is right.
- **Ask for every input the wizard depends on**, in the stage that first needs it, with the reason ("stage 4 publishes to Notion, so we need the integration token now"). Credentials it depends on are asked with `ask_secret` and written with `write_env` — never merely "warned about".
- **Every prompt names the literal next action.** A stage that is only checks still ends with `pause "All checks passed; nothing to do here. Press Enter to open X (stage N)."` — never a bare `pause`, never a bare "Done?". The human must never have to guess whether they are supposed to act or just continue.
- **Re-runs must resume.** Values already saved are offered as defaults; completed artifacts (a downloaded file, a generated kit, a build) are detected and skipped, so Ctrl-C and re-run is always safe.
- **Say what is happening while a command runs**, show its output, and after a failure offer `retry / skip / abort` rather than bailing.
- **Windows:** in PowerShell, `bash` resolves to WSL's `bash.exe`, which cannot see Windows `node`/`python` and has no `cygpath`. The library re-launches itself under Git Bash when it detects that; tell the user the plain `bash hack/x.sh` command still works because of it. Convert every Windows path with `to_unix` before testing it, and print paths with `to_win` for the human.

## Process

### 1. Scope the procedure

Work out every manual step the human must take and every value that gets captured along the way. Read the repo first, don't ask cold:

- For setup: `.env`, `.env.example`, `.env.*`, `README`, `docker-compose*`, framework config, and `.github/workflows/*` (every `secrets.*` / `vars.*` reference is a value the wizard must produce).
- For a migration or transition: the current state, the target state, and the irreversible actions between them.

Then show the user the ordered list of stages and the values each produces, and confirm: they may add, drop, or reorder.

**Done when:** every stage is named in order, and for each captured value you know (a) where the human gets it, (b) where it's written (`.env`, a GitHub secret, both, or nowhere; some stages are pure actions), and (c) whether it's secret (hidden entry) or public.

### 2. Map each stage's journey

For each stage, write the precise path a human follows: which URL to open, what to do there, where a value is shown, which variable it fills: e.g. "Dashboard → Developers → API keys → Reveal test key → copy". Where you don't actually know the current UI or the exact command, say so and ask the user or check the docs: never invent steps that may not exist.

**Done when:** every stage traces to concrete instructions a stranger could follow.

### 3. Author the wizard

Copy `template.sh` to the target path. Replace the example stage with one `stage` per step, in dependency order. Use the library helpers: `stage`, `say`/`step`, `open_url`, `ask`/`ask_secret`, `write_env`, `set_secret`/`set_var`, `pause`/`confirm`. Set `TOTAL_STAGES` to the number of stages you wrote.

Hold the bar the template sets: open the URL before asking for its value, use `ask_secret` for anything secret, `write_env` every persisted value, `set_secret` only the values CI actually needs, and `confirm` before any irreversible action. Apply the hand-holding rule above to every precondition: use `require_file`/`require_cmd`-style `until` loops, `run_step` for commands (it offers retry/skip/abort), and `to_unix`/`to_win` for paths. Each `stage` clears the screen so only the current step is visible: keep a stage to one focused task so nothing the human needs scrolls away. Don't touch the library above the marker.

### 4. Verify and hand off

- `bash -n <script>`; run `shellcheck` if available.
- `chmod +x <script>`.
- Don't run it end-to-end yourself: it opens browsers and blocks on human input. Trace it statically instead: every value from step 1 is captured and lands where step 1 said, and every `set_secret` name exactly matches a `secrets.*` reference in CI.
- Tell the user how to run it. If it's a repeatable setup path, commit it and link it from the README so the next person runs the script instead of asking an AI.
