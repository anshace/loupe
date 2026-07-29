# review-pipeline Specification

## Purpose

Transform a triggered pull request into a set of structured, trustworthy review findings: fetch and parse the diff, filter noise, invoke the model within cost bounds, and validate its output so a run never fails on bad model behavior.

## ADDED Requirements

### Requirement: Diff fetching and parsing into reviewable units

The system SHALL fetch the pull request diff via the GitHub API and parse it into files and hunks, computing the set of valid commentable line numbers on the new side of the diff for each file. Findings SHALL only ever be anchored to lines within these computed valid ranges.

#### Scenario: Multi-file diff parsed

- **WHEN** a review run begins for a pull request changing several files
- **THEN** the diff SHALL be parsed into per-file hunks with valid new-side line numbers
- **AND** the valid line ranges SHALL be supplied to the model as an explicit constraint

#### Scenario: Finding anchored outside the diff

- **WHEN** the model emits a finding whose line is not a valid commentable diff line
- **THEN** the system SHALL clamp the finding to the nearest valid line or reclassify it as file-level
- **AND** the run SHALL continue without error

### Requirement: Noise file filtering

The system SHALL exclude lockfiles, generated files, vendored dependencies, and binary files from review before any model invocation, and the summary SHALL disclose that such files were skipped.

#### Scenario: PR containing lockfile and source changes

- **WHEN** a pull request changes a lockfile and a source file
- **THEN** only the source file SHALL be sent for review
- **AND** the review summary SHALL note the skipped file count

### Requirement: Size caps with visible truncation

The system SHALL enforce a maximum reviewable diff size per run. When the diff exceeds the cap, the system SHALL truncate the reviewed content deterministically and MUST disclose in the review summary exactly what was not reviewed. Truncation SHALL never be silent.

#### Scenario: Oversized PR

- **WHEN** a pull request diff exceeds the configured size cap
- **THEN** the system SHALL review up to the cap
- **AND** the summary SHALL list or count the files/portions excluded by truncation

### Requirement: Structured findings against a severity rubric

The system SHALL produce findings as structured records containing severity, category, file, line, title, and body, with an optional concrete fix suggestion. Severity SHALL be one of critical, high, medium, low, or nit, assigned per an explicit rubric supplied to the model. Findings SHALL be limited to issues evidenced by the diff and its supplied context.

#### Scenario: Bug found in the diff

- **WHEN** the model identifies a defect in a changed line
- **THEN** the resulting finding SHALL include severity, category, file, line, title, and body
- **AND** a fix suggestion SHALL be included when a concrete fix is obvious

#### Scenario: Clean PR

- **WHEN** a review run finds no issues meeting the reporting threshold
- **THEN** the run SHALL complete with zero findings and a summary stating no issues were found

### Requirement: Do-not-report constraints

The system SHALL instruct the model with an explicit do-not-report list, and SHALL suppress findings that are pure style nits, speculative concerns without evidence, or issues in unchanged code below high severity.

#### Scenario: Style nitpick emitted

- **WHEN** the model emits a finding that is a formatting or style preference with no correctness impact
- **THEN** the finding SHALL be dropped before publishing

### Requirement: Malformed model output never crashes a run

The system SHALL parse model output defensively. Individually malformed findings SHALL be dropped without affecting valid ones, and entirely unparseable output SHALL cause the run to degrade to a summary-only result. A review run MUST NOT terminate with an unhandled failure because of model output shape.

#### Scenario: Partially malformed output

- **WHEN** the model returns a findings list in which some entries are missing required fields
- **THEN** the invalid entries SHALL be dropped
- **AND** the valid entries SHALL be published normally

#### Scenario: Unparseable output

- **WHEN** the model returns output that cannot be parsed as structured findings at all
- **THEN** the run SHALL complete by posting a summary noting the review could not produce findings
- **AND** the run SHALL NOT crash or retry unboundedly

### Requirement: Per-run cost cap and free-tier operation

The system SHALL enforce a per-run token/cost cap using real token counts from provider responses, and SHALL support a free-tier operation mode in which the entire pipeline runs at zero marginal cost using a free model tier. When the cap would be exceeded, the run SHALL stop further model calls and publish what it has, disclosing the early stop.

#### Scenario: Cost cap reached mid-run

- **WHEN** cumulative token cost during a run reaches the configured cap
- **THEN** no further model calls SHALL be made for that run
- **AND** findings produced so far SHALL be published with a notice that the review stopped early

#### Scenario: Free-tier mode active

- **WHEN** the system is configured for free-tier operation
- **THEN** all model invocations SHALL use the free-tier provider
- **AND** review runs SHALL complete without incurring paid usage

### Requirement: Incremental scope on re-review

On a re-review triggered by new commits to an already-reviewed pull request, the system SHALL scope analysis to the changes introduced since the last reviewed commit rather than re-analyzing the entire pull request.

#### Scenario: Small push to a large reviewed PR

- **WHEN** a one-file commit is pushed to a previously reviewed multi-file pull request
- **THEN** only the diff between the last reviewed commit and the new head SHALL be analyzed
