# Minecraft LLM-Agent (PC Server + 5 Pi Bots)

TypeScript implementation of a planner/executor Minecraft automation stack:

- Windows PC hosts Paper `1.20.4` server (NSSM service)
- Raspberry Pi 5 runs one orchestrator process with 5 headless Mineflayer bots
- Gemini (Vertex AI) provides high-level per-bot subgoal plans
- Deterministic skills execute all gameplay actions with typed failures

## Core Design

- LLM chooses intent only; code performs execution.
- Planner calls are event-driven (completion/failure/interrupt) instead of tick-driven.
- Skill results are always `SUCCESS` or typed failure codes.
- Strict JSON schema validation gates all planner input/output.
- Every build intent uses agent-generated blueprints; stock templates are disabled.

## Project Layout

- `apps/orchestrator`: runtime orchestrator service
- `contracts`: schemas and shared contracts
- `blueprints`: generated design artifacts and design output directory
- `infra/windows`: Paper + NSSM setup
- `infra/pi`: systemd service + environment template

## Quick Start (Development)

1. Install Node 20 and npm (pnpm also works).
2. Copy orchestrator env:
   - `cp apps/orchestrator/.env.example apps/orchestrator/.env`
3. Set required Vertex fields (`GEMINI_PROJECT_ID`, location/model).
4. Install dependencies from repo root:
   - `npm install`
5. Run tests:
   - `npm test`
6. Start orchestrator:
   - `npm run dev`

## Production Ops

### Windows Server

- Install Paper with `infra/windows/install-paper.ps1`
- Apply `infra/windows/server.properties`
- Install NSSM service with `infra/windows/install-nssm-service.ps1`

### Raspberry Pi

- Deploy repo to your chosen deploy root (for example `mc`).
- Copy env template:
  - `cp infra/pi/mc-orchestrator.env.example <system-env-file>`
- Install service:
  - `sudo infra/pi/install-service.sh`

## Contracts

- Snapshot schema: `contracts/snapshot.schema.json`
- Planner schema: `contracts/planner.schema.json`
- Skill types/failure codes: `contracts/skills.ts`
- Event contracts: `contracts/events.ts`

## Metrics and Logs

- Metrics endpoint: `http://<pi-host>:9464/metrics`
- Health endpoint: `http://<pi-host>:9464/healthz`
- JSONL logs: `LOG_DIR/*.jsonl`
- SQLite state: `SQLITE_FILE`

## Current Scope

Implemented milestone path through M1-M5 scaffolding:

- Multi-bot lifecycle and reconnect logic
- Planner loop with Vertex Gemini + hard caps/backoff/fallback
- Lock arbitration and explorer concurrency limits
- Deterministic skill registry and typed failure pipeline
- Automatic blueprint design flow for all `build_blueprint` subgoals
- Deployment assets for Windows/NSSM and Pi/systemd
