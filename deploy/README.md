# deploy/

- `seccomp-chromium.json` — seccomp profile that lets Chromium use its own sandbox inside a
  container (it needs user namespaces, which Docker's default profile blocks). Copied unchanged
  from the Playwright project (`utils/docker/seccomp_profile.json`, v1.56.1, Apache License 2.0,
  © Microsoft Corporation). Used by `docker-compose.yml` together with `BROWSER_SANDBOX=true`.
