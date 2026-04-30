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
import { fetchPRStatus } from "./api";
import type { PRStatus, ReviewStatus, ChecksStatus } from "./types";

// Matches GitHub PR URLs, captures owner, repo, and PR number.
// Handles optional trailing path segments like /files, /checks, etc.
const PR_URL_REGEX =
	/https:\/\/github\.com\/([^\/\s)\]]+)\/([^\/\s)\]]+)\/pull\/(\d+)(?:\/[^\s)\]>]*)?/g;

// StateEffect dispatched to editors to trigger decoration refresh
const prStatusUpdateEffect = StateEffect.define<null>();

const REVIEW_LABELS: Record<ReviewStatus, string> = {
	draft: "⌨ draft",
	no_reviews: "⧖ no reviews",
	commented: "@ commented",
	approved: "☑ approved",
	changes_requested: "⌧ changes requested",
	unknown: "? unknown",
};

const CHECKS_LABELS: Record<Exclude<ChecksStatus, "unknown">, string> = {
	pending: "● pending",
	success: "● passing",
	failure: "⌧ failing",
};

export default class GithubPRStatusPlugin extends Plugin {
	settings: GithubPRStatusSettings = DEFAULT_SETTINGS;
	statusCache = new Map<string, PRStatus>();
	private pollIntervalId: number | null = null;
	private pendingFetches = new Set<string>();
	private failedKeys = new Set<string>();

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
		if (this.settings.pollIntervalSeconds < 60) {
			this.settings.pollIntervalSeconds = 60;
		}
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
			const status = await fetchPRStatus(
				{ accessToken: this.settings.accessToken },
				{ owner, repo, number }
			);
			this.statusCache.set(key, status);
			this.refreshAllDecorations();
		} catch (e) {
			console.warn(`[gh-pr-status] failed to fetch ${key}:`, e);
			this.failedKeys.add(key);
			this.refreshAllDecorations();
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

	refreshPR(key: string) {
		const parsed = this.parsePrKey(key);
		if (!parsed) return;
		this.failedKeys.delete(key);
		this.statusCache.delete(key);
		this.refreshAllDecorations();
		this.triggerFetch(parsed.owner, parsed.repo, parsed.number);
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
			// Skip links inside code/pre elements
			if (this.isInsideCodeElement(anchor)) return;

			const href = anchor.getAttribute("href") || "";
			PR_URL_REGEX.lastIndex = 0;
			const match = PR_URL_REGEX.exec(href);
			if (!match || !match[1] || !match[2] || !match[3]) return;

			const owner = match[1];
			const repo = match[2];
			const number = parseInt(match[3], 10);
			const key = this.prKey(owner, repo, number);

			// Don't decorate if gh failed for this PR
			if (this.failedKeys.has(key)) return;

			// Collapse raw URL text to "repo #number"
			const anchorText = anchor.textContent || "";
			PR_URL_REGEX.lastIndex = 0;
			if (PR_URL_REGEX.test(anchorText)) {
				anchor.textContent = `${repo} #${number}`;
			}

			const badge = document.createElement("span");
			badge.className = "gh-pr-status-badge";
			badge.dataset.prKey = key;

			const status = this.getStatus(owner, repo, number);
			this.renderBadge(badge, status);

			anchor.after(badge);
		});
	}

	private isInsideCodeElement(node: Node): boolean {
		let parent = node.parentElement;
		while (parent) {
			const tag = parent.tagName.toLowerCase();
			if (tag === "code" || tag === "pre") return true;
			parent = parent.parentElement;
		}
		return false;
	}

	private updateReadingViewBadges() {
		const badges =
			document.querySelectorAll<HTMLElement>(".gh-pr-status-badge");
		badges.forEach((badge) => {
			const key = badge.dataset.prKey;
			if (!key) return;
			if (this.failedKeys.has(key)) {
				badge.remove();
				return;
			}
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
			this.appendSpan(badge, "gh-pr-merged", "⌥ merged");
			this.appendRefreshButton(badge);
			return;
		}

		if (status.state === "closed") {
			this.appendSpan(badge, "gh-pr-closed", "⌧ closed");
			this.appendRefreshButton(badge);
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

		this.appendRefreshButton(badge);
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

	private appendRefreshButton(badge: HTMLElement) {
		const btn = document.createElement("span");
		btn.className = "gh-pr-refresh";
		btn.textContent = "↻";
		btn.setAttribute("aria-label", "Refresh PR status");
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const key = badge.dataset.prKey;
			if (key) this.refreshPR(key);
		});
		badge.appendChild(btn);
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

		// Shortened replacement for a bare PR URL in live preview.
		// Renders as a clickable anchor showing "repo #number".
		class BareURLWidget extends WidgetType {
			constructor(
				private readonly repo: string,
				private readonly num: number,
				private readonly url: string
			) {
				super();
			}

			toDOM(): HTMLElement {
				const a = document.createElement("a");
				a.className = "external-link gh-pr-shortened";
				a.href = this.url;
				a.textContent = `${this.repo} #${this.num}`;
				a.setAttr("target", "_blank");
				a.setAttr("rel", "noopener noreferrer");
				return a;
			}

			eq(other: BareURLWidget): boolean {
				return (
					this.repo === other.repo &&
					this.num === other.num &&
					this.url === other.url
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
						update.selectionSet ||
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
					type WidgetEntry = {
						kind: "widget";
						pos: number;
						key: string;
					};
					type ReplaceEntry = {
						kind: "replace";
						from: number;
						to: number;
						repo: string;
						num: number;
						url: string;
					};
					const entries: (WidgetEntry | ReplaceEntry)[] = [];

					// Build fenced code block ranges for the document
					const codeBlockRanges =
						this.getFencedCodeRanges(view);

					const isInCodeBlock = (pos: number): boolean =>
						codeBlockRanges.some(
							([s, e]) => pos >= s && pos <= e
						);

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

							const matchStart =
								from + mdMatch.index;

							// Skip if inside a fenced code block
							if (isInCodeBlock(matchStart)) continue;

							const owner = mdMatch[2];
							const repo = mdMatch[3];
							const num = parseInt(mdMatch[4], 10);
							const key = plugin.prKey(
								owner,
								repo,
								num
							);

							// Skip if gh failed for this PR
							if (plugin.failedKeys.has(key))
								continue;

							plugin.getStatus(owner, repo, num);

							// Widget goes after the closing )
							const endPos =
								from +
								mdMatch.index +
								mdMatch[0].length;
							entries.push({ kind: "widget", pos: endPos, key });

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

							// Skip if inside a fenced code block
							if (isInCodeBlock(matchStart)) continue;

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

							// Skip if gh failed for this PR
							if (plugin.failedKeys.has(key))
								continue;

							plugin.getStatus(owner, repo, num);

							// Shorten the URL text to "repo #num", but only when
							// no cursor or selection overlaps the URL — otherwise
							// reveal the source so the user can edit it.
							const cursorInRange = view.state.selection.ranges.some(
								(r) => !(r.to < matchStart || r.from > matchEnd)
							);
							if (!cursorInRange) {
								entries.push({
									kind: "replace",
									from: matchStart,
									to: matchEnd,
									repo,
									num,
									url: bareMatch[0],
								});
							}

							entries.push({ kind: "widget", pos: matchEnd, key });
						}
					}

					// Sort by start position. Replaces sort by `from`, widgets by `pos`.
					// When a replace and widget share the same position, the replace
					// must come first (RangeSetBuilder requires non-decreasing `from`,
					// and a replace's `to` extends past `from`).
					entries.sort((a, b) => {
						const aPos = a.kind === "replace" ? a.from : a.pos;
						const bPos = b.kind === "replace" ? b.from : b.pos;
						if (aPos !== bPos) return aPos - bPos;
						// Replace before widget at same position.
						return a.kind === "replace" ? -1 : 1;
					});

					const builder = new RangeSetBuilder<Decoration>();
					const seenWidgetPos = new Set<number>();

					for (const entry of entries) {
						if (entry.kind === "replace") {
							builder.add(
								entry.from,
								entry.to,
								Decoration.replace({
									widget: new BareURLWidget(
										entry.repo,
										entry.num,
										entry.url
									),
								})
							);
						} else {
							if (seenWidgetPos.has(entry.pos)) continue;
							seenWidgetPos.add(entry.pos);
							builder.add(
								entry.pos,
								entry.pos,
								Decoration.widget({
									widget: new PRStatusWidget(entry.key),
									side: 1,
								})
							);
						}
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

				getFencedCodeRanges(
					view: EditorView
				): [number, number][] {
					const ranges: [number, number][] = [];
					const doc = view.state.doc;
					let inFence = false;
					let fenceStart = 0;

					for (let i = 1; i <= doc.lines; i++) {
						const line = doc.line(i);
						if (/^(`{3,}|~{3,})/.test(line.text)) {
							if (inFence) {
								ranges.push([
									fenceStart,
									line.to,
								]);
								inFence = false;
							} else {
								fenceStart = line.from;
								inFence = true;
							}
						}
					}
					if (inFence) {
						ranges.push([fenceStart, doc.length]);
					}
					return ranges;
				}
			},
			{
				decorations: (v) => v.decorations,
			}
		);
	}
}
