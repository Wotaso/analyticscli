# @prodinfos/cli

Agent-friendly CLI for querying analytics, exporting events, and working with project-scoped read access in Prodinfos.

Current npm release channel: preview / experimental beta.
If no stable release exists yet, `latest` points to the newest preview.
Once stable releases exist, `latest` is pinned to the newest stable.

## Install

Global install (recommended for daily usage):

```bash
npm install -g @prodinfos/cli@preview
```

One-off usage without global install:

```bash
npx -y @prodinfos/cli@preview --help
```

When stable releases are available, install without a tag:

```bash
npm install -g @prodinfos/cli
```

## Quick Start

You need:

- a `readonly_token` (read-only CLI scope)
- a `project_id` (from `prodinfos projects list`)

Interactive setup (recommended):

```bash
prodinfos onboard
```

Non-interactive login:

```bash
prodinfos login --readonly-token <readonly_token>
```

Then run your first queries:

```bash
prodinfos projects list
prodinfos schema events --project <project_id>
prodinfos funnel --project <project_id> --steps onboarding:start,onboarding:complete --last 30d
prodinfos timeseries --project <project_id> --metric event_count --interval 1d --last 30d --viz table
prodinfos generic --project <project_id> --metric event_count --group-by day,eventName --last 30d
```

## Common Commands

### Core analytics

```bash
prodinfos funnel --project <project_id> --steps onboarding:start,onboarding:complete --last 30d
prodinfos conversion-after --project <project_id> --from onboarding:start --to purchase:success --last 30d
prodinfos retention --project <project_id> --anchor-event onboarding:start --days 1,7,30 --last 30d
prodinfos survey --project <project_id> --last 30d
```

### Flexible grouped query

```bash
prodinfos generic \
  --project <project_id> \
  --metric event_count \
  --group-by day,eventName,country \
  --events onboarding:start,onboarding:complete \
  --last 30d \
  --order-by value_desc
```

### Event export

```bash
prodinfos events months --project <project_id> --year 2026
prodinfos events export --project <project_id> --year 2026 --month 2 --out ./events-2026-02.csv
prodinfos events export-range --project <project_id> --last 90d --out ./events-last-90d.csv
```

### Feedback export

```bash
prodinfos feedback export --project <project_id> --last 30d --limit 100
```

## Output Modes

Use `--format json` for scripts/agents and `--format text` for local reading.

Examples:

```bash
prodinfos projects list --format json
prodinfos timeseries --project <project_id> --metric event_count --last 7d --format text
```

Global options available on all commands:

- `--api-url <url>` override API base URL
- `--token <token>` override stored token for one command
- `--format json|text` choose output mode
- `--include-debug` include debug/dev data on supported reads
- `--quiet` reduce text output noise

## Authentication Notes

- `readonly_token` is for query/export usage.
- It is different from SDK write keys used for event ingestion.
- `prodinfos setup` and `prodinfos onboard` can also install public skills:
  - `prodinfos-cli`
  - `prodinfos-ts-sdk`

## Releases

Versioning is managed in the private monorepo via Changesets.
Every CLI change should include a changeset entry (`pnpm changeset`), and CI creates
the release version PR (`chore(release): version cli`) automatically on `main`.

After that release PR is merged, the public mirror repository can run `Release to npm`.
Each successful run creates or updates the matching GitHub Release
(`v<package.json version>`) and links to the published npm version.

Source of truth for this package is the private monorepo path `apps/cli`.
Public mirror source prefix: `apps/cli`.
