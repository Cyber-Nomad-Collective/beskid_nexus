# GitHub Actions (disabled)

CI moved to **Drone** — see [`.drone.yml`](../.drone.yml) and [beskid_infra](https://github.com/Cyber-Nomad-Collective/beskid_infra).

| Former workflow | Replaced by |
|-----------------|-------------|
| `ci.yml` | `.drone.yml` → `nexus-image` (GHCR push on `main`/`staging`) |
| `docker-smoke.yml` | Local `docker compose` / post-deploy smoke |
