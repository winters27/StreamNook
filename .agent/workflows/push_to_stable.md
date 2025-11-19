---
description: Merge changes from dev to main and push to stable
---

1. Ensure you are on the `dev` branch and your working directory is clean.
   ```bash
   git checkout dev
   git status
   ```

2. Add and commit any pending changes on `dev`.
   ```bash
   git add .
   git commit -m "Update dev"
   ```

3. Switch to `main` and merge `dev`.
   ```bash
   git checkout main
   git merge dev
   ```

4. Push `main` to the remote repository (Stable).
   ```bash
   git push origin main
   ```

5. Switch back to `dev` to continue working.
   ```bash
   git checkout dev
   ```
