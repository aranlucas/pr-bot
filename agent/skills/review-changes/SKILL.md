---
name: review-changes
description: Review GitHub pull requests for concrete defects by tracing changed behavior, checking primary code evidence, and challenging suspected findings before publishing.
---

# Review changes

Review the current PR with the native GitHub tools. Scale the investigation to
the changed behavior and its consequences. A small documentation or formatting
change can finish with the supplied diff. A behavior change needs enough context
to explain who calls it, what can fail, and why the patch causes that failure.

## Establish the change

Refresh `github__getPullRequestContext` and record `headSha`. Describe the intended
outcome and the observable behavior before and after the patch. Treat the PR's
explanation as a claim to check against the code.

Identify the invariants an experienced maintainer would check for this change.
Choose a concrete input, caller, or sequence of events that would expose a broken
invariant. Keep this planning inside the review until you have a result.

## Gather primary evidence

Start with the actual patch, changed code, and relevant callers or tests. Use
`github__getFileContent` with `ref` set to the reviewed commit SHA when surrounding
code is needed. Read only the ranges that resolve a specific question. Use base
commit code when you need to distinguish a new regression from existing behavior.

Account for the changed-file inventory before claiming full coverage. The context
response can omit files with `filesOmitted > 0` even when `filesHasMore` is false.
If either indicates missing files, list files with `github__listPullRequestFiles`
from page 1 and follow its `hasMore` and `nextPage` metadata. Request
`includePatch: true` for needed patches. A missing patch or truncated response is
an evidence gap; recover it with file reads when possible. If it prevents
assessing a material change, state the limitation.

Use search or blame to locate relevant code, then verify the code at the reviewed
commit. A search excerpt or previous review comment is a lead to investigate.
Follow a change into an unchanged file only when the dependency can affect the
changed behavior. Finish that investigation once the specific question is settled.

## Challenge each suspected defect

Trace the failing case through the implementation. Look for a caller constraint,
validation, framework behavior, or existing invariant that would make the finding
wrong. Confirm that the patch introduces the failure rather than exposing a
pre-existing issue.

Keep a finding when you can connect the changed lines, a reachable triggering
condition, and a concrete consequence. Name the affected file or lines. Rank the
finding by its impact, and state any condition it depends on. Drop it when the
counterevidence explains the behavior or the consequence remains speculative.

Check whether the implementation achieves its stated goal. A general tradeoff
inherent in that goal is not a defect. An unintended consequence or concrete
vulnerability still is, even when the PR calls it intentional. Keep style
preferences and optional improvements out of the findings.

## Check what the evidence proves

Compare the failing case with relevant tests and available check results. A
test omission matters when a meaningful behavior change has a specific untested
failure case. Missing unrelated context, unavailable runtime results, and absent
tests for prose changes are not findings by themselves.

Distinguish source reasoning, a test you read, and an observed check result.
Describe only verification that actually happened. Passing CI supports readiness
but does not establish that the changed behavior is correct. Use
`includeChecks: true` on the context refresh when obtaining CI state, and follow
up on incomplete results before deciding readiness under the standing rules.
Keep CI and approval status in the readiness assessment, separate from defects
in the changed code.

## Finish the review

Remove unsupported findings and combine duplicate symptoms of the same defect.
Publish a completed review that describes the assessed change and its result,
with findings ordered by severity. For a clean low-risk change, state that no
concrete defects were found in the supplied diff. State a review limitation only
when it explains a material risk in the changed behavior.

Follow the standing instructions for the reviewed SHA, publication, and merging.
Review the new changes if the head moves before completion.
