# review-publishing Specification

## Purpose

Publish review findings back to the pull request as one batched review with line-anchored inline comments and a single maintained summary, so results are readable, never duplicated, and never silently lost.

## ADDED Requirements

### Requirement: Single batched review with inline comments

The system SHALL publish all inline findings for a run as one batched pull request review via the GitHub API, producing a single review notification, rather than posting individual comments one at a time.

#### Scenario: Run with multiple findings

- **WHEN** a review run completes with multiple line-anchored findings
- **THEN** all findings SHALL be submitted in one review containing the inline comments and an overall body
- **AND** exactly one review SHALL appear on the pull request for that run

### Requirement: Fallback anchoring chain — no finding silently lost

For each finding, the system SHALL attempt to anchor an inline comment at the exact target line; if that line is not commentable, it SHALL fall back to the nearest commentable diff line in the same file, then to a file-level comment, then to inclusion in the summary comment. Every finding produced by the pipeline MUST appear in at least one of these forms.

#### Scenario: Exact line not commentable

- **WHEN** a finding's target line is not part of the commentable diff
- **THEN** the comment SHALL be anchored to the nearest commentable line in that file, or posted at file level if none exists

#### Scenario: File not present in the diff view

- **WHEN** a finding cannot be attached inline or at file level
- **THEN** the finding SHALL be included in the summary comment with its file and line reference
- **AND** the finding SHALL NOT be dropped

### Requirement: Single upserted summary comment

The system SHALL maintain exactly one summary comment per pull request, identified by a hidden marker. On each run the system SHALL edit the existing summary comment in place; it MUST NOT post an additional summary comment when one already exists.

#### Scenario: First review of a PR

- **WHEN** the system reviews a pull request that has no existing summary comment from the system
- **THEN** one summary comment SHALL be created containing the run's summary

#### Scenario: Subsequent review of the same PR

- **WHEN** the system completes another run on a pull request that already has its summary comment
- **THEN** the existing summary comment SHALL be edited in place with the new content
- **AND** no second summary comment SHALL be created

### Requirement: Deduplication against existing comments on re-runs

Before publishing, the system SHALL compare candidate findings against the system's existing comments on the pull request and SHALL NOT post a finding that duplicates one already present at the same location.

#### Scenario: Re-run over unchanged code

- **WHEN** a review run produces a finding identical in location and substance to an existing comment previously posted by the system
- **THEN** the duplicate SHALL NOT be posted
- **AND** the existing comment SHALL remain the sole record of that finding

### Requirement: Re-review publishes only new findings and carries forward open ones

On a re-review after new commits, the system SHALL post inline comments only for findings on the newly changed code, and SHALL list previously reported findings that remain unresolved in the updated summary as "still open" rather than re-posting them inline.

#### Scenario: Push that fixes some findings and adds new code

- **WHEN** new commits are pushed that resolve some prior findings and introduce new issues
- **THEN** inline comments SHALL be posted only for the new issues
- **AND** unresolved prior findings SHALL appear in the summary marked as still open
- **AND** resolved prior findings SHALL NOT be listed as still open
