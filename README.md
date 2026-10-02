# Assistant Fleet

A local TypeScript control plane for isolated deployments of
[`Rubiss-Projects/ai-assistant`](https://github.com/Rubiss-Projects/ai-assistant)

The React client and Node API create typed Slack or Discord tenant definitions,
render one hardened Compose project per tenant, and operate those projects through
the local Docker daemon. Copilot, Codex, and OpenCode remain independent provider
choices for either network adapter.

## Start with Docker Compose

Docker Engine with Compose v2 is required.

```bash
cp .env.console.example .env.console
# Add the environment-backed secret references your tenants will use.
docker compose up -d --build
```

Open <http://127.0.0.1:8080>. Override the host port when necessary:

```bash
FLEET_PORT=8090 docker compose up -d --build
```

The control-plane container mounts the Docker socket because it creates and
operates sibling tenant projects. It is deliberately published on localhost only.
Do not expose it directly to a network; put an authenticated reverse proxy in
front of it if remote administration is required. Tenant assistant and browser
containers never receive the Docker socket.

## Local development

Requires Node.js 22.14+ and Docker Compose.

```bash
npm install
npm run dev
```

The client runs on `http://127.0.0.1:5173` and proxies `/api` to the typed API on
port `8787`.

Quality checks:

```bash
npm run typecheck
npm run build
docker compose config --quiet
```

## What is operational

- Typed Slack and Discord creation flows with adapter-specific requirements
- Independent Copilot, Codex, and OpenCode provider configuration
- Runtime validation at the API boundary; `:latest` images are rejected
- Atomic state persistence in `data/state.json`
- Tenant files and revision history under `tenants/<slug>/`
- Generated assistant/browser Compose projects with dedicated named data volumes
- External secret-reference resolution without writing secret values to disk
- In-place migration support for existing data volumes, managed workspaces, auxiliary secret references, and tenant-local n8n intake relays
- Deploy, suspend, resume, verify, rollback, and container-log operations
- Immutable read-only knowledge snapshot mounts
- Read-only rendered skillset mounts at the provider-standard path
- Activity history, configuration editing, JSON export, and 15-second refresh

## Secret references

Secret values are never accepted by the tenant form. A tenant stores one of these
references instead:

- `secret://slack/acme/app-token` resolves from
  `FLEET_SECRET_SLACK_ACME_APP_TOKEN` in `.env.console`.
- `env://MY_EXISTING_VARIABLE` resolves directly from that process variable.
- `file:///run/secrets/acme-token` reads a file mounted through `secrets/`.

Only the resolved child `docker compose` process receives secret values. Generated
YAML and `deployment.json` retain placeholders/references. `.env.console`, runtime
state, rendered tenants, secret files, and promoted snapshots are ignored by Git.

## Fleet directories

```text
data/                         API state
tenants/<slug>/               deployment.json, prompt, Compose, revisions
rendered-skillsets/<slug>/    reviewed tenant skill bundle
repository-snapshots/         <repo>/releases/<exact-revision>/
secrets/                      optional local secret files
```

To mount knowledge, publish the exact snapshot directory first, then add the
repository and revision in the console. The API rejects missing or path-unsafe
snapshot references.

## API

The same-origin API exposes:

- `GET /api/health`, `GET /api/state`
- `POST /api/deployments`, `PUT /api/deployments/:id`
- `GET /api/deployments/:id/compose`, `GET /api/deployments/:id/logs`
- `POST /api/deployments/:id/repositories`
- `POST /api/deployments/:id/actions/{deploy|suspend|resume|verify|rollback}`

Set `FLEET_DOCKER_ENABLED=false` to exercise configuration and rendering without
allowing runtime Docker operations.
