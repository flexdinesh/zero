# 0178: Agent-facing visual thread output

- Status: Accepted
- Date: 2026-11-20
- Extends: [0176](0176-visual-feedback-targets.md) (CLI and `show.md`),
  [0120](0120-review-feedback-threads.md)

## Context

0176 fixed how `zero feedback show` prints a screenshot thread. With it
implemented, four things read poorly for the agent that consumes it:

- The page's title, element name, text, and selector are the reviewed page's
  own words. They reached the agent's prompt as plain Markdown, where
  backticks or asterisks restyle the text and nothing says the words are
  unverified.
- A screenshot can be missing because zero dropped it for the storage budget
  or because its file vanished. Every surface said "removed to stay within
  the storage budget".
- Feedback is stored on the machine that serves the project. An agent that
  runs `zero feedback attachment` on the host, for a sandbox or remote
  project, got only "no feedback fb-… in <dir>".
- Copy as Markdown and the CLI drifted: the web printed fractional CSS
  pixels and every digit of the scale factor, and dropped the element's
  role and its text fallback.

## Decision

- **Page text in code spans.** The URL, title, element name or text, and
  selector print as Markdown code spans, fenced by one backtick more than
  their longest run and padded when they start or end with one. A role that
  is not a lowercase word is a code span too. The element line reads
  `Element (page's hint, unverified): <tag> [(<role>)] <name or text> ·
  <selector>`.
- **Pasted images say so.** A thread without `page` prints
  `Page: none (pasted image)` before its region.
- **Honest unavailable evidence.** The heading reads
  `screenshot (not stored)` and the line
  `Screenshot: not stored (dropped for the storage budget, or its file is
  missing); the region and page facts above still apply`. `zero feedback
  attachment` fails with the same cause and points at `show <id> --all`. The
  Feedback view reads "The screenshot isn't stored: it was dropped for the
  storage budget, or its file is missing. The thread stays." No stored field
  records which cause; zero cannot tell a vanished file from an evicted one
  without one, and the reader's next step is the same.
- **Where to run.** When a feedback ID is in no repository of this machine's
  store, `show <id>`, `reply`, `comment <id>`, and `attachment` add that
  feedback is stored on the machine that serves the project, and give the
  command inside a sandbox: `docker exec <container> /tmp/.zero/zero
  feedback …`. An ID this machine holds for another repository gets no
  advice.
- **One text.** Go is the reference: CSS pixels are whole (rounded), the
  scale factor has at most two decimals, and the web's Copy as Markdown
  prints exactly `show.md`, which now covers a fractional scale, the
  project's loopback, a role that differs from its tag, a backticked title,
  and a stored paste.
- JSON is unchanged: `available: false` and no `path` mean the image is not
  stored.

## Consequences

- Agents can tell page-supplied words from zero's facts, and a hostile page
  title cannot pose as Markdown structure.
- Agents that matched the old `(removed)` heading or unquoted URL must
  match the new text; 0176 shipped a day earlier.
- `TestFeedbackShowReadsLiveStorage` checks the whole path: the web app
  stores a code thread, a capture, and a paste; the CLI reads, crops, and
  replies over the same store; the web app sees the reply; a missing file
  reads as not stored.
