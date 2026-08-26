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
