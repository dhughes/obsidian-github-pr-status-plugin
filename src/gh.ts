import { exec } from "child_process";
import { promisify } from "util";
import type { PRIdentifier, PRStatus, ReviewStatus, ChecksStatus } from "./types";

const execAsync = promisify(exec);

// Electron apps don't inherit the user's shell PATH. Build a PATH that
// includes the common locations where Homebrew / nix / etc. install CLIs.
const EXTRA_PATHS = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
];
const execPath = [
	...(process.env.PATH?.split(":") ?? []),
	...EXTRA_PATHS,
].join(":");

const EXEC_OPTS = { timeout: 15000, env: { ...process.env, PATH: execPath } };

interface GhPRInfo {
	title: string;
	isDraft: boolean;
	state: string;
	mergedAt: string;
	mergeable: string;
	reviews: { state: string }[];
}

interface GhCheck {
	name: string;
	state: string;
}

export async function fetchPRStatus(pr: PRIdentifier): Promise<PRStatus> {
	const repo = `${pr.owner}/${pr.repo}`;

	// Fetch PR info and reviews in one call
	const { stdout: infoJson } = await execAsync(
		`gh pr view ${pr.number} --repo ${repo} --json title,isDraft,state,mergedAt,mergeable,reviews`,
		EXEC_OPTS
	);
	const info: GhPRInfo = JSON.parse(infoJson);

	const state = info.mergedAt
		? "merged"
		: info.state?.toUpperCase() === "CLOSED"
			? "closed"
			: "open";
	const isTerminal = state === "merged" || state === "closed";

	const reviewStatus = determineReviewStatus(info.isDraft, info.reviews || []);

	// Only fetch checks for open PRs
	let checksStatus: ChecksStatus = "unknown";
	if (!isTerminal) {
		checksStatus = await fetchChecksStatus(pr);
	}

	return {
		title: info.title || "",
		state,
		isDraft: info.isDraft || false,
		mergeable: info.mergeable || "UNKNOWN",
		reviewStatus,
		checksStatus,
		isTerminal,
		lastFetched: Date.now(),
	};
}

function determineReviewStatus(isDraft: boolean, reviews: { state: string }[]): ReviewStatus {
	if (isDraft) return "draft";
	if (reviews.length === 0) return "no_reviews";

	for (const r of reviews) {
		if (r.state === "CHANGES_REQUESTED") return "changes_requested";
	}
	for (const r of reviews) {
		if (r.state === "APPROVED") return "approved";
	}
	for (const r of reviews) {
		if (r.state === "COMMENTED") return "commented";
	}
	return "no_reviews";
}

async function fetchChecksStatus(pr: PRIdentifier): Promise<ChecksStatus> {
	try {
		const { stdout } = await execAsync(
			`gh pr checks ${pr.number} --repo ${pr.owner}/${pr.repo} --json name,state`,
			EXEC_OPTS
		);
		const checks: GhCheck[] = JSON.parse(stdout);
		return determineChecksStatus(checks);
	} catch {
		return "unknown";
	}
}

function determineChecksStatus(checks: GhCheck[]): ChecksStatus {
	if (checks.length === 0) return "unknown";

	// Any pending → whole thing is pending
	for (const c of checks) {
		const s = c.state.toUpperCase();
		if (s === "PENDING" || s === "IN_PROGRESS" || s === "QUEUED") return "pending";
	}

	// Any failure → failure
	for (const c of checks) {
		const s = c.state.toUpperCase();
		if (s === "FAILURE" || s === "TIMED_OUT" || s === "ERROR") return "failure";
	}

	// All passed
	const allPassed = checks.every((c) => {
		const s = c.state.toUpperCase();
		return s === "SUCCESS" || s === "NEUTRAL" || s === "SKIPPED";
	});

	return allPassed ? "success" : "unknown";
}
