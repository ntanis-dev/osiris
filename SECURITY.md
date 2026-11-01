# Security policy

Please report suspected vulnerabilities privately through GitHub's private vulnerability reporting for this repository. Do not open a public issue containing exploit details, credentials, private data, or an unpatched proof of concept.

Include the affected version or commit, impact, reproduction conditions, and the smallest safe evidence needed to investigate. ntanis.dev will validate the report, coordinate a fix, and publish remediation information when users can act on it.

Osiris never reads, copies or stores a credential and sends nothing anywhere: it reads Claude Code's hook events and transcripts on your own computer, writes only to `~/.osiris` (and its hooks to `~/.claude/settings.json`), and starts `claude` or `baton` with arguments it checks first. If you think a transcript, a folder name or a title can make it run something else, that is exactly the kind of report we want.

Only the latest code on the default branch is supported during pre-release development.
