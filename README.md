# analyticscli

Agent-friendly CLI for querying analytics, exporting events, and working with account-wide read access in AnalyticsCLI.

Using a coding agent: you can let it handle CLI setup, auth, and query workflows end-to-end with the AnalyticsCLI skills repo:
https://github.com/Wotaso/analyticscli-skills

The same skills can also be used with OpenClaw.

## Skills

Available AnalyticsCLI skills:

- [`analyticscli-cli`](https://github.com/Wotaso/analyticscli-skills/tree/main/skills/analyticscli-cli): CLI setup, auth, query workflows, exports
- [`analyticscli-ts-sdk`](https://github.com/Wotaso/analyticscli-skills/tree/main/skills/analyticscli-ts-sdk): SDK integration/upgrades for JS/TS, React Native, Expo
- ClawHub: `openclaw-growth-engineer` is the canonical published skill

## Run With npx

No global install is required:

```bash
npx @analyticscli/cli onboard
```

Optional global install for daily usage:

```bash
npm install -g @analyticscli/cli
```

## Quick Start

You need:

- a `readonly_token` (private read-only CLI scope)
- a `project_id` (from `analyticscli projects list`)

Interactive setup (recommended):

```bash
npx @analyticscli/cli onboard
```

`onboard` installs agent skills and then asks whether to connect CLI query access. Paste a readonly CLI token from **Dashboard -> API Keys**, keep an existing stored token, or skip login and run `analyticscli login` later.

Login only:

```bash
npx @analyticscli/cli login
```

Then run your first queries:

```bash
npx @analyticscli/cli projects list
npx @analyticscli/cli schema events --project <project_id>
npx @analyticscli/cli funnel --project <project_id> --steps onboarding:start,onboarding:complete --last 30d
npx @analyticscli/cli timeseries --project <project_id> --metric event_count --interval 1d --last 30d --viz table
npx @analyticscli/cli generic --project <project_id> --metric event_count --group-by day,eventName --last 30d
```

Create a project without copying an admin token into your terminal:

```bash
analyticscli projects create \
  --name "My App" \
  --env-file .env.local \
  --env-name EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY
```

The CLI opens a one-time dashboard approval page, creates the project, selects it as the default,
stores a refreshed account-wide readonly token in the system keychain (or a `0600` config fallback),
and writes the publishable SDK key to the requested local env file. The short-lived project-admin
token is never accepted as a CLI flag and is discarded after setup.

## Troubleshooting Empty States

No projects listed (`analyticscli projects list` returns empty):

1. Run `analyticscli projects create --name "My App"` and approve the one-time browser prompt.
2. The new project is selected automatically; run `analyticscli projects list` to verify it.

Project exists but no events yet (`analyticscli schema events --project <project_id>` returns empty):

1. Integrate `@analyticscli/sdk` in your app codebase.
2. Initialize SDK with your project publishable API key from **Dashboard -> API Keys**.
3. Emit at least one event from the app.
4. Re-run `analyticscli schema events --project <project_id> --last 14d`.

## Common Commands

### Core analytics

```bash
analyticscli funnel --project <project_id> --steps onboarding:start,onboarding:complete --last 30d
analyticscli conversion-after --project <project_id> --from onboarding:start --to purchase:success --last 30d
analyticscli retention --project <project_id> --anchor-event onboarding:start --days 1,7,30 --last 30d
analyticscli survey --project <project_id> --last 30d
```

`retention` defaults to stable identity, so ephemeral/unknown SDK identities from users without full-tracking consent are excluded from multi-day D1/D7/D30 reads. Use `--identity-quality all` only when you intentionally want the noisy diagnostic view.

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

### Product feedback

```bash
ANALYTICSCLI_CLI_ENABLE_WRITE_COMMANDS=true analyticscli feedback submit --message "Session detail view needs raw JSON" --category feature --context "dashboard/settings"
```

## Optional CLI Self-Tracking

CLI self-tracking is disabled by default and is intended for internal dogfooding only:

```bash
ANALYTICSCLI_SELF_TRACKING_ENABLED=true analyticscli projects list
```

When enabled, the CLI sends command lifecycle events such as `cli:command_started`,
`cli:command_succeeded`, and `cli:command_failed` to `/v1/telemetry/cli` using the
current CLI bearer token. Keep payloads command-level only; do not include command
arguments, query output, tokens, file paths, or exported data.

For public developer installs, leave self-tracking off unless you provide clear
notice and have a valid legal basis for the telemetry.

## Output Modes

Use `--format json` for scripts/agents and `--format text` for local reading.

Query commands include a confidence/sample-size hint:

- `matchedRecords` in JSON output
- `matched records: ...` in text summaries

Examples:

```bash
analyticscli projects list --format json
analyticscli timeseries --project <project_id> --metric event_count --last 7d --format text
```

Global options available on all commands:

- `--api-url <url>` override API base URL for staging/local development
- `--readonly-token <token>` override stored readonly token for one command
- `--format json|text` choose output mode
- `--include-debug` include debug/dev data on supported reads
- `--quiet` reduce text output noise

## Authentication Notes

- `readonly_token` is the canonical name for CLI/query/export usage.
- It is different from the publishable SDK key used for event ingestion.
- `analyticscli setup` and `analyticscli onboard` can install `analyticscli-cli` and `analyticscli-ts-sdk` for Codex/Claude Code. When `--agents openclaw` is selected, they install the canonical ClawHub skill `openclaw-growth-engineer`.

## Auto Maintenance

- CLI startup checks for newer CLI versions once per day and shows an update hint in text mode.
- In interactive terminals, the update prompt supports `y` (update now), `n` (ask later), and `a` (skip this offered version).
- When the CLI binary version changes, the CLI auto-refreshes the `analyticscli-cli` skill.
- ClawHub skill updates are handled by ClawHub; the CLI does not refresh hidden or unpublished ClawHub-only skills.
- Automatic refresh intentionally does **not** force-update the `analyticscli-ts-sdk` skill, because SDK versions in app codebases can lag intentionally.

## Releases

Use npm package versions and GitHub Releases in the public CLI repository as
the source for release history.
