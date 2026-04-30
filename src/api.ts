import { requestUrl, type RequestUrlResponse } from "obsidian";
import type {
	ChecksStatus,
	PRIdentifier,
	PRState,
	PRStatus,
	ReviewStatus,
} from "./types";

export interface GithubApiCredentials {
	accessToken: string;
}

export type GithubFetchErrorReason =
	| "missing_credentials"
	| "unauthorized"
	| "not_found"
	| "rate_limited"
	| "graphql"
	| "network"
	| "parse"
	| "server_error"
	| "unknown";

export class GithubFetchError extends Error {
	constructor(
		public reason: GithubFetchErrorReason,
		message: string,
		public status?: number
	) {
		super(message);
		this.name = "GithubFetchError";
	}
}

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

interface GraphQLResponse<T> {
	data?: T;
	errors?: { type?: string; message: string }[];
}

interface ReviewNode {
	state: string;
	commit: { oid: string } | null;
}

interface PullRequestData {
	repository: {
		pullRequest: {
			title: string;
			isDraft: boolean;
			state: "OPEN" | "CLOSED" | "MERGED";
			mergedAt: string | null;
			mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
			headRefOid: string;
			latestReviews: { nodes: ReviewNode[] };
			commits: {
				nodes: {
					commit: {
						statusCheckRollup: { state: string } | null;
					};
				}[];
			};
		} | null;
	} | null;
}

interface ViewerData {
	viewer: { login: string };
}

const PR_QUERY = `query($owner: String!, $repo: String!, $num: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $num) {
      title
      isDraft
      state
      mergedAt
      mergeable
      headRefOid
      latestReviews(first: 100) {
        nodes {
          state
          commit { oid }
        }
      }
      commits(last: 1) {
        nodes { commit { statusCheckRollup { state } } }
      }
    }
  }
}`;

const VIEWER_QUERY = `query { viewer { login } }`;

function ensureCreds(creds: GithubApiCredentials): void {
	if (!creds.accessToken) {
		throw new GithubFetchError(
			"missing_credentials",
			"GitHub personal access token must be configured in settings"
		);
	}
}

async function graphql<T>(
	creds: GithubApiCredentials,
	query: string,
	variables: Record<string, unknown> = {}
): Promise<T> {
	ensureCreds(creds);

	let response: RequestUrlResponse;
	try {
		response = await requestUrl({
			url: GRAPHQL_ENDPOINT,
			method: "POST",
			headers: {
				Authorization: `Bearer ${creds.accessToken}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"User-Agent": "obsidian-github-pr-status-plugin",
			},
			body: JSON.stringify({ query, variables }),
			throw: false,
		});
	} catch (e) {
		throw new GithubFetchError(
			"network",
			`Network error: ${(e as Error).message}`
		);
	}

	if (response.status === 401) {
		throw new GithubFetchError(
			"unauthorized",
			"Invalid or missing access token",
			401
		);
	}
	if (response.status === 403) {
		// GitHub returns 403 for both abuse-detection and rate limits
		const remaining = response.headers?.["x-ratelimit-remaining"];
		if (remaining === "0") {
			throw new GithubFetchError(
				"rate_limited",
				"GitHub rate limit exceeded",
				403
			);
		}
		throw new GithubFetchError(
			"unauthorized",
			"Forbidden — token lacks the required scope",
			403
		);
	}
	if (response.status === 429) {
		throw new GithubFetchError("rate_limited", "Rate limited", 429);
	}
	if (response.status >= 500) {
		throw new GithubFetchError(
			"server_error",
			`GitHub returned ${response.status}`,
			response.status
		);
	}
	if (response.status >= 400) {
		throw new GithubFetchError(
			"unknown",
			`Unexpected HTTP ${response.status}`,
			response.status
		);
	}

	let body: GraphQLResponse<T>;
	try {
		body = response.json as GraphQLResponse<T>;
	} catch (e) {
		throw new GithubFetchError(
			"parse",
			`Failed to parse GitHub response: ${(e as Error).message}`
		);
	}

	if (body.errors && body.errors.length > 0) {
		// GraphQL surfaces "not found" / "no access" via NOT_FOUND.
		const notFound = body.errors.find((e) => e.type === "NOT_FOUND");
		if (notFound) {
			throw new GithubFetchError("not_found", notFound.message);
		}
		throw new GithubFetchError(
			"graphql",
			body.errors.map((e) => e.message).join("; ")
		);
	}

	if (!body.data) {
		throw new GithubFetchError(
			"parse",
			"GitHub returned no data and no errors"
		);
	}
	return body.data;
}

export async function testConnection(
	creds: GithubApiCredentials
): Promise<{ login: string }> {
	const data = await graphql<ViewerData>(creds, VIEWER_QUERY);
	return { login: data.viewer.login };
}

export async function fetchPRStatus(
	creds: GithubApiCredentials,
	pr: PRIdentifier
): Promise<PRStatus> {
	const data = await graphql<PullRequestData>(creds, PR_QUERY, {
		owner: pr.owner,
		repo: pr.repo,
		num: pr.number,
	});

	const prData = data.repository?.pullRequest;
	if (!prData) {
		throw new GithubFetchError(
			"not_found",
			`PR ${pr.owner}/${pr.repo}#${pr.number} not found`
		);
	}

	const state: PRState = prData.mergedAt
		? "merged"
		: prData.state === "CLOSED"
			? "closed"
			: "open";
	const isTerminal = state === "merged" || state === "closed";

	const reviewStatus = determineReviewStatus(
		prData.isDraft,
		prData.headRefOid,
		prData.latestReviews.nodes
	);

	let checksStatus: ChecksStatus = "unknown";
	if (!isTerminal) {
		const rollupState =
			prData.commits.nodes[0]?.commit.statusCheckRollup?.state;
		checksStatus = mapRollupState(rollupState);
	}

	return {
		title: prData.title,
		state,
		isDraft: prData.isDraft,
		mergeable: prData.mergeable,
		reviewStatus,
		checksStatus,
		isTerminal,
		lastFetched: Date.now(),
	};
}

function determineReviewStatus(
	isDraft: boolean,
	headOid: string,
	reviews: ReviewNode[]
): ReviewStatus {
	if (isDraft) return "draft";
	if (reviews.length === 0) return "no_reviews";

	// CHANGES_REQUESTED propagates regardless of which commit it was for —
	// matches GitHub's UI where that signal sticks until the reviewer
	// dismisses or re-reviews.
	for (const r of reviews) {
		if (r.state === "CHANGES_REQUESTED") return "changes_requested";
	}

	// APPROVED is only valid when the approval was for the current head commit.
	// Stale approvals (where new commits have landed since) are ignored, which
	// flows through to "no_reviews" — i.e. the PR needs another look.
	for (const r of reviews) {
		if (r.state === "APPROVED" && r.commit?.oid === headOid) return "approved";
	}

	for (const r of reviews) {
		if (r.state === "COMMENTED") return "commented";
	}

	return "no_reviews";
}

function mapRollupState(state: string | undefined): ChecksStatus {
	if (!state) return "unknown";
	switch (state.toUpperCase()) {
		case "SUCCESS":
			return "success";
		case "PENDING":
		case "EXPECTED":
			return "pending";
		case "FAILURE":
		case "ERROR":
			return "failure";
		default:
			return "unknown";
	}
}
