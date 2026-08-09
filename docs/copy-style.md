# OpenBook copy style

## Voice

Warm and direct. Talk to the user in plain words about their stuff ("your pages", "nothing leaves your machine"). No marketing fluff, no jargon where a plain word works, no scare-caps (write "not this page", never "NOT this page").

## Sentence budget

- Buttons and labels: 3 words or fewer.
- Hints, descriptions, notices: one sentence where possible, two short ones max.
- If a hint needs a third sentence, it is probably explaining a mechanism the user doesn't need — cut the mechanism, keep the consequence.

## Danger copy

Consequence first, then what is kept. Every destructive confirm answers two questions: what happens, and what is safe.

> "Resets appearance, language, and layout on this device, then reloads. Your pages and libraries are kept."

Irreversibility is stated plainly: "This can't be undone."

## Security and privacy caveats

Shorter, never weaker. A caveat must keep saying what is exposed, what stays private, and what can't be undone — trim words, not facts. When unsure whether a fact is load-bearing, keep it.

## Placeholders and sync rules

- Never rename, add, or drop a `{var}` placeholder; each appears exactly once.
- Some strings must mirror others word-for-word (e.g. `sharing.accessPublished` ↔ `forwarding.visibility.publishedOption`; the "Everything else stays private." echo). These are marked with code comments in `en.ts` — change both or neither, in every locale.

## Before / after

1. `agentEdits.modeHint`
   - Before: "Suggest keeps a human in the loop — every agent change waits as a suggestion for you to accept or reject. Direct lets MCP clients and the built-in AI edit pages immediately, with no suggestion step; the edits are attributed in the page's history."
   - After: "Suggest holds every agent change as a suggestion for you to accept or reject. Direct lets agents edit pages immediately — every edit is still attributed in the page's history."

2. `share.unclaimedNotice`
   - Before: "Sharing takes effect once you claim this library. Until then, anyone who can reach it can view and edit — these settings are saved but not yet enforced."
   - After: "These settings are saved, but take effect only once you claim this library. Until then, anyone who can reach it can view and edit."

3. `agents.enableHint`
   - Before: "Off by default. While off, agent tokens do not authenticate and none can be minted. Nothing is exposed until you turn this on."
   - After: "Off by default — nothing is exposed until you turn it on. While off, agent tokens don't authenticate and none can be created."
