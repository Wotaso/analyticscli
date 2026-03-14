# analyticscli

Agent-friendly CLI for querying analytics, exporting events, and working with project-scoped read access in AnalyticsCLI.

Using a coding agent: you can let it handle CLI setup, auth, and query workflows end-to-end with the AnalyticsCLI skills repo:
https://github.com/Wotaso/analyticscli-skills

The same skills can also be used with OpenClaw.

Current npm release channel: preview / experimental beta.
If no stable release exists yet, `latest` points to the newest preview.
Once stable releases exist, `latest` is pinned to the newest stable.

## Skills

Available AnalyticsCLI skills:

- [`analyticscli-cli`](https://github.com/Wotaso/analyticscli-skills/tree/main/skills/analyticscli-cli): CLI setup, auth, query workflows, exports
- [`analyticscli-ts-sdk`](https://github.com/Wotaso/analyticscli-skills/tree/main/skills/analyticscli-ts-sdk): SDK integration/upgrades for JS/TS, React Native, Expo

## Install

Global install (recommended for daily usage):

```bash
npm install -g @analyticscli/cli@preview
```

One-off usage without global install:

```bash
npx -y @analyticscli/cli@preview --help
```

When stable releases are available, install without a tag:

```bash
npm install -g @analyticscli/cli
```

## Quick Start

You need:

- a `readonly_token` (read-only CLI scope)
- a `project_id` (from `analyticscli projects list`)

Interactive setup (recommended):

```bash
analyticscli onboard
```

Non-interactive login:

```bash
analyticscli login --readonly-token <readonly_token>
```

Then run your first queries:

```bash
analyticscli projects list
analyticscli schema events --project <project_id>
analyticscli funnel --project <project_id> --steps onboarding:start,onboarding:complete --last 30d
analyticscli timeseries --project <project_id> --metric event_count --interval 1d --last 30d --viz table
analyticscli generic --project <project_id> --metric event_count --group-by day,eventName --last 30d
```

## Common Commands

### Core analytics

```bash
analyticscli funnel --project <project_id> --steps onboarding:start,onboarding:complete --last 30d
analyticscli conversion-after --project <project_id> --from onboarding:start --to purchase:success --last 30d
analyticscli retention --project <project_id> --anchor-event onboarding:start --days 1,7,30 --last 30d
analyticscli survey --project <project_id> --last 30d
```

### Flexible grouped query

```bash
analyticscli generic \
  --project <project_id> \
  --metric event_count \
  --group-by day,eventName,country \
  --events onboarding:start,onboarding:complete \
  --last 30d \
  --order-by value_desc
```

### Event export

```bash
analyticscli events months --project <project_id> --year 2026
analyticscli events export --project <project_id> --year 2026 --month 2 --out ./events-2026-02.csv
analyticscli events export-range --project <project_id> --last 90d --out ./events-last-90d.csv
```

### Feedback export

```bash
analyticscli feedback export --project <project_id> --last 30d --limit 100
```

## Output Modes

Use `--format json` for scripts/agents and `--format text` for local reading.

Examples:

```bash
analyticscli projects list --format json
analyticscli timeseries --project <project_id> --metric event_count --last 7d --format text
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
- `analyticscli setup` and `analyticscli onboard` can also install public skills:
  - `analyticscli-cli`
  - `analyticscli-ts-sdk`

## Releases

Versioning is managed in the private monorepo via Changesets.
Every CLI change should include a changeset entry (`pnpm changeset`), and CI creates
the release version PR (`chore(release): version cli`) automatically on `main`.

After that release PR is merged, the public mirror repository can run `Release to npm`.
Each successful run creates or updates the matching GitHub Release
(`v<package.json version>`) and links to the published npm version.

Source of truth for this package is the private monorepo path `apps/cli`.
Public mirror source prefix: `apps/cli`.
