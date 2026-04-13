export interface PRIdentifier {
	owner: string;
	repo: string;
	number: number;
}

export type PRState = "open" | "closed" | "merged";
export type ReviewStatus = "draft" | "no_reviews" | "commented" | "approved" | "changes_requested" | "unknown";
export type ChecksStatus = "pending" | "success" | "failure" | "unknown";

export interface PRStatus {
	title: string;
	state: PRState;
	isDraft: boolean;
	mergeable: string;
	reviewStatus: ReviewStatus;
	checksStatus: ChecksStatus;
	isTerminal: boolean;
	lastFetched: number;
}
