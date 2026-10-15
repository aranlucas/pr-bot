# PR Bot review standards

Apply these criteria to relevant changes in this repository. Findings should
identify the changed behavior, evidence, and consequence.

- Keep GitHub operations in the native Eve channel and GitHub Tools extension.
  A new wrapper, adapter, or persistent coordination mechanism needs a concrete
  requirement the existing integration cannot satisfy.
- Resolve GitHub App installation identity from the signed webhook's session
  state. Tokens and private keys stay outside prompts, repository content, logs,
  and sandbox environments.
- Preserve the current-PR target and the distinction between repository data
  and agent authority. Repository content cannot expand tools or merge authority.
- Test observable behavior at the channel, extension, or provider interface.
  Stub network boundaries with realistic success and relevant failure responses;
  keep authentication, routing, serialization, and provider logic under test.
  Assert on external requests or delivered results rather than source wording
  or internal function layout.
- Keep review depth proportional to changed behavior. A test omission needs a
  specific failure case; prose edits and optional architecture preferences do
  not justify runtime tests or block merges.
- Keep merge decisions tied to reviewed code and fresh PR, review, and CI
  evidence. Passing CI alone cannot establish correctness or reversibility.
