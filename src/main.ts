import { Plugin, MarkdownPostProcessorContext, MarkdownView } from "obsidian";
import {
	ViewPlugin,
	ViewUpdate,
	DecorationSet,
	Decoration,
	EditorView,
	WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
	GithubPRStatusSettings,
	DEFAULT_SETTINGS,
	GithubPRStatusSettingTab,
} from "./settings";
import { fetchPRStatus } from "./gh";
import type { PRStatus, ReviewStatus, ChecksStatus } from "./types";

// Matches GitHub PR URLs, captures owner, repo, and PR number.
// Handles optional trailing path segments like /files, /checks, etc.
const PR_URL_REGEX =
	/https:\/\/github\.com\/([^\/\s)\]]+)\/([^\/\s)\]]+)\/pull\/(\d+)(?:\/[^\s)\]>]*)?/g;

// StateEffect dispatched to editors to trigger decoration refresh
const prStatusUpdateEffect = StateEffect.define<null>();

const REVIEW_LABELS: Record<ReviewStatus, string> = {
	draft: "✎ draft",
	no_reviews: "◷ no reviews",
	commented: "💬 commented",
	approved: "✓ approved",
	changes_requested: "✗ changes requested",
	unknown: "? unknown",
};

const CHECKS_LABELS: Record<Exclude<ChecksStatus, "unknown">, string> = {
	pending: "● pending",
	success: "● passing",
	failure: "✗ failing",
};

export default class GithubPRStatusPlugin extends Plugin {
	settings: GithubPRStatusSettings = DEFAULT_SETTINGS;
	statusCache = new Map<string, PRStatus>();
	private pollIntervalId: number | null = null;
	private pendingFetches = new Set<string>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new GithubPRStatusSettingTab(this.app, this));

		// Reading view: post-process rendered markdown
		this.registerMarkdownPostProcessor(
			(el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
				this.processReadingView(el, ctx);
			}
		);

		// Edit view: CodeMirror 6 editor extension
		this.registerEditorExtension(this.buildEditorExtension());

		// Start polling for open PR status updates
		this.startPolling();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	prKey(owner: string, repo: string, number: number): string {
		return `${owner}/${repo}#${number}`;
	}

	private parsePrKey(
		key: string
	): { owner: string; repo: string; number: number } | null {
		const match = key.match(/^([^\/]+)\/([^#]+)#(\d+)$/);
		if (!match || !match[1] || !match[2] || !match[3]) return null;
		return {
			owner: match[1],
			repo: match[2],
			number: parseInt(match[3], 10),
		};
	}

	/**
	 * Get cached status for a PR. If not cached, triggers an async fetch
	 * and returns null (the badge will show a loading state).
	 */
	getStatus(
		owner: string,
		repo: string,
		number: number
	): PRStatus | null {
		const key = this.prKey(owner, repo, number);
		const cached = this.statusCache.get(key);
		if (!cached && !this.pendingFetches.has(key)) {
			this.triggerFetch(owner, repo, number);
		}
		return cached ?? null;
	}

	private async triggerFetch(
		owner: string,
		repo: string,
		number: number
	) {
		const key = this.prKey(owner, repo, number);
		if (this.pendingFetches.has(key)) return;
		this.pendingFetches.add(key);

		try {
			const status = await fetchPRStatus({ owner, repo, number });
			this.statusCache.set(key, status);
			this.refreshAllDecorations();
		} catch (e) {
			console.error(`[gh-pr-status] failed to fetch ${key}:`, e);
		} finally {
			this.pendingFetches.delete(key);
		}
	}

	startPolling() {
		if (this.pollIntervalId !== null) {
			window.clearInterval(this.pollIntervalId);
		}
		const ms = this.settings.pollIntervalSeconds * 1000;
		this.pollIntervalId = this.registerInterval(
			window.setInterval(() => this.pollAllPRs(), ms)
		);
	}

	restartPolling() {
		this.startPolling();
	}

	private async pollAllPRs() {
		const entries = [...this.statusCache.entries()];
		for (const [key, status] of entries) {
			if (status.isTerminal) continue;
			const parsed = this.parsePrKey(key);
			if (!parsed) continue;
			await this.triggerFetch(
				parsed.owner,
				parsed.repo,
				parsed.number
			);
		}
	}

	private refreshAllDecorations() {
		// Update reading view badges already in the DOM
		this.updateReadingViewBadges();

		// Dispatch effect to all open editors so they rebuild decorations
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			const cm = (leaf.view.editor as any).cm as
				| EditorView
				| undefined;
			if (cm) {
				cm.dispatch({
					effects: prStatusUpdateEffect.of(null),
				});
			}
		});
	}

	// ── Reading View ──────────────────────────────────────────────

	private processReadingView(
		el: HTMLElement,
		_ctx: MarkdownPostProcessorContext
	) {
		const anchors = el.querySelectorAll("a");
		anchors.forEach((anchor) => {
			const href = anchor.getAttribute("href") || "";
			PR_URL_REGEX.lastIndex = 0;
			const match = PR_URL_REGEX.exec(href);
			if (!match || !match[1] || !match[2] || !match[3]) return;

			const owner = match[1];
			const repo = match[2];
			const number = parseInt(match[3], 10);
			const key = this.prKey(owner, repo, number);

			const badge = document.createElement("span");
			badge.className = "gh-pr-status-badge";
			badge.dataset.prKey = key;

			const status = this.getStatus(owner, repo, number);
			this.renderBadge(badge, status);

			anchor.after(badge);
		});
	}

	private updateReadingViewBadges() {
		const badges =
			document.querySelectorAll<HTMLElement>(".gh-pr-status-badge");
		badges.forEach((badge) => {
			const key = badge.dataset.prKey;
			if (!key) return;
			const status = this.statusCache.get(key) ?? null;
			this.renderBadge(badge, status);
		});
	}

	// ── Badge Rendering (shared by both views) ───────────────────

	renderBadge(badge: HTMLElement, status: PRStatus | null) {
		badge.empty();

		if (!status) {
			badge.textContent = " ⏳";
			badge.className = "gh-pr-status-badge gh-pr-loading";
			return;
		}

		badge.className = "gh-pr-status-badge";

		if (status.state === "merged") {
			this.appendSpan(badge, "gh-pr-merged", "⊕ merged");
			return;
		}

		if (status.state === "closed") {
			this.appendSpan(badge, "gh-pr-closed", "⊗ closed");
			return;
		}

		// Open PR: review + checks + conflict
		const parts: HTMLElement[] = [];

		// Review
		const reviewClass = `gh-pr-review-${status.reviewStatus}`;
		const reviewText =
			REVIEW_LABELS[status.reviewStatus] || "? unknown";
		parts.push(this.createSpan(reviewClass, reviewText));

		// Checks (skip unknown)
		if (status.checksStatus !== "unknown") {
			const checksClass = `gh-pr-checks-${status.checksStatus}`;
			const checksText =
				CHECKS_LABELS[
					status.checksStatus as Exclude<ChecksStatus, "unknown">
				] || "";
			if (checksText) {
				parts.push(this.createSpan(checksClass, checksText));
			}
		}

		// Conflict
		if (status.mergeable === "CONFLICTING") {
			parts.push(this.createSpan("gh-pr-conflict", "⚠ conflict"));
		}

		// Assemble
		badge.appendChild(document.createTextNode(" "));
		parts.forEach((part, i) => {
			if (i > 0) {
				badge.appendChild(document.createTextNode(" · "));
			}
			badge.appendChild(part);
		});
	}

	private createSpan(className: string, text: string): HTMLSpanElement {
		const span = document.createElement("span");
		span.className = className;
		span.textContent = text;
		return span;
	}

	private appendSpan(
		parent: HTMLElement,
		className: string,
		text: string
	) {
		parent.appendChild(document.createTextNode(" "));
		parent.appendChild(this.createSpan(className, text));
	}

	// ── Edit View (CodeMirror 6) ─────────────────────────────────

	private buildEditorExtension() {
		const plugin = this;

		class PRStatusWidget extends WidgetType {
			private prKey: string;
			private statusHash: string;

			constructor(prKey: string) {
				super();
				this.prKey = prKey;
				const status = plugin.statusCache.get(prKey);
				this.statusHash = status
					? `${status.state}-${status.reviewStatus}-${status.checksStatus}-${status.mergeable}`
					: "loading";
			}

			toDOM(): HTMLElement {
				const badge = document.createElement("span");
				badge.className = "gh-pr-status-badge";
				badge.dataset.prKey = this.prKey;
				const status =
					plugin.statusCache.get(this.prKey) ?? null;
				plugin.renderBadge(badge, status);
				return badge;
			}

			eq(other: PRStatusWidget): boolean {
				return (
					this.prKey === other.prKey &&
					this.statusHash === other.statusHash
				);
			}
		}

		return ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;

				constructor(view: EditorView) {
					this.decorations = this.buildDecorations(view);
				}

				update(update: ViewUpdate) {
					if (
						update.docChanged ||
						update.viewportChanged ||
						update.transactions.some((tr) =>
							tr.effects.some((e) =>
								e.is(prStatusUpdateEffect)
							)
						)
					) {
						this.decorations = this.buildDecorations(
							update.view
						);
					}
				}

				buildDecorations(view: EditorView): DecorationSet {
					const entries: {
						pos: number;
						key: string;
					}[] = [];

					for (const { from, to } of view.visibleRanges) {
						const text = view.state.doc.sliceString(
							from,
							to
						);

						// Pass 1: markdown links containing PR URLs
						// [text](https://github.com/.../pull/123)
						const mdLinkRegex =
							/\[[^\]]*\]\((https:\/\/github\.com\/([^\/\s)]+)\/([^\/\s)]+)\/pull\/(\d+)(?:\/[^\s)]*)?)\)/g;
						const claimedRanges: [number, number][] = [];
						let mdMatch: RegExpExecArray | null;

						while (
							(mdMatch = mdLinkRegex.exec(text)) !== null
						) {
							if (
								!mdMatch[2] ||
								!mdMatch[3] ||
								!mdMatch[4]
							)
								continue;

							const owner = mdMatch[2];
							const repo = mdMatch[3];
							const num = parseInt(mdMatch[4], 10);
							const key = plugin.prKey(
								owner,
								repo,
								num
							);

							plugin.getStatus(owner, repo, num);

							// Widget goes after the closing )
							const endPos =
								from +
								mdMatch.index +
								mdMatch[0].length;
							entries.push({ pos: endPos, key });

							// Claim the URL range so pass 2 skips it
							const urlStart =
								from +
								mdMatch.index +
								mdMatch[0].indexOf(mdMatch[1]!);
							const urlEnd =
								urlStart + mdMatch[1]!.length;
							claimedRanges.push([urlStart, urlEnd]);
						}

						// Pass 2: bare PR URLs (not inside markdown links)
						PR_URL_REGEX.lastIndex = 0;
						let bareMatch: RegExpExecArray | null;

						while (
							(bareMatch = PR_URL_REGEX.exec(text)) !==
							null
						) {
							if (
								!bareMatch[1] ||
								!bareMatch[2] ||
								!bareMatch[3]
							)
								continue;

							const matchStart =
								from + bareMatch.index;
							const matchEnd =
								matchStart + bareMatch[0].length;

							// Skip if inside a markdown link
							const isClaimed = claimedRanges.some(
								([s, e]) =>
									matchStart >= s && matchEnd <= e
							);
							if (isClaimed) continue;

							// Skip if inside inline code backticks
							const line =
								view.state.doc.lineAt(matchStart);
							const posInLine =
								matchStart - line.from;
							if (
								this.isInsideBackticks(
									line.text,
									posInLine
								)
							)
								continue;

							const owner = bareMatch[1];
							const repo = bareMatch[2];
							const num = parseInt(bareMatch[3], 10);
							const key = plugin.prKey(
								owner,
								repo,
								num
							);

							plugin.getStatus(owner, repo, num);

							entries.push({ pos: matchEnd, key });
						}
					}

					// Sort by position (required by RangeSetBuilder)
					entries.sort((a, b) => a.pos - b.pos);

					// Build decorations, deduplicating by position
					const builder =
						new RangeSetBuilder<Decoration>();
					const seen = new Set<number>();

					for (const entry of entries) {
						if (seen.has(entry.pos)) continue;
						seen.add(entry.pos);
						builder.add(
							entry.pos,
							entry.pos,
							Decoration.widget({
								widget: new PRStatusWidget(
									entry.key
								),
								side: 1,
							})
						);
					}

					return builder.finish();
				}

				isInsideBackticks(
					lineText: string,
					pos: number
				): boolean {
					let inCode = false;
					for (
						let i = 0;
						i < lineText.length && i <= pos;
						i++
					) {
						if (lineText[i] === "`") inCode = !inCode;
					}
					return inCode;
				}
			},
			{
				decorations: (v) => v.decorations,
			}
		);
	}
}
