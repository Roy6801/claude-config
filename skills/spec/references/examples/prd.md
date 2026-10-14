---
slug: bulk-question-import
size: prd
status: draft
ticket: #123
---

# Content admins can import a chapter of questions from a CSV

## Problem
Asked: "Let admins upload questions in bulk."
Real: Content admins add questions one at a time through the question editor. Loading a 60-question chapter takes about 3 hours, so new courses launch weeks late. Two partner schools sent their banks as spreadsheets and are waiting on us (#123, #internal-content thread 2026-09-28).

## Journey
1. The admin opens the course, then Question Bank, then Import.
2. They download the CSV template, fill it in, and upload it.
3. The preview lists every row with its status: ready, warning, or error with a reason.
4. They fix errors in the sheet and re-upload, or import only the ready rows.
5. The bank shows the new questions, tagged with the import batch.

## MVP
Single-answer and multiple-answer questions, up to 500 rows, with the preview and per-row errors. Deferred: images in questions, updating existing questions by id, and imports from Google Sheets links.

## Success metric
Median time to load a 60-question chapter, measured from the import events. Baseline: about 3 hours (manual entry, from the admin survey). Target: under 15 minutes within two weeks of release.

## Acceptance criteria

### AC-1 [happy] A valid CSV imports every row
- Given a content admin on the Question Bank screen of "Psych Workbench Unit 3" with 120 questions
- When they upload a 50-row CSV that matches the template
- And confirm the preview
- Then the bank shows 170 questions and a toast says "50 questions imported"
- Source: #123 description: "admins need to load a full chapter at once"
- Verify: manual on staging with the 50-row sample CSV; check the count and toast

### AC-2 [error] Invalid rows are reported before anything is written
- Given a 50-row CSV where rows 7 and 31 have no correct answer marked
- When the admin uploads it
- Then the preview shows 48 rows ready and 2 errors, each with its row number and the reason "no correct answer", and nothing is saved yet
- Source: #internal-content thread 2026-09-28, Priya: "half-imported banks are worse than nothing"
- Verify: manual, upload the broken sample CSV and confirm the bank count is unchanged

### AC-3 [edge] An admin can import only the ready rows
- Given the preview from AC-2
- When the admin chooses "Import 48 ready rows"
- Then 48 questions are added and the 2 failed rows are offered as a downloadable CSV with an error column
- Source: user, this session (2026-10-09): "they should not have to fix everything before importing anything"
- Verify: manual; open the downloaded CSV and check it holds exactly rows 7 and 31

### AC-4 [perm] Only content admins see Import
- Given a learner and an instructor, each viewing the same course
- When they open Question Bank
- Then neither sees the Import button, and a direct request to the import endpoint returns 403
- Source: existing behaviour, question editing is restricted to the content-admin role (apps/hub/src/permissions/roles.ts:18)
- Verify: automated permission test plus a manual check with the instructor staging account

### AC-5 [perf] A 500-row import finishes quickly
- Given a 500-row CSV that matches the template
- When the admin uploads and confirms it
- Then the preview appears within 5 seconds and the import completes within 30 seconds
- Source: user, this session (2026-10-09): "500 rows is the MVP limit"
- Verify: timed manual run on staging; durations from the import events

### ~~AC-6 [edge] Duplicate questions are merged automatically~~
- Superseded: user, 2026-10-09: merging silently changes content admins' work; duplicates are flagged instead (AC-7)

### AC-7 [edge] Likely duplicates are flagged in the preview
- Given a CSV with a row whose stem matches an existing question in the bank word for word
- When the admin uploads it
- Then that row is marked "possible duplicate of Q-1042" with a warning, and it is still importable
- Source: user, this session (2026-10-09), replacing AC-6
- Verify: manual, include one copied stem in the sample CSV and check the warning

### AC-8 Import outcome is tracked
- [ ] A `question_import_completed` analytics event fires with course id, row count, error count and duration
- Source: #123 description: "we need to see how long imports take and how often they fail"
- Verify: event visible in the analytics debugger after one staging import

## Non-goals
- Editing existing questions through the import.
- Importing images, audio or rich formatting.
- Any learner-facing change.

## Risks and constraints
- Large files could block the request thread. Mitigation: parse in a background job and poll for the preview.
- Partner spreadsheets may use other column orders. Mitigation: the template is the only accepted format for the MVP; mapping columns is deferred.
- Deadline: the first partner course launches on 2026-11-02.

## Demo milestones
- 2026-10-16: upload and preview with per-row errors on staging (AC-1, AC-2).
- 2026-10-23: partial import, duplicates, permissions and the 500-row timing (AC-3 to AC-7).
- 2026-10-28: release behind the flag to the two partner schools' admins.

## Release notes
- Flag: `bulk-question-import`, on for internal content admins first, then the two partner schools.
- Rollback: turn the flag off. Imported questions are ordinary questions tagged with their batch, so they stay valid; a batch can be deleted from the bank if needed.
- Monitoring: import failures alert in Sentry; the success metric is read from the import events.

## Definition of done
- [ ] In production behind `bulk-question-import`
- [ ] Tests for parsing, validation and permissions
- [ ] Analytics event validated (AC-8)
- [ ] Monitoring: Sentry alert on import failures
- [ ] Demo: a screen recording of the journey, linked from the PR
- [ ] Docs: import template and guide linked from the Question Bank

## Open questions
- Should the batch tag be visible to learners? Assumed no; needs a decision before AC-1 is approved.
- Is 500 rows enough for the second partner's largest chapter (they mentioned "about 600")?

## Grilled
- XY: "upload in bulk" became "load a chapter in minutes, without half-imported banks", which added AC-2 and AC-3.
- AC-6 was challenged ("would an admin ever want a silent merge?") and replaced by AC-7.
- Dropped as slop: "CSV upload uses the standard file picker" (tests the framework) and "Import works" (restates the title).
- Success metric was challenged for being unmeasurable; it now reads from the import events with a survey baseline.
