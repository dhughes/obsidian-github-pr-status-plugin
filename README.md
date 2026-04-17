# GitHub PR Status for Obsidian

An [Obsidian](https://obsidian.md) plugin that detects GitHub pull request URLs in your notes and displays live status badges inline — showing review state, CI checks, merge conflicts, and whether the PR is open, merged, or closed.

## Features

- **Inline status badges** — PR status appears right next to the link, in both editing and reading views
- **Review status** — draft, awaiting review, commented, approved, or changes requested
- **CI checks** — pending, passing, or failing
- **Merge conflicts** — warns when a PR has conflicts
- **Terminal states** — merged and closed PRs are clearly labeled
- **URL collapsing** — bare PR URLs in reading view are shortened to `repo #123`
- **Auto-polling** — open PRs are re-checked on a configurable interval (default 30s)
- **Code block aware** — skips PR URLs inside fenced code blocks and inline code

## Prerequisites

This plugin requires the [GitHub CLI (`gh`)](https://cli.github.com/) to be installed and authenticated on your machine.

```bash
# Install (macOS)
brew install gh

# Authenticate
gh auth login
```

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
| Poll interval | 30s | How often to re-check open PRs (minimum 10s) |

## License

MIT
