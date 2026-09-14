# ADR 0001: Use executable AI-readiness controls

## Status

Accepted

## Context

FixLab coordinates agent-driven diagnosis, code changes, application startup,
browser validation, evidence, and pull-request preparation. Prose guidance
alone cannot prove that these operations remain safe or repeatable.

## Decision

FixLab will pair agent-facing instructions with executable repository controls:

- one lock-file-backed validation command;
- pull-request checks with machine-readable evidence;
- deterministic documentation drift validation;
- explicit review ownership;
- bounded cleanup restricted to FixLab-owned artifact roots;
- periodic CodeBlend reassessment after meaningful loop changes.

Semantic agent review may identify opportunities but cannot replace blocking
deterministic validation.

## Consequences

Changes that alter the engineering loop must update their tests and directly
related documentation. Validation failures remain visible rather than being
converted into success-shaped fallbacks. Readiness improvements are selected
for engineering value first and score impact second.
