# Technical Review v2 — Supplier Document Router

Reviewer: Claude Code (external review, second pass)
Date: 11 August 2026
Scope: verification of the seven v1 fix-now items against `Code.gs` as supplied
(1,553 lines, single file, stated to be ground truth), plus the two questions
posed in Report v2 — the duplicate-document rule (Part 2) and where else the
pattern applies (Part 3).

## Summary verdict

Five of the seven fix-now items are correctly implemented and I verified them
in the code. But the report and the code disagree in four places, and one of
them is not cosmetic: **`OUR_DOMAINS` is referenced but never defined**, which
in this file as written would throw on every message and route the entire
pipeline to Needs-review. Since production is demonstrably filing statements,
the file supplied is almost certainly not the file that is running — which
means this review's ground truth is broken, and the *first* action item is to
re-export the live script and reconcile. The other three discrepancies
(`PDF_MARGIN_MS` unused, `showTriggers()` absent, `temperature: 0` absent) are
consistent with a stale export and individually small.

On Part 2: yes, add the rule — but not for the reason the report frames. Under
`mode:'overwrite'`, a second document classified to the same supplier+month
**silently replaces the first**. The Wilson & Bradley reminder-as-statement is
no longer "visible and harmless"; it can clobber a genuine statement already
filed at that path. A content-hash check before overwrite is ~15 lines and
closes it.

---

## Part 1 — Fix-by-fix verification

| # | Item | Verdict |
|---|------|---------|
| 1 | LockService guard | **Confirmed.** `tryLock(0)` bail + try/finally around `processRangeInner` (`Code.gs:264-275`). Correct pattern. |
| 2 | Hubdoc sent ledger | **Confirmed.** Checked before send, written immediately after (`Code.gs:632-638`), 60-day age-out beyond the 45-day window (`Code.gs:1176-1189`). |
| 3 | Dropbox overwrite | **Confirmed.** `mode:'overwrite'`, `autorename:false` (`Code.gs:1080-1082`). But see Part 2 — overwrite has a new consequence the report hasn't priced in. |
| 4 | Canonical supplier names | **Implemented with a gap that excludes the motivating case.** See below. |
| 5 | Period validator | **Confirmed.** `validPeriod()` rejects malformed, future, and >~26-month-old periods (`Code.gs:1529-1538`); statement path routes failures to review with a digest line (`Code.gs:602-612`). |
| 6 | Credentials | Not code-verifiable. The un-rotated Anthropic key remains my strongest outstanding recommendation — see Part 3 Q4, where it also constrains the reuse answer. |
| 7 | Trigger cleanup | **Half-confirmed.** `clearFollowUps()` runs at the top of `runFollowUp()` and inside `scheduleFollowUp()` (`Code.gs:343-370`) — correct. But `showTriggers()` does not exist in this file. |

### The blocker: `OUR_DOMAINS` is undefined

`Code.gs:504-509` reads:

```js
var fromDomain = senderDomain(from);
if (fromDomain && OUR_DOMAINS.indexOf(fromDomain) !== -1) {
```

There is no `OUR_DOMAINS` declaration anywhere in the file — the config block
defines `OUR_COMPANY_NAMES` (`Code.gs:87`) but no domain list. In Apps Script
this is a `ReferenceError` thrown on **every message that has a PDF**, caught
by the handler in `processMailbox` (`Code.gs:477-484`), which would label
everything Needs-review and email a digest full of problems. Production is
filing statements, so one of two things is true:

1. The live project has a second `.gs` file (or a later revision of this one)
   defining `OUR_DOMAINS = ['topcabjoinery.com.au']` — and this export is
   stale, or
2. The guard was added to the file *after* the last real run, and the next
   hourly trigger will take the whole pipeline down loudly.

Either way: **re-export the live script and diff it against this file before
acting on anything else in this review.** If (2), the one-line fix is
`var OUR_DOMAINS = ['topcabjoinery.com.au'];` in the config block. Note the
sender guard is partially redundant anyway — the Gmail queries already carry
`-from:me` (`Code.gs:438`), which excludes mail sent *by the mailbox being
searched*, though not mail from the *other* company mailbox or other domain
users, which is what the guard is for.

### Three more report-vs-code discrepancies (consistent with a stale export)

1. **`PDF_MARGIN_MS` is declared (`Code.gs:135`) and never used.** The report
   claims "a paid PDF read will not START unless that much time remains."
   There is no time check inside `handleMessage` at all — the only
   `MAX_RUNTIME_MS` checks are per-mailbox and per-message-id
   (`Code.gs:287,454,461`). A message picked up at the 4.4-minute mark can
   still start a slow PDF classify and get hard-killed mid-flight. The check
   belongs immediately before `classify()` (`Code.gs:584`): if
   `Date.now() - started > MAX_RUNTIME_MS - PDF_MARGIN_MS`, return without
   labelling so the follow-up run picks the message up.
2. **`temperature: 0` is absent from both API payloads** (`Code.gs:886-890`
   and `Code.gs:956-973`). Report says it was added to both calls.
3. **`showTriggers()` is absent.** Small, but it was the verification
   affordance for item 7.

None of these three change my assessment of the design; they change my
confidence that this file is what's running. Reconcile first.

### The canonical-name gap (item 4)

`canonicalSupplier()` (`Code.gs:1257-1266`) reads only `rememberedSuppliers()`
— the `AUTO_SUPPLIERS` learned store. But `rememberSupplier()` refuses to
store anything for a handle already in `KNOWN_SUPPLIERS`
(`Code.gs:1217`). So for every seed-list supplier, the store has no entry,
`canonicalSupplier` returns Claude's per-run spelling, and the filename is
exactly as unstable as before the fix.

`hafele.com.au` — the documented three-spellings case that motivated this fix
— **is in the seed list** (`Code.gs:39`). Unless it happens to have been
auto-learned before it was added to the seed (possible, given the report says
those 10 suppliers were seed-list gaps until recently — check with
`showSuppliers()`), the Häfele problem is not fixed. Polytec, Laminex, Blum
and every other original seed supplier definitely have no stored name.

Minimal fix, preserving the store's shape: in the statement branch, after the
`rememberSupplier` call, store the name for seed suppliers too — e.g. give
`rememberSupplier` a "store name but don't announce" path for known handles,
or keep a tiny separate `CANONICAL_NAMES` property keyed by handle and have
`canonicalSupplier` consult it first. Ten lines either way.

### New findings from this read (not in v1)

1. **Budget exhaustion mid-message re-creates "marked done, never done".**
   `processMailbox` only calls `handleMessage` when `budget.left > 0`
   (`Code.gs:462`), but inside a multi-PDF message the budget can hit zero
   between parts; the guard at `Code.gs:573` then returns from the part loop
   silently, and the message **still gets the Processed label**
   (`Code.gs:475`). That unclassified attachment is permanently excluded —
   the June-backfill failure mode, in miniature, surviving in the current
   code. Fix: set an `out.deferred` flag when the budget guard trips, and in
   `processMailbox` skip labelling (and count `stats.capped++`) for deferred
   messages so the follow-up run re-sees them. Low frequency (needs a
   multi-PDF email straddling the cap boundary) but it is the exact class of
   bug you've already been bitten by.
2. **The known-supplier learn guard misses free-email suppliers.** The guard
   (`Code.gs:1316-1319`) compares the fingerprint's *domain* against
   `activeSuppliers()`, but free-email suppliers are stored as full addresses
   (`senderHandle`, `Code.gs:1515-1522`), so `gmail.com` never matches
   `someone@gmail.com` and their mail can still be learned-skipped. No seed
   supplier uses a consumer domain today, so this is latent — worth a
   one-line note in the guard for whoever adds the first Gmail-based
   supplier.
3. **`gmailSearch` truncates at ~300 ids silently** (`Code.gs:749`). During a
   wide backfill this under-reports without any log line. Harmless in steady
   state (rolling window + follow-ups converge), but a `Logger.log` when the
   cap is hit would have shortened the June diagnosis.

### Endorsed as-is

- The deliberate skip of the eviction tie-break: agreed, still cosmetic.
- The blank-subject learn refusal (`Code.gs:1308-1310`): good catch, correct
  reasoning, and `forgetBlankSubjects()` as the retroactive cleanup is the
  right pairing.
- `fixCordell`, `forgetRelays`, `whatAmIMissing`, `clearProcessedLabels`,
  `whatsInDropbox`: the operational tooling continues to be the strongest
  part of this system. The June 6→20 recovery is exactly what these exist
  for.

---

## Part 2 — The duplicate-document rule: yes, but reframed

The question was whether "same supplier, same period, second document →
Needs-review" is worth adding for a once-or-twice occurrence. Framed as a
frequency question, no. But the frame changed when item 3 landed:

Under `mode:'overwrite'`, path collision means **replacement**. The filing
path is `period/period_Supplier.pdf` — so a Wilson & Bradley payment reminder
classified as a statement for 2026-07 doesn't sit *beside* the genuine July
statement, it **overwrites it**. Which document survives depends on
processing order, and nothing in the digest distinguishes "re-filed the same
bytes" (the desirable reminder-collapse case) from "replaced a statement with
a different document" (silent data loss). v1 argued overwrite's only loss case
was "two genuinely different documents on the same supplier+month" and that
the later one is the one the accountant wants — that holds for
statement-vs-statement supersession, but not for reminder-vs-statement, which
production has now demonstrated is real.

So: add the rule, in its cheapest form, which is **bytes-aware, not
period-aware**:

- Before uploading, compute the Dropbox `content_hash` of the local bytes
  (SHA-256 of 4 MB blocks, concatenated, SHA-256 again — at your 5 MB cap
  that's almost always `sha256(sha256(bytes))`; `Utilities.computeDigest`
  does this in ~10 lines).
- `files/get_metadata` on the target path. Missing → upload. Present with
  matching `content_hash` → skip silently (the reminder-collapse case, now a
  no-op instead of a rewrite). Present with a different hash → **do not
  overwrite**; file to `period_Supplier_2.pdf` or route to Needs-review with
  a digest line naming both documents.

This preserves everything overwrite bought (replay-idempotence, reminder
collapse) while making the one dangerous case loud. It also supersedes the
"same supplier, same period, second document" ledger idea — the filesystem
*is* the ledger once you check it before writing.

---

## Part 3 — Where else the pattern goes

The generalised shape — watch a stream, classify cheaply, route
deterministically, learn to ignore, interrupt only on ambiguity — transfers
well, but its safety here rests on three properties worth naming before
extending it: the sink is **idempotent** (overwrite/ledger), errors are
**visible** (digest, Needs-review), and wrong answers are **recoverable** (a
misfiled PDF can be moved). Every candidate below is scored against those.

### Q1 — Which admin tasks fit, and which are traps

Good fits (high volume, rule-ish, verifiable output, recoverable errors):

- **Remittance advices.** Currently classified "other" and skipped. Extract
  payer + amount + invoice numbers into a monthly sheet; reconciliation in
  Xero becomes lookup instead of email archaeology. Purely additive — a
  missed one costs nothing.
- **Delivery dockets → job folders.** They're already recognised (negative
  keywords) — instead of discarding, file to `Jobs/<job>/deliveries/` keyed
  on PO or job number in the document. Verifiable (docket either names a job
  or goes to review) and useful in disputes.
- **Compliance/insurance/rego documents** with expiry dates: file + extract
  the expiry into a renewal calendar. Tiny volume, high forgetting cost —
  the pattern's interrupt-only-on-ambiguity property is exactly right.
- **Quote-request intake triage**: classify inbound enquiries (new-kitchen
  lead vs supplier marketing vs existing-job correspondence) into labels so
  the human reads a sorted queue. Routing only — no replies.

Traps (look automatable, aren't safe under this pattern):

- **Anything that moves or approves money.** Bill approval in Xero,
  payment scheduling. The classifier feeding Hubdoc is fine because the
  approve step behind it is human; automating that step removes the only
  fraud/error gate. This includes "auto-match statements to ledger and
  auto-clear" — matching is a fine *report*, a terrible *action*.
- **Anything customer-facing that sends without review.** Errors are
  reputational and unrecoverable (see Q3).
- **Anything without a verifiable output.** "Summarise and delete" flows
  fail silently; this system works because a filed PDF either exists at the
  right path or doesn't.

### Q2 — Pricelist ingestion: build it, but as diff-and-approve

The shape is sensible and the rails carry over (the classifier already
recognises price lists — today it learns to *skip* them, which is the first
change: route them instead). The format-variance worry is real but
misdirected: variance is a losing battle **only if the output applies
unattended**. Aim the automation at extraction and *diffing*, never at
writing the cost table:

- Watch for pricelist emails from known suppliers → extract to the normalised
  scheme you already built (per-m² by material/thickness for boards, per-item
  for hardware) → diff against the current table → email a change summary
  ("Nover: 14 items changed, HMR 16mm +4.2%, 3 new codes, 2 discontinued")
  → human approves → then it round-trips to Xero/Jobman.

Volume is low (each supplier reprices a few times a year) so extraction cost
is trivial, and the value is asymmetric: a stale cost silently corrupts every
quote priced from it, which makes this arguably worth more than the statement
filer. Two design notes: keep a per-supplier extraction memory (last file's
column mapping as few-shot context — supplier formats are internally
consistent even though they vary wildly across suppliers), and treat
**absence** as a first-class output ("no pricelist from Polytec in 12 months,
costs may be stale") — the June lesson generalises: the dangerous failure is
the document that never arrives.

### Q3 — Outbound: yes, with a draft-not-send rule

The receivables side is the standout: **statement/overdue chasing** is
mechanical (Xero knows every overdue invoice), high-value for a small trade
business, and tolerant of the one safety rule outbound needs: the system
**writes Gmail drafts, never sends**. Billy reviews and taps send from the
iPad; the nightly digest lists drafts created. That keeps judgment (this
builder always pays on the 20th; that one's on a big job and shouldn't be
poked) exactly where it belongs while removing the composition work — and it
degrades gracefully: ignored drafts are just drafts.

Quote follow-ups fit the same draft-only mold ("quote #214 sent 14 days ago,
no reply — draft nudge"). Delivery paperwork is better generated from Jobman
at dispatch time than run through an email classifier — different shape, see
Q5. The asymmetry to hold onto: inbound errors are internal and recoverable;
outbound errors are external and reputational. Inbound can automate the
action; outbound should automate everything *up to* the action.

### Q4 — Reuse: siblings sharing auth, not a growing monolith

Extend the router only for document types that are **routing decisions on the
same inbound PDF stream** — remittance advices and delivery dockets are new
branches of the existing classify step and belong in it. Everything with a
different trigger, cadence, or direction (pricelists' extract-diff-approve,
outbound drafting) should be a **sibling project sharing the service account
and the patterns, not the code**.

Failure modes at this scale, which decided it for me:

- *Monolith:* one bad edit stops every function at once (and the stated
  constraint is that the running system needs no script edits — every new
  capability added to the same file violates that for the parts already
  live); the 6-minute budget and the run lock become shared bottlenecks —
  a slow pricelist extraction delays statement filing; and the learned
  stores cross-contaminate ("skip pricelists" is the router's correct
  lesson and the ingester's fatal one).
- *Siblings:* helper drift (five copies of `gmailApi` age differently) and
  credential sprawl — each project is another place the Anthropic key and
  the SA key live. Drift is the cheaper disease at 2–4 projects: the deploys
  are independent, blast radii stay small, and a sibling can die without
  taking filing down.

The sprawl point has a sharper edge here: **every sibling multiplies the
blast radius of the key the owner declined to rotate.** One more copy of
that decision gets made each time a project is cloned. Rotate it before the
second project, and put both keys on the yearly rotation calendar from v1.

### Q5 — Jobman + Mozaik: script the edges, buy the middle

The seam that matters is **quote → job → cut list → board purchasing**. Split
it at the point where errors start costing material:

- **Script the purchasing edge.** Mozaik's nesting output already states
  sheet counts by material/thickness. A small script that reads those
  reports from Dropbox and produces a weekly purchasing digest — "jobs
  cutting next week need 14 sheets 16mm White HMR + 6 sheets 18mm MDF;
  last Nover cost $X/sheet, cost basis 4 months old" (the pricelist table
  from Q2 feeds this directly) — is high-value, verifiable against the
  reports, and wrong-answer-cheap: a bad count is caught when ordering,
  not when cutting.
- **Don't script the middle.** Anything that generates or transforms what
  the Morbidelli executes (nesting, cutting files, machine-ready geometry)
  has the worst error profile in the business — silent until sheets are
  ruined — and Mozaik's file formats are proprietary and version-mobile,
  so a reverse-engineered bridge breaks on updates, in the worst month to
  debug it. That is precisely what the paid Jobman–Mozaik integration is
  for: someone else's contract to maintain.
- Quote → Jobman job creation on acceptance is API-scriptable and
  low-risk if the Jobman API exposes it; it's data entry, verifiable in
  the UI.

### Q6 — What not to automate

Beyond the money-movement and customer-sending lines above:

1. **The Xero approve step.** The human glance at each bill before it posts
   is the only point where "this invoice looks wrong / doubled / not ours"
   gets caught. The router deliberately ends at Hubdoc; keep it there.
2. **The Needs-review queue.** The temptation once volume grows is
   auto-triaging the triage failures. Needs-review *is* the system's
   honesty; automating it away converts every future unknown-unknown into
   silence. If it gets noisy, fix upstream classifications — never lower
   the gate.
3. **The monthly count-glance.** The June bug (6 statements where ~12
   belonged) was caught by a human noticing a number looked wrong, not by
   any check the system ran on itself. Cheapen that glance rather than
   replace it: a per-month statement count table in the digest (the
   `whatsInDropbox` rollup, monthly) with a soft flag when a month runs
   well below its trailing average, and per-supplier "no statement from X
   this month" once the supplier set stabilises. The system can *surface*
   anomalies; deciding whether an anomaly matters should stay human.
4. **Supplier onboarding stays semi-automatic.** Auto-learn with digest
   announcement and `forgetSupplier` is the right setting — Cordell showed
   the failure, the digest made it visible, one function fixed it. Full
   auto with no announcement would have filed a customer as a supplier
   indefinitely.

The general principle behind all four: this system earns trust by making its
failures *loud and cheap*. The steps that should stay manual are the ones
whose value is precisely that a human is looking — approval gates, anomaly
glances, and the review queue. Automate the reading, the sorting, the
drafting, and the diffing; keep the deciding.

---

## Action list, in order

1. **Re-export the live script and diff against this file** — resolve the
   `OUR_DOMAINS` question before anything else. If the guard is genuinely
   undefined in production, one config line fixes it; if the export is stale,
   re-verify items 4 and the three absent changes against the real code.
2. **Wire up `PDF_MARGIN_MS`** before `classify()`, without labelling on
   deferral (it's currently dead config).
3. **Add the pre-upload content-hash check** (Part 2) — this is the
   overwrite-clobber fix and replaces the proposed duplicate rule.
4. **Close the canonical-name gap for seed suppliers** — Häfele, the
   motivating case, is likely still exposed.
5. **Fix the mid-message budget-exhaustion labelling bug** (deferred flag).
6. **Add `temperature: 0` and `showTriggers()`** if truly absent from the
   live code.
7. **Rotate the Anthropic key before any sibling project is cloned** — the
   accepted risk compounds with each reuse of the pattern.
