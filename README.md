# BHWiki Literature Monitor

A separate worker that discovers new biomedical papers and opens review-only pull requests in [`AntonIXO/BHWiki`](https://github.com/AntonIXO/BHWiki).

## Boundary

```text
BHWiki Markdown → Europe PMC → canonical deduplication → LLM triage
       → private proposal files → branch + PR → human review → manual Markdown edit
```

The worker never edits `content/substances`, never publishes an evidence claim, and never merges a PR. The BHWiki Markdown corpus remains the source of truth.

## Run locally

```bash
bun install --frozen-lockfile

# Safe metadata smoke test; no LLM, push, branch, or PR
BHWIKI_MONITOR_HOME=/tmp/bhwiki-monitor \
BHWIKI_REPO_DIR=/tmp/bhwiki-monitor/BHWiki \
bun run start -- --dry-run --no-llm --slug=caffeine --limit=10

# Normal run; requires a separate writer environment and LLM provider
bun run start -- --limit=10
```

Useful flags:

- `--dry-run` — writes output under `BHWIKI_MONITOR_HOME/dry-runs/`; never creates a branch, push, or PR.
- `--no-llm` — discovery only; explicit because no proposal can be produced without an LLM.
- `--slug=caffeine` — one substance smoke run.
- `--max-substances=N` — bound a run during testing.
- `--since=YYYY-MM-DD` — override the rolling overlap start date.
- `--limit=N` — Europe PMC results per substance.
- `--max-papers=N` — cap the number of deduplicated papers sent to the LLM in one run.

## Required environment

```env
BHWIKI_MONITOR_HOME=/var/lib/bhwiki-literature-monitor
BHWIKI_REPO_DIR=/var/lib/bhwiki-literature-monitor/BHWiki
BHWIKI_REPO_URL=https://github.com/AntonIXO/BHWiki.git
BHWIKI_GITHUB_REPO=AntonIXO/BHWiki
BHWIKI_BASE_BRANCH=main

# Option A: use the Hermes Codex OAuth access token directly (no hermes subprocess)
BHWIKI_LLM_PROVIDER=codex-oauth
BHWIKI_CODEX_AUTH_FILE=/root/.hermes/auth.json
BHWIKI_LLM_MODEL=gpt-6.1-sol

# Option B: use Hermes as an OAuth broker subprocess
# BHWIKI_LLM_PROVIDER=hermes-codex

# Option C: use a separate OpenAI-compatible provider
# BHWIKI_LLM_PROVIDER=openai-compatible
# BHWIKI_LLM_BASE_URL=https://provider.example/v1
# BHWIKI_LLM_API_KEY=replace-me
# BHWIKI_LLM_MODEL=replace-me
```

The worker uses the host's `gh` credential for the final `git push` and `gh pr create`. Keep that credential outside this repository and run the service under a dedicated account with access only to the BHWiki checkout and GitHub repository.

## Provenance and safety

Every proposal retains the Europe PMC URL, PMID/DOI/PMCID when present, matched BHWiki substance/tags, retrieval date, raw provider result, model name, rationale, confidence and exact abstract quotes. Quotes are mechanically required to be contiguous spans from the abstract. Missing full text remains missing.

A free-to-read URL is not assumed to grant redistribution rights. The proposal asks the reviewer to inspect the canonical article version, correction/retraction state, study context, limitations, funding/conflicts and rights before editing Markdown.

The PR contains files under `data/research/auto-proposals/` plus a manifest. It intentionally does not modify public article files. The reviewer applies accepted content manually and runs the normal BHWiki gates:

```bash
bun run content:validate
bun run test
bun run typecheck
BHWIKI_DATA_MODE=bundled bun run build
```

## Deploy as a timer

Copy `.env.example` to `/etc/bhwiki-literature-monitor.env` with mode `0600`, install the unit, and enable it only after the provider and GitHub credentials have been tested:

```bash
install -D -m 0644 deploy/bhwiki-literature-monitor.service /etc/systemd/system/bhwiki-literature-monitor.service
install -D -m 0644 deploy/bhwiki-literature-monitor.timer /etc/systemd/system/bhwiki-literature-monitor.timer
install -d -m 0700 /var/lib/bhwiki-literature-monitor
systemctl daemon-reload
systemctl enable --now bhwiki-literature-monitor.timer
systemctl start bhwiki-literature-monitor.service
journalctl -u bhwiki-literature-monitor.service --since today --no-pager
```

Do not put BHWiki's public `bhwiki_reader` URL in this service. The service only needs the Git checkout and GitHub push credential; the current implementation stores the acquisition manifest in the PR rather than in the public database inbox.
