# Workspace Development Rules

## 🐙 Git Auto-Commit & Push Workflow

Whenever the agent finishes implementing a feature, resolving an issue, or completing a coding task, they must automatically follow this Git synchronization workflow before ending their turn:

1. **Staging & Safety Screening:**
   - Run `git add .` to stage changes (the `.gitignore` must be strictly followed).
   - Perform a safety check on all staged files to ensure no sensitive files (e.g., `.env`, keys, tokens, SQL backups) are staged. If any match, abort the commit and report the security warning.

2. **Commit Composition:**
   - Create a descriptive, professional, and concise commit message summarizing the changes (e.g., "Implemented background automation daemon", "Fixed TypeError crash in audit log handler", etc.).
   - Do NOT use generic messages like "update" or "changes".
   - Commit only if there are actual diff changes.

3. **Remote Push Sync:**
   - Push the local commits immediately to the remote branch `main` on GitHub:
     `https://github.com/qbuddie01-blip/LeanLife.git`
   - If the push fails because of authentication or connection errors, preserve the local commits and output the error logs without force-pushing.

## 🔒 Git Identity Rules

- **Git Author Identity Preservation:** Never override the Git author email or user name configuration dynamically during tasks or commits.
- **GitHub Verified Email Requirement:** Always use the GitHub verified user name (`qbuddie01-blip`) and noreply email (`qbuddie01-blip@users.noreply.github.com`) for all commits to prevent blocking deployments.
