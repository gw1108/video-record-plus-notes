# pipeline.py

`pipeline.py` orchestrates the full **refine → research → design → plan → implement** chain end-to-end so you don't have to copy file paths between stages by hand. It launches `claude` with the appropriate slash command for each stage, waits for the stage's DONE marker (or falls back to detecting the tagged output `.md`), then terminates that agent's whole process tree and feeds the output file path into the next stage.

**The pipeline is attended, not fire-and-forget.** Each stage inherits your terminal, and several stages are interactive by design: `/refine-research-question` iterates with you until it's clear what to research, `/create_design` asks you to pick between options when the trade-offs are genuinely unclear, and `/implement_plan` stops to ask how to proceed if reality doesn't match the plan. Stay near the terminal and answer when a stage asks.

## The five stages

| # | Stage | Slash command | Output |
|---|-------|---------------|--------|
| 1 | Refine the question | `/refine-research-question` | `thoughts/shared/questions/*.md` |
| 2 | Research the codebase | `/research-codebase` | `thoughts/shared/research/*.md` |
| 3 | Settle on a design | `/create_design` | `thoughts/shared/claude-code-design/*.md` |
| 4 | Write an implementation plan | `/create_plan` | `thoughts/shared/plans/*.md` |
| 5 | Execute the plan | `/implement_plan` | Code changes (runs to natural completion) |

## How auto-advance works

Each run gets a unique `RUN_ID` like `tag-a3b7c2`. The pipeline injects two instructions into every non-terminal stage prompt:

1. Embed the tag in the saved filename (via `create_thought.py`), so the pipeline can find the output file.
2. As the agent's **very last action** — after the output file is final — create an empty DONE marker file at the repo root named `.pipeline_done_<RUN_ID>`.

A background watcher polls for the DONE marker. As soon as it appears, the pipeline kills the agent's whole process tree (`taskkill /T /F` on Windows, `killpg` elsewhere — plain `terminate()` can orphan child processes) and starts the next stage with the tagged output file as input. If the tagged `.md` appears but the agent never writes the marker, the pipeline falls back to advancing after `DONE_FALLBACK_SECONDS` (60s). The marker file is deleted before each stage starts and after it's consumed.

Because the tag is unique per run, multiple pipelines can run concurrently without stepping on each other.

## Usage

```bash
# Full pipeline from a fresh question
python hack/pipeline.py "How would I add a lazy sundae mechanic?"

# Start mid-pipeline from an existing artifact (stage inferred from the path)
python hack/pipeline.py --from-file thoughts/shared/research/2026-04-30-ENG-tag-a3b7c2-lazy-sundae.md

# Resume an interrupted run
python hack/pipeline.py --resume tag-a3b7c2

# See what runs can be resumed
python hack/pipeline.py --list-runs
```

## State and recovery

Between stages, the pipeline writes `.pipeline_state_<RUN_ID>.json` at the project root containing the current stage index and input path. If a stage fails (Claude exits non-zero, or no tagged file appears in the expected directory), the pipeline prints the resume command and exits. The state file is deleted on successful completion of stage 5.

The final implement stage has no tagged `.md` output — it modifies code instead — so it runs to natural completion rather than being auto-terminated.

## Wizards (interactive, human-driven)

- `wizard-m2.3-youtube-live.sh [<session dir>]` — PLAN M2.3: manual unlisted YouTube upload of a report's `condensed.mp4` with the generated kit, `playtest-notion publish --youtube`, the three render checks; result in `out-m2/m2.3-result.txt`.
- `wizard-m2.4-youtube-api.sh` — PLAN M2.4: Google Cloud project, YouTube Data API v3, OAuth consent screen (External/Testing), Desktop OAuth client JSON → `%APPDATA%\playtest-recorder\youtube-client.json`, compliance-audit request.

Generated with the `/wizard` skill. Run `bash hack/<name>.sh` from PowerShell or Git Bash — from PowerShell `bash` is WSL's, and the wizard re-launches itself under Git Bash so it sees the Windows `node`/`python`. They never exit on a recoverable state: missing kit/build/credentials are generated or asked for, and failed commands offer retry/skip/abort. Ctrl-C and re-run resumes.
