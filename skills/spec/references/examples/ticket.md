---
slug: retry-failed-question-generation
size: ticket
status: draft
ticket: #481
---

# Content admins can retry a failed AI question generation

## Problem
Asked: "Add a retry button when question generation fails."
Real: When the generation job fails (model timeout or a rejected source PDF), the admin sees a spinner that never ends and has to reload and re-enter the topic, chapter and count. They lose about two minutes per failure and some assume the feature is broken. Support logged 14 such reports in September (#481).

## Acceptance criteria

### AC-1 [error] A failed generation shows the failure instead of an endless spinner
- Given a content admin on the Generate Questions panel of the "NCLEX Pharmacology" course
- When the generation job for 20 questions on "Anticoagulants" fails with a model timeout
- Then the spinner is replaced within 5 seconds by "Generation failed: the model timed out" and a Retry button
- Source: #481: "spinner just sits there forever, I refreshed three times"
- Verify: manual on staging with the generation timeout forced to 1 second; screenshot of the failed state

### AC-2 [happy] Retry reuses the original request
- Given the failed state from AC-1
- When the admin clicks Retry
- Then a new job starts with the same topic, chapter and count, and no fields need re-entering
- Source: user, this session (2026-10-09): "retry should not make them fill the form again"
- Verify: manual, click Retry and confirm the new job's request matches the original in the network panel

### AC-3 [edge] A rejected source document is not retried blindly
- Given a generation that failed because the uploaded PDF has no extractable text
- When the failure is shown
- Then the message says "This PDF has no readable text" and offers Replace source instead of Retry
- Source: existing behaviour, the job already returns the reason `SOURCE_UNREADABLE` (services/generation/errors.ts:31)
- Verify: manual, upload the scanned-image sample PDF on staging and check the message and button

### AC-4 Failures are visible in monitoring
- [ ] Each failed generation logs its failure reason and course id so failures can be counted per reason
- Source: user, this session (2026-10-09): "we need to know which failure reasons are most common"
- Verify: Sentry shows one event per forced failure with the reason tag

## Non-goals
- Automatic retries without the admin clicking.
- Changing the generation model or its timeout.

## Definition of done
- [ ] Deployed to production (no flag: the change only affects an existing error path)
- [ ] Tests for the failure-state rendering and the retry request
- [ ] Monitoring: failure reason tagged in Sentry
- [ ] Demo: 1-minute Loom of AC-1 to AC-3 on staging

## Open questions
- Should Retry be rate limited (for example, three retries per minute)? Assumed no; not an AC until the user decides.

## Grilled
- Challenged "add a retry button" (XY): the real pain is the endless spinner and re-entering the form, so AC-1 covers showing the failure at all.
- Dropped "Retry button is blue": it restates the design system and cannot fail on its own.
- Added AC-3 after asking what happens when retrying cannot help.
