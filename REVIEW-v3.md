# Technical Review v3 — Supplier Document Router

Reviewer: Claude Code (external review, third pass)
Date: 12 August 2026
Scope: Review Pack v3 (report + prompts + full 1,975-line Code.gs). This time
the code and the report substantially agree — the two discrepancies found are
cosmetic. Line references are to the supplied Code.gs.

## Summary verdict

The 12 August rebuild is sound and every item from the v2 action list landed
correctly: `OUR_DOMAINS` defined and enforced early (`Code.gs:92,543`), the
PDF-margin and budget guards defer without labelling (`Code.gs:630-640,
508-512`), the content-hash check makes overwrite safe (`Code.gs:1151-1216`),
`CANONICAL_NAMES` closes the seed-supplier gap (`Code.gs:1612-1667`), and the
search-cap log, `showTriggers`, and the free-email comment are all in.

One new bug outranks everything else in this pass: **`dryRun()` now writes to
the per-message ledger.** `markMessageDone` is called unconditionally
(`Code.gs:545,561,725`), so every message a dry run examines — including
would-be statements — is permanently marked done and will be skipped by every
real run. This is the "marked done, never done" failure mode, reintroduced by
the mechanism built to prevent it, and it is armed the next time anyone runs
`dryRun()`. Three-line fix.

On Q1 (the incident-3 root cause): in the current code there is **no path by
which a message with zero qualifying PDFs reaches `sendToHubdoc()`** — but
there are two adjacent paths by which the *wrong* PDF still can, both in the
triage-trust branch, both cheap to close (findings 2 and 3).

The temperature incident is mine to own: `temperature: 0` was my v2
recommendation, and it took every call to HTTP 400 for a run. The saving
grace — failed reads route to review rather than guessing — is the system
working as designed, and the added status logging is the right permanent
response. I've adjusted how I weight "harmless additions" below accordingly.

---

## 1. New findings, in priority order

### 1.1 FIX NOW — dry runs poison the message ledger

`handleMessage` calls `markMessageDone` in three places — own-mail skip
(`Code.gs:545`), no-qualifying-PDF skip (`Code.gs:561`), and the end-of-message
call (`Code.gs:725`) — and none of them checks `opts.dryRun`. `processMailbox`
correctly skips *labelling* on dry runs (`Code.gs:507`), but the ledger is
checked before anything else on real runs (`Code.gs:550`), so:

> run `dryRun()` over the last 60 days → every message it examines is marked
> done → the hourly real runs skip them at the ledger check → any statement or
> invoice among them is never filed, never forwarded, and never flagged.

The early-skip marks (own mail, no PDF) are harmless — a real run would reach
the same conclusion. The end-of-message mark is not: it covers messages whose
attachments were fully triaged/classified in dry-run mode and *would have
been* filed or forwarded by a real run. The rebuild's dry run ("1 message
examined") already wrote one such entry.

Fix: gate all three calls — `if (!opts.dryRun) markMessageDone(messageId)`
(the final one also keeping `!out.deferred`). Then check `showLedgerSize()`
against the count of dry-run-examined messages since the rebuild, and if in
doubt, clear the affected IDs or re-run `seedLedgerFromLabels()` logic in
reverse — the labels are the truth here, and any ledger entry for an
*unlabelled* message in the last 45 days is a poisoned one. A small
`repairLedgerAgainstLabels()` (delete ledger IDs that carry neither label)
would make this class self-correcting.

Related, one tier down: `learnOther` (`Code.gs:576,664,715`) and
`canonicalSupplier`'s name-store write (`Code.gs:690` via `Code.gs:1628`) also
run un-gated on dry runs. Two dry runs over the same junk teaches a permanent
skip — the verdicts are real, so this is arguably a feature, but it means
"dry run" is not side-effect-free, which should at least be a comment above
`dryRun()`.

### 1.2 FIX NOW — triage-trusted verdict forwards *every* attachment

When triage says invoice/high/single, `verdictFromEmail` is set once and then
applied to **each** qualifying part in the loop (`Code.gs:645-647`). An email
whose text says "please find attached invoice 12345" but which carries
`invoice.pdf` *and* `terms.pdf` (or a price list, or a brochure ≥5KB) forwards
both PDFs to Hubdoc, each under its own ledger key. This is the closest
surviving relative of incident 3: a non-document PDF reaching Hubdoc with no
Claude ever having seen its contents.

Fix: only trust the email-text verdict when there is exactly one qualifying
part — `if (parts.length === 1)` around the `verdictFromEmail` assignment
(`Code.gs:588-592`). Multi-attachment invoice emails then cost one PDF read
each, which is the correct price for knowing what you're forwarding.

### 1.3 FIX NOW — `invoice_count: 0` is treated as 1

The triage prompt defines `invoice_count: 0` as "the email text does not say"
(`Code.gs:981-983`), but the branch only forces a PDF read when the count is
`> 1` (`Code.gs:583`) — so 0, the *unknown* case, falls into the trusted
single-invoice path. A batch file of five one-page invoices whose covering
email doesn't enumerate them gets forwarded whole with no `#split`, and
Hubdoc ingests one document where five invoices exist — quiet under-capture,
the invisible kind of error. Fix: trust only an explicit
`invoice_count === 1`; both 0 and >1 force the read.

### 1.4 Minor

- **Third document, same path.** `uploadStatement` protects the primary path
  but not the `_2` path (`Code.gs:1169-1176`): a third distinct document for
  the same supplier+month silently overwrites the second. At observed volume
  this is acceptable; a loop suffix (`_2`, `_3`, …) is ~5 lines if it ever
  recurs.
- **`markManyDone` writes per ID** (`Code.gs:1463-1469`) — the comment claims
  batching but each `markMessageDone` call persists. 429 seeded IDs ≈ 429
  property writes. Works, just slow; batch by building shards in memory and
  calling `setProperties` once if seeding ever gets slow enough to time out.
- **`stats.review++` runs on dry runs** in the error path
  (`Code.gs:515-522`) — cosmetic stat skew only.

## 2. The five reviewer questions

### Q1 — Can a message with no qualifying PDF reach `sendToHubdoc()`?

**In the current code, no.** The chain is airtight in the zero-PDF case:
`sendToHubdoc` has exactly one call site (`Code.gs:707`), inside
`parts.forEach`, where `parts` comes from the hardened `findPdfParts` and an
empty list abandons the message before triage (`Code.gs:557-563`). The bytes
sent are always the bytes of a qualifying attachment-disposition, ≥5KB,
non-inline PDF. There is no path from body text to a Hubdoc send.

The most plausible reconstruction of incident 3, for the record: under the
pre-rebuild code, (a) the reply's *signature logo PDF* passed the old
attachment gate (no size/inline check), (b) triage read the *quoted supplier
text* under the reply (no quote stripping), judged "invoice, high", and
(c) the own-domain guard — whatever state it was in on the live deployment
that day (the v2 export had it referenced but undefined) — didn't fire before
the paid path. All three links are independently cut now (`isOurOwnMail`
first at `Code.gs:543`, the gate at `Code.gs:867-896`, `stripQuoted` at
`Code.gs:571`), which is why I'd close the incident as "root cause probable,
every candidate link severed" rather than unexplained.

What remains is not "no PDF" but "wrong PDF": findings 1.2 and 1.3 are the
two surviving routes for a PDF nobody read to reach Hubdoc. Close those and
every forwarded byte has either been classified by Claude or is the sole
attachment of an email whose text explicitly names a single invoice.

### Q2 — Ledger shard rotation under a mid-execution kill

The rotation itself is safe in the direction that matters. The whole rotated
set is written in **one** `setProperties` call (`Code.gs:1451-1455`); a kill
before it means the ID was never persisted — the message replays next run and
the idempotent sinks (Dropbox hash-skip, Hubdoc ledger) absorb it. A kill
after it is complete. There is no window where an ID is half-written, and the
in-memory `_ledgerCache` dies with the execution.

The lossy edge — rotation dropping the oldest 250 IDs while those messages
are still inside the 45-day query window — is covered by exactly the defence
you name: those messages were labelled when they were marked done, and the
query excludes both labels. The ledger only has to catch messages whose
labels were removed by hand or by a repair function, and those are precisely
the ones a human just chose to re-expose. So: no fix needed on rotation.

The ledger bug that *does* matter is 1.1 — it's not the kill-safety of the
write, it's who calls the write.

### Q3 — Which reply formats defeat `stripQuoted`?

Three real ones, plus a structural note:

1. **Outlook display-name headers.** `/\bFrom:\s*[^\s@]+@[^\s@]+/` only
   matches when a bare address directly follows `From:`. The most common
   quoted-header block in the wild is `From: Billy Nassif
   <billy@topcabjoinery.com.au>` — display name first — which this regex does
   not match, and Outlook top-posted replies often carry no
   `-----Original Message-----` line either. Add
   `/\bFrom:.{0,80}?<[^>]*@/i` and a `/\bSent:\s/` cut-point.
2. **Long or localized attribution lines.** `On .{0,80}?wrote:` misses
   attributions over 80 chars (long names + full timestamps) and any
   non-English client ("Am … schrieb …", "Le … a écrit :").
3. **The `>` line filter is dead code.** `stripQuoted` runs on
   `extractBody`'s output, which has already collapsed all whitespace to
   single spaces (`Code.gs:963`) — by the time the body reaches
   `stripQuoted`, there are no newlines to split on
   (`Code.gs:1363-1365`). Either strip quotes *before* the whitespace
   collapse (pass the raw text through `stripQuoted` inside `extractBody`)
   or accept that only the cut-point regexes do any work.

Failure direction is mild, which is why none of this is fix-now: own mail is
already excluded upstream by `isOurOwnMail` and the query, so quoted text
only reaches triage on *inbound* mail (supplier replies quoting you,
third-party forwards). The cost of a miss is a confused triage verdict, which
at worst spends a PDF read or routes to review.

### Q4 — Is trusting `invoice_count` from email text too much weight?

The concept is fine; the current implementation trusts it in two situations
it shouldn't (findings 1.2 and 1.3). With those closed, what's left is: an
email that explicitly names exactly one invoice, with exactly one qualifying
PDF attached, from a sender that got past the supplier/keyword queries — and
the downstream sink (Hubdoc → Xero) has its own human review queue before
anything posts. That residual risk is proportionate, and the reward is real:
it's the difference between reading every invoice PDF and reading almost
none, which is most of your token bill. Two cheap hardeners if you want the
belt: log a weekly count of text-trusted forwards in the digest (so drift is
visible), and have `inspectSender` show what triage *would* say for a given
sender so bad senders can be blocklisted before they cost anything.

### Q5 — Anything in section 8 to promote?

- **The Anthropic key: yes, still, and now with a better argument.** This is
  the third review to raise it, so I'll make it concrete rather than
  repetitive. Incident 2 demonstrated the exposure is asymmetric: a config
  change took every Claude call to 400 for a run and the system degraded
  loudly and safely — but a *leaked key being used by someone else* degrades
  silently as billed usage, and this key sits in a screenshot, in Script
  Properties readable by every script editor, feeding a system that now runs
  hourly forever. Rotation is the same two-minute class of change as the one
  that caused incident 2, except reversible and with a known-good rollback
  (the old key keeps working until revoked). If the owner declines again,
  the fallback mitigations are: set a hard monthly spend limit on the
  Anthropic console (declined once — re-offer), and calendar a quarterly
  usage-page glance. Recorded, as before, as the owner's call to make.
- **Everything else in section 8 stays accepted.** Sub-page splitting
  (`one_per_page:false` → forward whole is correct degradation), encrypted
  PDFs to review, link-only invoices invisible by design (revisit only if a
  second link-only supplier appears), payment-reminders-as-statements (now
  genuinely harmless — the `_2`-plus-digest path makes the error visible and
  non-destructive), and the logged 300-ID cap.
- And from this review, findings 1.1–1.3 are the actual fix-now list — 1.1
  before anyone runs `dryRun()` again.

## 3. Report-vs-code discrepancies

Two, both cosmetic (v2 had four, one critical — the trend is right):
`pauseEverything` and `selfTest` are listed in §11's function inventory but
exist nowhere in the source. Either add them (a `pauseEverything` that
deletes all triggers and sets a `PAUSED` property honoured at the top of
`processRange` is genuinely worth having on an iPad-operated system) or drop
them from the list.

## 4. Verified from the v2 action list

All seven, confirmed against this source: reconcile/`OUR_DOMAINS`
(`Code.gs:92`, plus query-level exclusions `Code.gs:467-470` and
`isOurOwnMail` at `Code.gs:1331-1336`); `PDF_MARGIN_MS` wired with deferral
(`Code.gs:635-640`); content-hash pre-upload check with safe-side handling of
metadata errors (`Code.gs:1197-1216`); `CANONICAL_NAMES` store with
`showCanonicalNames`/`setCanonicalName` operators (`Code.gs:1637-1667`);
budget/time deferral flag honoured in `processMailbox` (`Code.gs:508-512`);
`showTriggers` (`Code.gs:267-271`); search-cap logging (`Code.gs:825-828`).
`temperature: 0` was implemented, blew up (my recommendation — see verdict),
and was correctly replaced with status-code logging on both calls.

The ledger sharding, `seedLedgerFromLabels` with legacy-property migration,
`inspectSender`, and the Hubdoc section in the digest are all good additions
I didn't ask for. The digest now reporting every Hubdoc send closes the last
visibility gap on the one irreversible sink.

---

## Appendix — copy-paste prompt for the implementing Claude

```
Three fixes from the v3 external review, in order. The system is live - make
these changes only, no refactors.

FIX 1 - dryRun() poisons the message ledger (do this before anyone runs
dryRun again). handleMessage calls markMessageDone in three places: the
isOurOwnMail skip, the no-qualifying-PDF skip, and the end-of-message call.
None checks opts.dryRun, so a dry run marks real messages done and real runs
then skip them at the messageAlreadyDone check - statements examined by a dry
run are never filed, with no trace. Gate all three calls on !opts.dryRun (the
final one also keeps its !out.deferred condition). Then write a one-off
repairLedgerAgainstLabels(): for each ledger ID from the last 45 days, if the
message carries neither Bookkeeping label, remove it from the ledger - labels
are the truth. Run it once and log how many it removed.

FIX 2 - the triage-trusted invoice verdict forwards EVERY attachment. When
verdictFromEmail is set, the parts loop applies it to each qualifying PDF, so
"invoice attached" plus invoice.pdf AND terms.pdf forwards both to Hubdoc,
unread. Only set verdictFromEmail when parts.length === 1; any multi-
attachment message must go through the paid PDF read.

FIX 3 - invoice_count 0 must not be trusted. The triage prompt defines 0 as
"the email does not say", but the code only forces a PDF read when count > 1,
so the unknown case skips the read - a batch of unenumerated invoices gets
forwarded whole with no #split. Change the condition so ONLY an explicit
invoice_count === 1 uses the text-only verdict; 0 and >1 both read the PDF.

ALSO, small: pauseEverything and selfTest are listed in the report's function
inventory but do not exist in the code. Add pauseEverything (delete all
triggers, set a PAUSED script property checked at the top of processRange)
and drop selfTest from the report, or implement both.

Verify: run showLedgerSize before and after the repair function; run dryRun
and confirm the ledger count does NOT change; send a two-PDF test email whose
text names one invoice and confirm the log shows a PDF read instead of a
text-trusted forward.
```
