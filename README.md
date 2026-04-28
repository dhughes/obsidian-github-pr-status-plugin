# GitHub PR Status for Obsidian

An [Obsidian](https://obsidian.md) plugin that detects GitHub pull request URLs in your notes and displays live status badges inline — showing review state, CI checks, merge conflicts, and whether the PR is open, merged, or closed.

Works with **GitHub.com only**. Authenticates with a personal access token, so the plugin runs on desktop and mobile (no CLI dependency).

## Features

- **Inline status badges** — PR status appears right next to the link, in both editing and reading views
- **Review status** — draft, awaiting review, commented, approved, or changes requested
- **CI checks** — pending, passing, or failing (computed from GitHub's `statusCheckRollup`, the same value `gh pr checks` reports)
- **Merge conflicts** — warns when a PR has conflicts
- **Terminal states** — merged and closed PRs are clearly labeled
- **URL collapsing** — bare PR URLs in reading view are shortened to `repo #123`
- **Auto-polling** — open PRs are re-checked on a configurable interval (default 60s, minimum 60s)
- **Code block aware** — skips PR URLs inside fenced code blocks and inline code

## Prerequisites

A **classic GitHub personal access token** with the `repo` scope (or `public_repo` if you only reference public repositories).

1. Visit https://github.com/settings/tokens
2. Click **Generate new token (classic)**
3. Give it a name, set an expiration, and check the `repo` scope (or `public_repo`)
4. Copy the token — you'll paste it into the plugin's settings

> **Security note:** the token is stored unencrypted in `<your-vault>/.obsidian/plugins/github-pr-status/data.json`.

## Installation

### Manual

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`) from the [releases page](https://github.com/dhughes/obsidian-github-pr-status-plugin/releases)
2. Create a folder at `<your-vault>/.obsidian/plugins/github-pr-status/`
3. Copy the downloaded files into that folder
4. Enable the plugin in Obsidian under **Settings → Community plugins**

### From source

```bash
git clone https://github.com/dhughes/obsidian-github-pr-status-plugin.git
cd obsidian-github-pr-status-plugin
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` into your vault's plugin folder as described above.

## Configuration

1. Open **Settings → Community plugins → GitHub PR Status**
2. Paste your personal access token
3. Click **Test** to verify — you should see `✓ Connected as <your-username>`

## Usage

Just paste a GitHub PR URL into any note:

```
https://github.com/owner/repo/pull/42
```

The plugin will automatically fetch and display the PR's status inline. Markdown links work too:

```
[My PR](https://github.com/owner/repo/pull/42)
```

### Badge examples

| Badge | Meaning |
|---|---|
| ⌨ draft | PR is a draft |
| ⧖ no reviews | No reviews yet |
| ☑ approved | PR is approved |
| ⌧ changes requested | Changes requested |
| ● passing | All CI checks pass |
| ● pending | CI checks in progress |
| ⌧ failing | CI checks failing |
| ⚠ conflict | Merge conflict detected |
| ⌥ merged | PR has been merged |
| ⌧ closed | PR was closed without merging |

## Settings

| Setting | Default | Description |
|---|---|---|
| Personal access token | _(empty)_ | Classic GitHub PAT with `repo` or `public_repo` scope |
| Poll interval | 60s | How often to re-check open PRs (minimum 60s) |

## License

MIT
