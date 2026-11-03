# Review design

## Review judgment

The review criteria adapt Matt Pocock's
[Fixing the PR Bottleneck](https://www.youtube.com/watch?v=LlgiOCmFG_w)
(AI Engineer, September 26, 2026): tests should disprove plausible broken
behavior, reviewers need repository-specific standards, and human attention
should follow reversibility and blast radius. Reverting code cannot undo an
external message, charge, or data loss. Green CI therefore cannot authorize
merging an irreversible, broad, or materially uncertain change.

Michael Thiessen's
[PR review agent thread](https://x.com/MichaelThiessen/status/2113346979757523382)
(October 2026) motivated reducing duplicated prompt process rather than adding
review stages. Its reported cost/quality improvement is not a measurement of
this bot. [Standing policy](../agent/instructions.md) owns target, publication,
fix, and merge authority; [review-changes](../agent/skills/review-changes/SKILL.md)
owns review judgment. Prefer a deterministic gate for enforceable invariants;
add prompt rules for demonstrated judgment failures.

The [RADAR paper](https://arxiv.org/pdf/2605.30208), Sections 2.6–2.8, motivates
separating semantic assessment from readiness. An assessment records judgment
at a reviewed SHA; fresh GitHub evidence independently controls the write.
Neither layer replaces branch protection. Mandatory human approval belongs in
GitHub policy, with the App excluded from bypass lists.

## Capability boundaries

Prefer the GitHub Tools extension. Local operations fill specific gaps in the
installed SDK 1.18 / extension 0.9 surface:

| Operation                 | Missing native capability                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Record merge assessment   | Structured local review judgment bound to policy version, turn, and signed webhook target.                     |
| Direct squash merge       | The extension merge tool omits GitHub's `sha` precondition; its overrides cannot replace schemas or execution. |
| Enable/disable auto-merge | The extension has no tools for these GraphQL mutations.                                                        |
| Resolve App identity      | No authenticated-App metadata tool; the public Octokit client exposes `GET /app`.                              |

GitHub operations reuse the SDK's public client and existing App token provider.
Review publication stays in the extension executor with a local approval
predicate. Revisit these exceptions when upstream supplies the missing
capabilities. Automatic thread resolution is excluded because its thread-only
input cannot select this App's repository installation.

The bot once opened and merged its own PR #23 despite instructions forbidding
self-merges. Branch and PR creation are now excluded, and the merge gate checks
commit authorship independently. `requireApproval: false` avoids parking
unattended webhook turns; deterministic predicates deny disallowed reviews and
merges without asking a person. Capability exclusions and GitHub permissions
limit authority even if the model misjudges repository content.

File fixes use `createOrUpdateFile`, one commit per call, and are checked by CI
after committing. The file SHA guards content, but the tool does not bind the
branch to the reviewed head. Refresh-before-write remains an instruction-level
race mitigation. Bot-authored commits always need human review and merge.

## Conversation and publication

A final assistant reply appeared on
[Shipshape PR #111 after it merged](https://github.com/aranlucas/shipshape-mcp/pull/111#issuecomment-6236400129).
Eve's default `message.completed` delivery caused it. The channel suppresses
that automatic delivery for PR conversations while retaining issue replies;
explicit tool writes still need their own freshness controls.

Native threads and one updated timeline summary keep review history in GitHub.
A model repeated a successful summary-create call, so its tool result now points
to the existing comment ID. This discourages repeats but cannot enforce exactly
one summary across concurrent events or ambiguous write outcomes.

Short, evidence-linked findings and explicit reconsider/verify paths were
informed by observational studies:
[Cynthia et al.](https://arxiv.org/abs/2607.21997v2) found code suggestions strongly
associated with resolution; [Lin et al.](https://arxiv.org/abs/2607.03316v2) found
invalid, redundant, out-of-scope, and intent-misaligned feedback often rejected.
These findings motivate interaction design, not a claimed success rate for PR Bot.

## Portfolio boundary

[Shipshape](https://github.com/aranlucas/shipshape-mcp) owns portfolio adoption
and shared prevention; PR Bot owns one PR's review and merge decision. A root
`coding-standards.md` is an adoption signal, not proof of review quality. A
confirmed process gap can motivate a separate reviewed standards/catalog change
with its triggering case and intended check. Changing this repository does not
publish Shipshape's catalog, and current adoption results do not prove recurrence.
