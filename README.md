# sigapp-supabase-to-firebase-migration

A small tool to migrate data from Supabase (Postgres) to Firestore.

This README shows the minimal steps for a developer to clone, configure, and run the migration.

## Requirements

- Bun 1.2.20+
- Firebase project and service account key (JSON)

## Quick start

1. Clone

```powershell
git clone <repo-url>
cd sigapp-supabase-to-firebase-migration
```

1. Install dependencies

```powershell
npm install
```

1. Configure credentials (crucial: create a `.env`)

Create a `.env` file in the project root. The migration scripts read configuration and secrets from environment variables, so without a `.env` the scripts cannot authenticate or run.

Minimum variables to include:

- `FIREBASE_SERVICE_ACCOUNT_PATH` — path to your Firebase service account JSON (example: `./sigapp-dev-firebase-adminsdk.json`)
- `SUPABASE_URL` — your Supabase project URL (only required if running Supabase reads)
- `SUPABASE_SERVICE_ROLE_KEY` — service role key for Supabase (only required if running Supabase reads)
- Optional operational variables: `MIGRATE_SINCE`, `PAGE_SIZE`, `CONCURRENCY`, `STRUCTURE_MODE`, `DRY_RUN`

Example `.env` (keep secrets out of git):

```properties
FIREBASE_SERVICE_ACCOUNT_PATH=./sigapp-dev-firebase-adminsdk.json
SUPABASE_URL=https://your-supabase-url.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
# Optional:
MIGRATE_SINCE=2025-01-01T00:00:00Z
PAGE_SIZE=500
CONCURRENCY=20
STRUCTURE_MODE=embedded
DRY_RUN=true
```

Security notes:

- Do NOT commit `.env` or your Firebase JSON to the repository. Add them to `.gitignore`.
- Treat `SUPABASE_SERVICE_ROLE_KEY` and the Firebase JSON as secrets.

1. Verify Firestore connection

```powershell
# Quick test that validates the connection
$env:FIREBASE_SERVICE_ACCOUNT_PATH = 'sigapp-dev-firebase-adminsdk.json'; npx ts-node test-firestore.ts
```

1. Run migration

- Dry run (does not write to Firestore) — always test first:

```powershell
$env:DRY_RUN = 'true'; npx ts-node main.ts
```

- Real migration (example using STRUCTURE_MODE):

```powershell
$env:DRY_RUN = 'false'; $env:STRUCTURE_MODE = 'embedded'; npx ts-node main.ts
```

## Useful files

- `main.ts` — migration entry script
- `test-firestore.ts` — small connection test
- `checkpoint.json` — resume state for the migration
- `failed.jsonl` — failure logs (if any)

## Quick tips

- Inspect Dry Run output carefully before running for real.
- Use `checkpoint.json` and `failed.jsonl` to resume or debug.
- Adjust concurrency or logging via environment variables (e.g. `CONCURRENCY`, `DEBUG_LIMIT`) if the project supports them.

If you want, I can add a `.env.example` or document the exact environment variables `main.ts` reads.
