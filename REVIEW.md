# Technical Review — Supplier Document Router

Reviewer: Claude Code (external review)
Date: 11 August 2026
Scope: design review of the System Report dated 11 August 2026. The repository
contained no source at review time, so every code-level claim below is based on
the report; items marked **verify in code** should be checked against `Code.gs`.

## Summary verdict

The architecture is appropriate for the scale and the constraints, and the
cost-control pipeline is genuinely well designed. The system is safe to keep
running for statements. However, four things should be fixed **before**
`FORWARD_INVOICES_TO_HUBDOC` is switched on, because email forwarding is the
first sink in this system that is neither idempotent nor visible when it
duplicates: (1) a run-level lock, (2) a sent-forward ledger, (3) deterministic
statement filenames keyed on sender rather than on Claude's spelling, and
(4) the two credential items already on the launch checklist (Anthropic key
rotation, GCP org policy re-enable) done today rather than "at launch".

---

## Q1 — Architecture: is Apps Script defensible?

Yes, and I would not migrate now. Two mailboxes at 10–30 relevant emails/day is
roughly two orders of magnitude below where this platform strains. Cloud
Functions/Run would buy parallel fetches and a PDF library, and cost you
hosting, IAM, deployment tooling, and monitoring — all things the owner
explicitly does not want to operate from an iPad.

The first limits I expect to bite, in order:

1. **The 20-installable-trigger cap per script per user.** One-shot
   `runFollowUp` triggers created with `ScriptApp.newTrigger(...).after(...)`
   are *not* automatically removed after firing — they stay in the trigger
   list as dead entries. A long backfill that books dozens of follow-ups will
   hit "This script has too many triggers" and the resume chain silently dies,
   which looks exactly like the §5 bug that was already fixed once.
   **Verify in code:** `runFollowUp` must delete its own (and any stale)
   one-shot triggers at the top of the run
   (`ScriptApp.getProjectTriggers()` → `deleteTrigger` for fired one-shots).
2. **Total daily trigger runtime** (6 h/day on Workspace). Hourly 5-minute
   runs alone consume 2 h/day; a backfill chain resuming every 3 minutes on
   top of that can approach the cap during catch-up weeks. Not a design
   problem, just a reason backfills can stall near end of day.
3. **Script Properties** (9 KB/property, 500 KB total) is comfortably far off
   at a 200-entry skip cap and tens of suppliers.

Migration trigger, if it ever comes: needing PDF manipulation (the Water World
sub-page split) or invoice volume growing ~10×. Until then, staying put is the
right call.

## Q2 — State races: add LockService. Promote to fix-now.

Overlap is not hypothetical. Google fires hourly triggers with up to ~15 min
of jitter, and a `runFollowUp` booked 3 minutes after a 5-minute run can still
be executing when the next hourly fires. The property-blob races are the
*benign* consequence (a lost skip count or a re-learned supplier heals
itself). The dangerous race is upstream of the properties: **two concurrent
runs both execute the Gmail query before either applies the `Processed`
label**, and both process the same messages. For Dropbox that means autorename
duplicates (visible, annoying — and you are already hand-cleaning exactly this
class of duplicate). For Hubdoc, once forwarding is on, it means the same
invoice emailed twice into bookkeeping, which is invisible until the
accountant queries a doubled bill.

The fix is three lines and the simplest possible pattern — singleton runs, not
fine-grained locking:

```js
const lock = LockService.getScriptLock();
if (!lock.tryLock(0)) return; // another run is active; the rolling window
                              // guarantees this mail is seen next run
```

`tryLock(0)` (bail immediately) is better than `waitLock` here: the rolling
45-day window means a skipped run loses nothing, whereas a queued run just
recreates the overlap a few minutes later.

## Q3 — Idempotency: make the sinks idempotent instead of the pipeline transactional

You cannot get transactions out of Apps Script — label application and Dropbox
upload can never be atomic. Applying the label *before* processing inverts the
failure into silent loss (marked done, never filed), which is strictly worse.
So keep at-least-once delivery and make each sink tolerate replay:

- **Dropbox: switch `mode:add`+`autorename` to `mode:overwrite`.** The path
  `YYYY-MM/YYYY-MM_<Supplier>.pdf` is already deterministic, so a replayed
  upload converges on the same file instead of minting ` (1).pdf`. This also
  permanently retires the §7 cleanup chore (3× Wanless Feb, 3× JF Master Poly
  May are repeated *reminder emails* re-filing the same statement — under
  overwrite they collapse to one file, forever, with no manual cleanup). The
  only thing overwrite "loses" is two genuinely different documents landing on
  the same supplier+month, and for statements the later one is the one the
  accountant wants anyway.
- **Hubdoc: keep a sent ledger.** Before building the MIME message, check a
  small JSON property mapping `messageId|attachmentName → sent-timestamp`;
  write the entry immediately after `send` returns, before labeling. A crash
  between send and label then replays into a ledger hit and skips. Cap and
  age-out the ledger (anything older than the 45-day window can be evicted).
  This is the one sink where duplicates are both invisible and externally
  consequential, so it deserves the extra property.

With those two changes, the current "label after all attachments" placement is
fine as-is.

## Q4 — Classification design

The two-stage design (cheap text triage → full PDF read) is the right shape,
and the bias rules (any statement hint → `statement`, bare reference subjects
→ `unclear`) are correctly aimed at the worst failure. Keep Sonnet for both
stages — the token savings from a cheaper triage model are pennies at this
volume and you already measured Haiku's instability. Suggestions, in value
order:

1. **Move period sanity out of the prompt and into code.** Both observed
   wobbles (Lincoln Sentry 2026-07 vs 2026-05; a 2026-09 invoice) are
   post-hoc detectable: reject any `period` later than the current month and
   any period more than ~13 months in the past → route to Needs-review
   instead of filing. A model will always occasionally misread an ambiguous
   date range; a two-line validator makes the failure loud instead of
   misfiling. While there, pin the prompt's definition: "period = the
   statement's closing/as-at month, not the send month, never a future
   month."
2. **Stop deriving the filename supplier from Claude's output for known
   senders.** Häfele filed under two spellings and Cordell misfiled because
   the filename trusts per-run model output. You already have a
   domain→supplier store (`AUTO_SUPPLIERS`). Make it canonical: first
   confirmed statement from a domain fixes the display name; every later
   statement from that domain reuses the stored name, and Claude's `supplier`
   field is only consulted for never-seen senders. This makes filenames
   stable per sender, kills the diacritic/spelling dupes, and narrows the
   own-company guard problem (Cordell's domain would have been visibly wrong
   at learn time, one `forgetSupplier` fixes it globally).
3. **Force the JSON shape with tool-use/structured output** rather than
   free-text JSON, and set `temperature: 0` if not already — both reduce
   parse failures and run-to-run flip-flops at zero cost. **Verify in code.**
4. **Prompt caching** (`cache_control` on the static system prompt) is free
   to add but the prompts are small; savings are marginal. The **Batch API**
   would halve token cost and an hourly filer could tolerate its latency, but
   it forces a submit-then-poll redesign of the run loop — at cents per day,
   not worth the complexity. Both are "nice, not now".

## Q5 — Fingerprint scheme failure modes

The blank-subject guard shows the right instinct; here are the ones not yet
hit:

1. **One-subject-fits-all senders.** Digit normalization means a supplier
   whose system sends *everything* under one template — "Document DOC-#####
   from Acme" for quotes, invoices, and statements alike — reaches count 2 on
   two junk documents and then silently skips real statements forever. The
   relay-domain guard catches Xero/MYOB, but a supplier's own ERP doing this
   is the same failure from an unguarded domain. Mitigation: **never learn a
   skip whose domain is in the seed list or `AUTO_SUPPLIERS`** — known
   suppliers' mail should always at least reach free triage. This is the one
   change I'd actually make to the scheme.
2. **Classification wobble feeding the learner.** Water World's batch file
   has been called "other" in past prompt iterations. Two wobbly "other"
   verdicts on a real supplier is a permanent free skip. The guard in (1)
   covers this too, which is why I'd prioritize it.
3. **45-char truncation collisions.** Long templated subjects that differ
   only after char 45 collapse into one fingerprint. Low probability, same
   silent-skip consequence; the known-supplier exemption is again the
   backstop.
4. **Evict-lowest is evict-newest.** Every pattern enters at count 2, so at
   the 200 cap you evict the patterns you just learned and keep stale
   high-count ones from senders that may no longer email you. Tie-break
   eviction on last-seen timestamp instead. Cosmetic at current volume.

## Q6 — Security

The honest framing: domain-wide delegation with `gmail.modify` + `gmail.send`
means **anyone who can edit this script can read and send mail as any user in
the domain** — the script project, not the SA key file, is the crown jewel,
because Script Properties are readable by every editor. Hardening that adds no
infrastructure:

1. **Rotate the Anthropic key today**, not at launch — it leaked into a
   screenshot; rotation is a 2-minute task and the exposure clock is running.
2. **Re-enable the two GCP org policies now** (you've confirmed the minted key
   survives enforcement). Every day they're off, any project in the org can
   mint SA keys.
3. **Audit script sharing**: the Apps Script project and its GCP project
   should be visible to exactly one account (owner), with 2FA. Remove any
   collaborator added during the build.
4. **DWD scope check**: confirm the delegation grant in Admin Console lists
   exactly `gmail.modify` and `gmail.send` and nothing broader. `modify` is
   sadly the floor for label writes — `gmail.labels` alone can't relabel
   messages — so this is as narrow as the design allows.
5. **Calendar a yearly SA-key rotation.** Keys in Script Properties never
   expire and never get looked at again otherwise.
6. Accept the rest. The genuinely tighter alternative (two script
   deployments, each running under its own mailbox's OAuth via `GmailApp`, no
   service account at all) eliminates DWD entirely but doubles the operational
   surface — a defensible trade the owner already declined once, and I agree
   at this scale.

## Q7 — Promote from "accepted" to "fix now"

Before `FORWARD_INVOICES_TO_HUBDOC = true`:

1. **LockService singleton guard** (Q2) — duplicate forwards are the first
   invisible external failure this system can produce.
2. **Hubdoc sent ledger** (Q3) — same reason, covers the crash-replay path
   the lock doesn't.
3. **Dropbox `mode:overwrite`** (Q3) — converts the recurring manual
   duplicate cleanup into a non-event.
4. **Canonical supplier names from the domain store** (Q4.2) — fixes the
   Häfele-dupes and Cordell-misfile *class*, not the instances.
5. **Period validator, no future months** (Q4.1).
6. **Credential items** (§7 #6–7) — do today; they are independent of the
   backfill and the clock on the leaked key is running.
7. **Verify one-shot trigger cleanup** (Q1) — if `runFollowUp` doesn't delete
   fired triggers, the resume chain will die mid-backfill at the 20-trigger
   cap, reproducing the exact symptom of the bug already fixed once.

Everything else in §7 is correctly accepted: sub-page splitting (right call —
`one_per_page=false` → forward whole is the correct degradation), encrypted
rego PDFs to Needs-review, the bare "Invoice: " subject, and the recurring
blank-subject triage cost are all fine as designed.

## Smaller notes

- `MAX_RUNTIME_MS` at 5 minutes: make sure the check runs *before* starting a
  classification with margin ≥ one worst-case Claude PDF round-trip plus
  labeling/digest time (~60–90 s), or the 6-minute hard kill can still land
  mid-message. **Verify in code** which side of the call the check sits on.
- The own-company guard should also consider the *sender*: a statement whose
  issuer Claude names as a customer but which arrived from a Top Cab address
  (or was CC'd back) is outgoing paperwork regardless of the issuer field.
  This would have caught the Cordell case from the other direction.
- The digest's "another run is already booked" line, `whatAmIMissing`, and
  `clearProcessedLabels` are exactly the operational affordances this kind of
  system needs — the observability story is stronger than most systems ten
  times this size. Keep that discipline as features get added.
