# repo-configuration Specification

## Purpose

Let each target repository control whether and how it is reviewed through a committed config file and an optional house-rules file, with safe defaults that keep reviews working when configuration is missing or broken.

## ADDED Requirements

### Requirement: Repo-committed configuration file

The system SHALL read a configuration file committed to the target repository at a documented path, and SHALL honor at minimum: an enable/disable toggle, a minimum severity threshold for reported findings, and a list of ignored path globs excluded from review.

#### Scenario: Reviews disabled by config

- **WHEN** the repository's config file disables the reviewer
- **THEN** no review runs SHALL start for that repository's pull requests
- **AND** no comments SHALL be posted

#### Scenario: Severity threshold applied

- **WHEN** the config sets a minimum severity threshold
- **THEN** findings below that severity SHALL NOT be published inline or in the summary

#### Scenario: Ignored paths excluded

- **WHEN** the config lists path globs to ignore
- **THEN** files matching those globs SHALL be excluded from review
- **AND** findings SHALL never be reported against excluded files

### Requirement: Configuration read from the reviewed revision

The system SHALL load the configuration as it exists in the repository for the pull request being reviewed, so config changes take effect without any redeployment of the reviewer.

#### Scenario: Config updated in the repository

- **WHEN** a repository's config file is changed and a new pull request is reviewed afterward
- **THEN** the review SHALL reflect the updated configuration

### Requirement: Optional house-rules file suppresses conflicting findings

The system SHALL support an optional house-rules file in the target repository whose stated conventions are supplied to the review. A finding that contradicts an explicit house rule SHALL be suppressed rather than published.

#### Scenario: House rule covers a flagged pattern

- **WHEN** the house-rules file states that a pattern is intentional (e.g. "we intentionally use X")
- **AND** the review produces a finding objecting to that pattern
- **THEN** the finding SHALL be suppressed before publishing

#### Scenario: No house-rules file present

- **WHEN** the repository has no house-rules file
- **THEN** reviews SHALL run normally with no house-rule suppression applied

### Requirement: Safe defaults when configuration is missing or invalid

When the config file is absent, the system SHALL run with documented safe defaults (reviews enabled, default severity threshold, standard noise-file ignores). When the config file exists but cannot be parsed or contains invalid values, the system MUST NOT crash or skip the review; it SHALL fall back to the safe defaults and surface a visible notice of the config problem in the review summary.

#### Scenario: No config file in the repository

- **WHEN** a pull request is reviewed in a repository with no config file
- **THEN** the review SHALL run with the documented default settings

#### Scenario: Invalid config file

- **WHEN** the config file exists but is malformed or contains invalid values
- **THEN** the review SHALL proceed using the safe defaults
- **AND** the review summary SHALL include a notice that the configuration was invalid and defaults were used
- **AND** the run SHALL NOT terminate with an error
