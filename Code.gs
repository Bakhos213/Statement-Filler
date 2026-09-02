/**
 * Top Cab Joinery - supplier document router (MULTI-MAILBOX)
 *
 * One project, any number of mailboxes on topcabjoinery.com.au.
 * Uses a Google Cloud service account with domain-wide delegation, so it
 * reads each mailbox through the Gmail REST API instead of being locked to
 * whichever account happens to own this script.
 *
 * SCRIPT PROPERTIES REQUIRED:
 *   SERVICE_ACCOUNT_JSON    the whole key file, pasted in as one line
 *   ANTHROPIC_API_KEY       sk-ant-...
 *   DROPBOX_APP_KEY
 *   DROPBOX_APP_SECRET
 *   DROPBOX_REFRESH_TOKEN
 *   HUBDOC_EMAIL            yourprefix@app.hubdoc.com
 */

// ---------------------------------------------------------------- config

/** Every mailbox to check. Add a line to add a mailbox. */
var MAILBOXES = [
  'billy@topcabjoinery.com.au',
  'accounts@topcabjoinery.com.au'
];

/** Suppliers you KNOW send statements. Domain, or full address for Gmail etc. */
var KNOWN_SUPPLIERS = [
  'polytec.com.au',
  'laminex.com.au',
  'nover.com.au',
  'blum.com',
  'titusplus.com',      // Titus Tekform
  'porta.com.au',       // Porta Products / polytec
  'duluxgroup.com.au',  // Lincoln Sentry
  'wanless.com.au',
  'drinkwaterworld.com.au',
  'leitz.com.au',
  'hafele.com.au',
  'wilbrad.com.au',
  'leksupply.com.au',
  'lincolnsentry.com.au',
  'edelivery.bunnings.com.au',
  'fleetcard.com.au',
  'ecollect.com.au',
  'forest.one',
  'billing.energyaustraliaonline.com.au'
];

/**
 * Suppliers who send invoices as Excel files. Their .xlsx/.xls attachments
 * are converted to PDF (via a temporary Google Drive copy, deleted straight
 * after) and then flow through the normal pipeline - triage, classify,
 * forward - exactly like a PDF. Listed senders ONLY: a spreadsheet from
 * anyone else (pricelists, cutting lists) is never converted or read.
 * REQUIRES the Drive API advanced service: Editor > Services > + > Drive API.
 */
var XLSX_INVOICE_SUPPLIERS = [
  // 'supplierdomain.com.au',
];

/** Senders that never send statements. */
var IGNORE_SENDERS = [
  'noreply@google.com',
  'notifications@dropbox.com'
];

/** Words suggesting a PDF is worth reading. Free - Gmail does the filtering. */
var DOC_KEYWORDS = [
  'statement', '"statement of account"', 'SOA', '"tax invoice"', 'invoice',
  '"amount due"', '"account summary"', 'overdue', '"outstanding balance"',
  'remittance', '"your account"'
];

/** Never worth reading. */
var NEGATIVE_KEYWORDS = [
  '"order confirmation"', '"order acknowledgement"', '"delivery docket"',
  '"proof of delivery"', '"picking slip"', '"packing slip"', '"dispatch advice"',
  '"shipping confirmation"', '"your order has"', '"quotation"', '"quote no"',
  '"advanced shipping notice"', '"service calendar"'
];

/** Filenames that are never a statement. */
var NEGATIVE_FILENAMES = [
  'delivery', 'docket', 'picking', 'packing', 'dispatch',
  'orderconf', 'order_conf', 'order confirmation', 'quote', 'quotation',
  'calendar', 'pricebook', 'price book'
];

/** Shared consumer providers - identify these suppliers by full address. */
var FREE_EMAIL_DOMAINS = [
  'gmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'live.com.au',
  'yahoo.com', 'yahoo.com.au', 'bigpond.com', 'bigpond.net.au',
  'optusnet.com.au', 'icloud.com', 'me.com', 'aol.com', 'tpg.com.au',
  'iinet.net.au', 'internode.on.net', 'msn.com', 'protonmail.com'
];

/**
 * Your own trading names. Anything Claude says was ISSUED by you is your
 * own outgoing paperwork, not a supplier document - never file or forward it.
 */
var OUR_COMPANY_NAMES = ['topcab', 'top cab'];

/** Your own mail domains. Anything sent FROM here is our own paperwork. */
var OUR_DOMAINS = ['topcabjoinery.com.au'];

/**
 * Mail relays and bulk senders. Like the consumer providers above, the
 * domain identifies the PLATFORM, not the supplier - never add these to
 * KNOWN_SUPPLIERS or you will read every PDF sent through them.
 */
var RELAY_DOMAINS = [
  'post.xero.com', 'mail.xero.com', 'notifications.xero.com',
  'apps.myob.com', 'sendgrid.net', 'amazonses.com', 'mailgun.org',
  'mandrillapp.com', 'myob.com', 'quickbooks.com', 'intuit.com', 'bill.com'
];

/**
 * Read the email subject + body first (cheap, text only) before opening
 * any PDF. Statements still get read properly - we need supplier and period
 * to name the Dropbox file. Invoices can often skip the PDF read entirely,
 * because Hubdoc does its own data extraction once it receives them.
 */
var TRIAGE_FIRST = true;
var TRUST_TRIAGE_FOR_INVOICES = true;

var SKIP_AFTER = 2;
var MAX_PDF_MB = 5;

/**
 * Signature logos and tracking pixels are often small PDFs. A real invoice
 * or statement is never this small, so anything under this is not a document.
 */
var MIN_PDF_BYTES = 5000;
var MAX_CLASSIFICATIONS_PER_RUN = 150;

var DROPBOX_ROOT = '/Supplier Statements';
var CLAUDE_MODEL = 'claude-sonnet-5';

var LABEL_PROCESSED = 'Bookkeeping/Processed';
var LABEL_REVIEW    = 'Bookkeeping/Needs-review';

/** LIVE: invoices are forwarded to Hubdoc. Set to false to stop immediately. */
var FORWARD_INVOICES_TO_HUBDOC = true;

/**
 * Only forward invoices RECEIVED on or after this date. Everything older was
 * already handled by hand, so we start clean rather than dumping the backlog
 * into Hubdoc. Set to '' to forward regardless of age.
 */
var HUBDOC_START_DATE = '2026-08-11';

/**
 * Apps Script hard-kills an execution at 6 minutes. Stop starting new
 * messages at 4.5 min, and don't START a paid PDF read unless there is
 * PDF_MARGIN_MS left - a slow read plus labelling must still fit.
 */
var MAX_RUNTIME_MS = 4.5 * 60 * 1000;
var PDF_MARGIN_MS  = 90 * 1000;

/** Where problems and summaries get emailed. */
var ALERT_EMAIL = 'billy@topcabjoinery.com.au';

/** Only email when something needs you, not after every quiet day. */
var EMAIL_ONLY_WHEN_NOTEWORTHY = true;

/**
 * Hour (Sydney time, 24h) the single nightly summary email goes out.
 * Runs during the day queue their results silently; nothing emails per run.
 */
var DIGEST_HOUR = 20;

var GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.modify ' +
                   'https://www.googleapis.com/auth/gmail.send';

// ---------------------------------------------------------------- entry points

/** RUN THIS FIRST. Confirms the service account can reach every mailbox. */
function testConnection() {
  MAILBOXES.forEach(function (user) {
    try {
      var res = gmailApi(user, 'GET', 'profile');
      Logger.log('OK    ' + user + '   (' + res.messagesTotal + ' messages)');
    } catch (err) {
      Logger.log('FAIL  ' + user + '   ' + err);
    }
  });
}

function runHourly() {
  processRange(daysAgo(45), tomorrow());
}

function dryRun() {
  processRange(daysAgo(60), tomorrow(), { dryRun: true });
}

function backfill(fromYyyyMmDd, toYyyyMmDd) {
  processRange(fromYyyyMmDd, toYyyyMmDd);
}

/**
 * Catch-up runs. Run clearProcessedLabels FIRST if the months you want were
 * already marked done by an earlier run, otherwise they stay excluded.
 */
function fixJuneOnwards() {
  processRange('2026/06/01', '2026/08/13');
}

function backfillMarchToJune() {
  processRange('2026/03/01', '2026/07/01');
}

/**
 * Removes the Bookkeeping labels across a date range so a backfill can
 * re-examine mail that earlier runs marked as done. Edit the dates first.
 */
function clearProcessedLabels() {
  var FROM = '2026/03/01';
  var TO   = '2026/08/12';

  MAILBOXES.forEach(function (user) {
    var labels = ensureLabels(user);
    var cleared = 0;

    ['bookkeeping-processed', 'bookkeeping-needs-review'].forEach(function (lbl) {
      var ids = gmailSearch(user, 'label:' + lbl +
                            ' after:' + FROM + ' before:' + TO);
      ids.forEach(function (id) {
        try {
          gmailApi(user, 'POST', 'messages/' + id + '/modify',
                   { removeLabelIds: [labels.processed, labels.review] });
          cleared++;
        } catch (e) {}
      });
    });

    Logger.log(user + ': cleared ' + cleared + ' message(s)');
  });
}

/**
 * Diagnostic. Lists every statement-ish email in a range and why it would
 * be skipped. Reads no PDFs, costs nothing.
 */
function whatAmIMissing() {
  var FROM = '2026/03/01';
  var TO   = '2026/08/12';

  MAILBOXES.forEach(function (user) {
    Logger.log('===== ' + user + ' =====');
    var q = 'has:attachment filename:pdf -in:sent -in:draft -from:me' +
            ' {statement "statement of account" SOA "account summary"}' +
            ' after:' + FROM + ' before:' + TO;

    var ids = gmailSearch(user, q);
    Logger.log(ids.length + ' message(s) mention a statement');

    ids.forEach(function (id) {
      try {
        var msg = gmailApi(user, 'GET', 'messages/' + id + '?format=metadata' +
                           '&metadataHeaders=From&metadataHeaders=Subject');
        var h = headerMap(msg);
        var fp = fingerprint(h.from || '', h.subject || '');
        var why = [];
        if (learnedCount(fp) >= SKIP_AFTER) why.push('LEARNED-SKIP');
        if (isBlocked(fp)) why.push('BLOCKED');
        Logger.log((why.length ? '[' + why.join(',') + '] ' : '[ok] ') +
                   (h.from || '') + ' | ' + (h.subject || ''));
      } catch (e) {
        Logger.log('  error on ' + id + ': ' + e);
      }
    });
  });
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runHourly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runHourly').timeBased().everyHours(1).create();
  Logger.log('Hourly trigger installed.');
}

/** Run manually to see what triggers exist (checks nothing has piled up). */
function showTriggers() {
  var t = ScriptApp.getProjectTriggers();
  Logger.log(t.length + ' trigger(s):');
  t.forEach(function (x) { Logger.log('  ' + x.getHandlerFunction()); });
}

/**
 * THE BIG RED BUTTON. Deletes every trigger (hourly and any pending
 * follow-up) and sets a flag that stops any run from starting, so
 * "something looks wrong" becomes pause-then-look, not live debugging.
 */
function pauseEverything() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
  PropertiesService.getScriptProperties().setProperty('PAUSED', 'true');
  Logger.log('PAUSED. Nothing will run until you run resumeEverything().');
}

function resumeEverything() {
  PropertiesService.getScriptProperties().deleteProperty('PAUSED');
  installTrigger();
  installDigestTrigger();
  Logger.log('Resumed - hourly runs and the nightly digest are back on.');
}

// ---------------------------------------------------------------- main loop

function processRange(after, before, opts) {
  opts = opts || {};

  // The big red button. Checked before the lock so a paused system does
  // nothing at all, even if a stale trigger still fires.
  if (PropertiesService.getScriptProperties().getProperty('PAUSED')) {
    Logger.log('PAUSED - skipping this run. Run resumeEverything() to restart.');
    return;
  }

  // Only one run at a time. Two overlapping runs would both search Gmail
  // before either applied the Processed label, and process the same mail
  // twice - which for Hubdoc means the same invoice forwarded twice.
  // Bail rather than wait: the rolling window catches skipped mail next run.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('Another run is already in progress - skipping this one.');
    return;
  }

  try {
    processRangeInner(after, before, opts);
  } finally {
    lock.releaseLock();
  }
}

function processRangeInner(after, before, opts) {
  var started = Date.now();
  var budget = { left: MAX_CLASSIFICATIONS_PER_RUN };
  var stats = { seen: 0, statements: 0, invoices: 0, skipped: 0, review: 0,
                capped: 0, timedOut: false };
  var discovered = {};
  var reviewRows = [];
  var report = { filed: [], newSuppliers: [], problems: [], hubdoc: [] };

  MAILBOXES.forEach(function (user) {
    if (Date.now() - started > MAX_RUNTIME_MS) { stats.timedOut = true; return; }
    Logger.log('===== ' + user + ' =====');
    try {
      processMailbox(user, after, before, opts, budget, stats, discovered,
                     reviewRows, started, report);
    } catch (err) {
      Logger.log('MAILBOX FAILED: ' + user + ' -> ' + err);
      report.problems.push('Could not read mailbox ' + user + ': ' + err);
    }
  });

  var totalTokens = reviewRows.reduce(function (a, r) { return a + r.tokens; }, 0);
  try {
    writeReviewSheet(reviewRows);
  } catch (err) {
    Logger.log('Review sheet write failed (work above was still done): ' + err);
    reviewRows.forEach(function (r) {
      Logger.log('  NOT A STATEMENT | ' + r.mailbox + ' | ' + r.from + ' | ' +
                 r.subject + ' | ' + r.filename + ' | ' + r.fp);
    });
  }

  Logger.log('--- ' + (opts.dryRun ? 'DRY RUN' : 'RUN') + ' complete ---');
  Logger.log(JSON.stringify(stats));
  Logger.log('Paid to read ' + reviewRows.length + ' non-statement PDF(s), ' +
             totalTokens + ' tokens.');
  try { Logger.log('Review sheet: ' + reviewSheetUrl()); } catch (e) {}

  var newOnes = Object.keys(discovered).filter(function (d) {
    return KNOWN_SUPPLIERS.indexOf(d) === -1;
  });
  if (newOnes.length) {
    Logger.log('NEW SUPPLIERS FOUND (consider adding to KNOWN_SUPPLIERS):');
    newOnes.forEach(function (d) {
      var note = d.indexOf('@') !== -1
        ? '   <- personal email account, add the whole address as shown'
        : '';
      Logger.log("  '" + d + "',   // " + discovered[d] + note);
    });
  }
  if (stats.capped || stats.timedOut) {
    Logger.log(stats.capped
      ? 'Hit the ' + MAX_CLASSIFICATIONS_PER_RUN + ' classification cap.'
      : 'Ran out of time before finishing.');
    if (!opts.dryRun) scheduleFollowUp(after, before);
  }

  if (!opts.dryRun) queueDigest(stats, report);
}

// ---------------------------------------------------------------- self-running

/**
 * When a run hits the cap there is more to do, so book another go in a few
 * minutes rather than waiting for the next hourly slot.
 */
function scheduleFollowUp(after, before) {
  clearFollowUps();
  PropertiesService.getScriptProperties()
    .setProperty('RESUME_RANGE', JSON.stringify({ after: after, before: before }));
  ScriptApp.newTrigger('runFollowUp').timeBased().after(3 * 60 * 1000).create();
  Logger.log('More work outstanding - another run booked in 3 minutes (' +
             after + ' to ' + before + ').');
}

/** Picks up where the last run stopped, over the same date range. */
function runFollowUp() {
  clearFollowUps();
  var raw = PropertiesService.getScriptProperties().getProperty('RESUME_RANGE');
  var r = null;
  try { r = raw ? JSON.parse(raw) : null; } catch (e) {}
  if (r && r.after && r.before) {
    Logger.log('Resuming ' + r.after + ' to ' + r.before);
    processRange(r.after, r.before);
  } else {
    processRange(daysAgo(45), tomorrow());
  }
}

function clearFollowUps() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runFollowUp') ScriptApp.deleteTrigger(t);
  });
}

// ---------------------------------------------------------------- email digest

/**
 * Runs no longer email. Each run appends its results here and the
 * sendNightlyDigest trigger emails ONE summary at DIGEST_HOUR.
 */
function digestQueue() {
  var raw = PropertiesService.getScriptProperties().getProperty('DIGEST_QUEUE');
  try {
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { runs: 0, statements: 0, invoices: 0, skipped: 0, seen: 0, review: 0,
           filed: [], hubdoc: [], newSuppliers: [], problems: [] };
}

/** Keep the queue property well under the 9KB cap on busy days. */
function capList(list, max) {
  if (list.length <= max) return list;
  var dropped = list.length - max;
  list = list.slice(0, max);
  list.push('...and ' + dropped + ' more');
  return list;
}

function queueDigest(stats, report) {
  var q = digestQueue();
  q.runs++;
  q.statements += stats.statements;
  q.invoices += stats.invoices;
  q.skipped += stats.skipped;
  q.seen += stats.seen;
  q.review += stats.review;
  q.filed = capList(q.filed.concat(report.filed), 120);
  q.hubdoc = capList(q.hubdoc.concat(report.hubdoc), 120);
  q.newSuppliers = capList(q.newSuppliers.concat(report.newSuppliers), 40);
  q.problems = capList(q.problems.concat(report.problems), 60);
  PropertiesService.getScriptProperties()
    .setProperty('DIGEST_QUEUE', JSON.stringify(q));
}

/** Fired daily at DIGEST_HOUR by its own trigger (installDigestTrigger). */
function sendNightlyDigest() {
  // Wait out any in-flight run so a run finishing right now isn't missed;
  // an hourly run arriving while we hold the lock skips harmlessly.
  var lock = LockService.getScriptLock();
  var locked = lock.tryLock(3 * 60 * 1000);

  try {
    var q = digestQueue();
    var noteworthy = q.filed.length || q.newSuppliers.length ||
                     q.problems.length || q.review || q.hubdoc.length;

    if (!q.runs || (EMAIL_ONLY_WHEN_NOTEWORTHY && !noteworthy)) {
      PropertiesService.getScriptProperties().deleteProperty('DIGEST_QUEUE');
      Logger.log('Quiet day - no digest email sent.');
      return;
    }

    var lines = [];

    if (q.filed.length) {
      lines.push('FILED TO DROPBOX (' + q.filed.length + ')');
      q.filed.forEach(function (p) { lines.push('  ' + p); });
      lines.push('');
    }

    if (q.hubdoc.length) {
      lines.push('SENT TO HUBDOC (' + q.hubdoc.length + ')');
      q.hubdoc.forEach(function (x) { lines.push('  ' + x); });
      lines.push('');
    }

    if (q.newSuppliers.length) {
      lines.push('NEW SUPPLIERS LEARNED (' + q.newSuppliers.length + ')');
      lines.push('These now get checked automatically. Nothing for you to do,');
      lines.push('but if any looks wrong, run forgetSupplier in the editor.');
      q.newSuppliers.forEach(function (x) { lines.push('  ' + x); });
      lines.push('');
    }

    if (q.review) {
      lines.push('NEEDS A LOOK (' + q.review + ')');
      lines.push('Filed under the Bookkeeping/Needs-review label in Gmail.');
      lines.push('Usually a scanned or password-protected PDF it could not read.');
      lines.push('');
    }

    if (q.problems.length) {
      lines.push('PROBLEMS (' + q.problems.length + ')');
      q.problems.forEach(function (x) { lines.push('  ' + x); });
      lines.push('');
    }

    lines.push('---');
    lines.push('Today: ' + q.runs + ' run(s) | statements ' + q.statements +
               ' | invoices ' + q.invoices + ' | skipped free ' + q.skipped +
               ' | read ' + q.seen);

    MailApp.sendEmail({
      to: ALERT_EMAIL,
      subject: 'Statement filer daily summary: ' + q.filed.length + ' filed, ' +
               q.hubdoc.length + ' to Hubdoc' +
               (q.problems.length ? ', ' + q.problems.length + ' problem(s)' : ''),
      body: lines.join('\n')
    });
    PropertiesService.getScriptProperties().deleteProperty('DIGEST_QUEUE');
    Logger.log('Daily digest emailed to ' + ALERT_EMAIL);
  } catch (err) {
    // Keep the queue - tomorrow's digest will include today.
    Logger.log('Could not send daily digest (kept for tomorrow): ' + err);
  } finally {
    if (locked) lock.releaseLock();
  }
}

/** Run once to install (or move) the 8pm digest trigger. */
function installDigestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendNightlyDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendNightlyDigest').timeBased()
    .everyDays(1).atHour(DIGEST_HOUR).inTimezone('Australia/Sydney').create();
  Logger.log('Nightly digest trigger installed (about ' + DIGEST_HOUR + ':00 Sydney).');
}

function processMailbox(user, after, before, opts, budget, stats, discovered,
                        reviewRows, started, report) {
  var labels = ensureLabels(user);

  var notProcessed = ' -label:' + labelQuery(LABEL_PROCESSED) +
                     ' -label:' + labelQuery(LABEL_REVIEW);
  var dateRange = ' after:' + after + ' before:' + before;
  // Belt and braces on our own mail: -in:sent misses a reply that Gmail
  // filed elsewhere, and -from:me only excludes THIS mailbox - not the
  // other Top Cab address.
  var notOurs = OUR_DOMAINS.map(function (d) { return ' -from:' + d; }).join('') +
                MAILBOXES.map(function (m) { return ' -from:' + m; }).join('');
  var base0 = 'has:attachment -in:sent -in:drafts -in:trash' +
              ' -in:chats -from:me' + notOurs;
  var base = base0 + ' filename:pdf';

  var suppliers = activeSuppliers();
  var queries = [];
  if (XLSX_INVOICE_SUPPLIERS.length) {
    queries.push(base0 + ' filename:(xlsx OR xls)' +
                 ' from:(' + XLSX_INVOICE_SUPPLIERS.join(' OR ') + ')' +
                 ' -{' + NEGATIVE_KEYWORDS.join(' ') + '}' +
                 dateRange + notProcessed);
  }
  if (suppliers.length) {
    queries.push(base + ' from:(' + suppliers.join(' OR ') + ')' +
                 ' -{' + NEGATIVE_KEYWORDS.join(' ') + '}' +
                 dateRange + notProcessed);
  }
  var exclude = suppliers.concat(IGNORE_SENDERS)
                  .map(function (d) { return '-from:' + d; }).join(' ');
  queries.push(base + ' {' + DOC_KEYWORDS.join(' ') + '}' +
               ' -{' + NEGATIVE_KEYWORDS.join(' ') + '} ' + exclude +
               dateRange + notProcessed);

  queries.forEach(function (query) {
    if (Date.now() - started > MAX_RUNTIME_MS) { stats.timedOut = true; return; }
    Logger.log('QUERY: ' + query);

    var ids = gmailSearch(user, query);
    Logger.log('  ' + ids.length + ' message(s)');

    ids.forEach(function (id) {
      if (Date.now() - started > MAX_RUNTIME_MS) { stats.timedOut = true; return; }
      if (budget.left <= 0) { stats.capped++; return; }

      try {
        var outcome = handleMessage(user, id, opts, budget, discovered,
                                    reviewRows, started);
        stats.seen += outcome.seen;
        stats.statements += outcome.statements;
        stats.invoices += outcome.invoices;
        stats.skipped += outcome.skipped;
        report.filed = report.filed.concat(outcome.filed);
        report.newSuppliers = report.newSuppliers.concat(outcome.newSuppliers);
        report.problems = report.problems.concat(outcome.problems);
        report.hubdoc = report.hubdoc.concat(outcome.hubdoc);
        if (opts.dryRun) return;
        if (outcome.deferred) {
          // Left unfinished on purpose - no label, so a follow-up run sees it.
          stats.capped++;
          return;
        }
        addLabel(user, id, outcome.review ? labels.review : labels.processed);
        if (outcome.review) stats.review++;
      } catch (err) {
        Logger.log('  ERROR on message ' + id + ': ' + err);
        report.problems.push(user + ': ' + err);
        if (!opts.dryRun) {
          try { addLabel(user, id, labels.review); } catch (e) {}
        }
        stats.review++;
      }
    });
  });
}

function handleMessage(user, messageId, opts, budget, discovered, reviewRows,
                       started) {
  var out = { seen: 0, statements: 0, invoices: 0, skipped: 0, review: false,
              deferred: false,
              filed: [], newSuppliers: [], problems: [], hubdoc: [] };

  var msg = gmailApi(user, 'GET', 'messages/' + messageId + '?format=full');
  var headers = headerMap(msg);
  var from = headers.from || '';
  var subject = headers.subject || '';
  var date = new Date(Number(msg.internalDate));

  Logger.log('  [msg ' + messageId + '] from: ' + from + ' | subj: ' + subject);

  // 1. Never act on our own mail. A reply of ours quotes the supplier's
  //    words, so the classifier would read THEIR text and act on OUR email.
  if (isOurOwnMail(from)) {
    Logger.log('  SKIP: sent by us (' + from + ')');
    if (!opts.dryRun) markMessageDone(messageId);
    return out;
  }

  // 2. Already handled in an earlier run.
  if (messageAlreadyDone(messageId)) {
    Logger.log('  SKIP: already processed in an earlier run');
    return out;
  }

  // 3. No real PDF attached = nothing to file or forward, whatever the
  //    text says. Checked BEFORE any classification runs. Spreadsheets
  //    count only for suppliers explicitly listed as sending Excel invoices.
  var parts = findPdfParts(msg.payload);
  var msgDomain = senderDomain(from);
  if (msgDomain && XLSX_INVOICE_SUPPLIERS.indexOf(msgDomain) !== -1) {
    parts = parts.concat(findExcelParts(msg.payload));
  }
  Logger.log('  attachments that qualify: ' + parts.length);
  if (!parts.length) {
    Logger.log('  SKIP: no attached PDF of a usable size');
    if (!opts.dryRun) markMessageDone(messageId);
    return out;
  }

  // ---- cheap text triage before opening any PDF ----
  var verdictFromEmail = null;
  var fpMsg = fingerprint(from, subject);

  if (TRIAGE_FIRST && !isBlocked(fpMsg) && learnedCount(fpMsg) < SKIP_AFTER) {
    var names = parts.map(function (p) { return p.filename || 'unnamed.pdf'; });
    var t = triage(from, subject, stripQuoted(extractBody(msg.payload)), names);
    Logger.log('  triage: ' + JSON.stringify(t));

    if (t.likely === 'other' && t.confidence === 'high') {
      Logger.log('  no PDF read needed - email says it is not a statement or invoice');
      learnOther(fpMsg);
      out.skipped += parts.length;
      return out;
    }

    if (t.likely === 'invoice' && t.confidence === 'high' &&
        TRUST_TRIAGE_FOR_INVOICES) {
      // Trust the email text only when it names exactly ONE invoice and there
      // is exactly ONE qualifying PDF. A count of 0 means "the email does not
      // say" - the PDF could be an unenumerated batch needing #split. And with
      // several attachments, one verdict would forward them ALL unread, so a
      // stray terms-and-conditions PDF would land in Hubdoc as a "document".
      // Every other case pays for the PDF read.
      if (Number(t.invoice_count) === 1 && parts.length === 1) {
        verdictFromEmail = { doc_type: 'invoice', supplier: '', period: '',
                             confidence: 'high', invoice_count: 1,
                             one_per_page: false, _tokens: t._tokens || 0 };
      } else {
        Logger.log('  invoice by email text, but invoice_count=' +
                   t.invoice_count + ' and ' + parts.length +
                   ' PDF(s) - reading before forwarding');
      }
    }
  }

  parts.forEach(function (part) {
    var rawName = part.filename || 'unnamed.pdf';
    var isExcel = /\.xlsx?$/i.test(rawName);
    // Downstream (classify, Hubdoc, Dropbox, ledger) always sees the
    // converted PDF's name, so replays stay consistent.
    var name = isExcel ? rawName.replace(/\.xlsx?$/i, '.pdf') : rawName;
    var size = Number((part.body && part.body.size) || 0);

    if (size > MAX_PDF_MB * 1024 * 1024) {
      Logger.log('  free skip (too big): ' + name);
      out.skipped++;
      return;
    }

    var flat = name.toLowerCase().replace(/[\s_\-]/g, '');
    var badName = NEGATIVE_FILENAMES.some(function (n) {
      return flat.indexOf(n.replace(/[\s_\-]/g, '')) !== -1;
    });
    if (badName) {
      Logger.log('  free skip (filename): ' + name);
      out.skipped++;
      return;
    }

    var fp = fingerprint(from, subject);
    if (isBlocked(fp)) {
      Logger.log('  free skip (you blocked it): ' + fp);
      out.skipped++;
      return;
    }
    if (learnedCount(fp) >= SKIP_AFTER) {
      Logger.log('  free skip (learned): ' + fp);
      out.skipped++;
      return;
    }
    // Both guards below leave this attachment UNPROCESSED. Flag it so the
    // message is not labelled done - otherwise a multi-PDF email straddling
    // the cap loses attachments permanently.
    if (!verdictFromEmail && budget.left <= 0) {
      Logger.log('  budget spent before reading ' + name + ' - deferring message');
      out.deferred = true;
      return;
    }
    if (!verdictFromEmail && started &&
        Date.now() - started > MAX_RUNTIME_MS - PDF_MARGIN_MS) {
      Logger.log('  not enough time left to read ' + name + ' safely - deferring');
      out.deferred = true;
      return;
    }

    var bytes = getAttachmentBytes(user, messageId, part);
    if (isExcel) {
      Logger.log('  converting ' + rawName + ' to PDF');
      bytes = convertExcelToPdf(bytes, rawName, part.mimeType);
    }

    var verdict;
    if (verdictFromEmail) {
      verdict = verdictFromEmail;
      Logger.log('  ' + name + ' -> invoice (from email text, PDF not read)');
    } else {
      out.seen++;
      budget.left--;
      verdict = classify(bytes, name, subject, from);
      Logger.log('  ' + name + ' -> ' + JSON.stringify(verdict));
    }

    if (verdict.confidence === 'low' || !verdict.doc_type) {
      out.review = true;
      out.problems.push(user + ': could not read "' + name + '" from ' + from);
      return;
    }

    var issuer = String(verdict.supplier || '').toLowerCase();
    if (OUR_COMPANY_NAMES.some(function (n) { return issuer.indexOf(n) !== -1; })) {
      Logger.log('  skipped (issued by us, not a supplier doc)');
      learnOther(fp);
      out.skipped++;
      return;
    }

    if (verdict.doc_type === 'statement') {
      // A statement we cannot date reliably is worse than one we flag:
      // it lands in the wrong month and nobody notices.
      if (!validPeriod(verdict.period)) {
        Logger.log('  period "' + verdict.period + '" is not credible - needs review');
        out.review = true;
        out.problems.push(user + ': "' + name + '" from ' + from +
                          ' - could not determine which month it covers' +
                          ' (got "' + verdict.period + '")');
        return;
      }

      var handle = senderHandle(from);
      if (handle) {
        discovered[handle] = verdict.supplier || '?';
        if (!opts.dryRun && rememberSupplier(handle, verdict.supplier)) {
          out.newSuppliers.push(handle + ' (' + (verdict.supplier || '?') + ')');
        }
        // Use the FIRST confirmed name for this sender from then on, so one
        // supplier can't end up as "Hafele Australia Pty Ltd" in one month
        // and "Häfele Australia Pty. Ltd." in the next.
        verdict.supplier = canonicalSupplier(handle, verdict.supplier);
      }
      if (!opts.dryRun) {
        var filedAs = uploadStatement(bytes, verdict);
        out.filed.push(filedAs.path);
        if (filedAs.note) out.problems.push(user + ': ' + filedAs.note);
      }
      out.statements++;
    } else if (verdict.doc_type === 'invoice') {
      if (!opts.dryRun && FORWARD_INVOICES_TO_HUBDOC &&
          !newEnoughForHubdoc(date)) {
        Logger.log('  invoice predates the Hubdoc start date - not forwarding');
      } else if (!opts.dryRun && FORWARD_INVOICES_TO_HUBDOC) {
        var ledgerKey = messageId + '|' + name;
        if (alreadySentToHubdoc(ledgerKey)) {
          Logger.log('  already forwarded to Hubdoc previously - not sending again');
        } else {
          var split = sendToHubdoc(user, bytes, name, verdict);
          markSentToHubdoc(ledgerKey);
          out.hubdoc.push(name + (split ? '  (split into ' +
                          verdict.invoice_count + ' invoices)' : ''));
        }
      }
      out.invoices++;
    } else {
      learnOther(fp);
      reviewRows.push({
        mailbox: user, date: date, from: from, subject: subject,
        filename: name, fp: fp, verdict: verdict.doc_type,
        tokens: verdict._tokens || 0
      });
      out.skipped++;
    }
  });

  // Never on a dry run: dryRun files and forwards nothing, so a ledger entry
  // written here would make every REAL run skip this message forever -
  // "marked done, never done", via the mechanism built to prevent it.
  if (!opts.dryRun && !out.deferred) markMessageDone(messageId);
  return out;
}

// ---------------------------------------------------------------- service account

function serviceAccount() {
  var raw = prop('SERVICE_ACCOUNT_JSON');
  var key;
  try {
    key = JSON.parse(raw);
  } catch (e) {
    throw new Error('SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole key file.');
  }
  if (!key.client_email || !key.private_key) {
    throw new Error('SERVICE_ACCOUNT_JSON is missing client_email or private_key.');
  }
  return key;
}

function accessTokenFor(user) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('tok_' + user);
  if (cached) return cached;

  var key = serviceAccount();
  var now = Math.floor(Date.now() / 1000);

  var header = { alg: 'RS256', typ: 'JWT' };
  var claim = {
    iss: key.client_email,
    sub: user,
    scope: GMAIL_SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  var input = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claim));
  var sig = Utilities.computeRsaSha256Signature(input, key.private_key);
  var jwt = input + '.' + Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '');

  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Token request failed for ' + user + ': ' + res.getContentText());
  }

  var body = JSON.parse(res.getContentText());
  cache.put('tok_' + user, body.access_token, 3000);
  return body.access_token;
}

function b64url(s) {
  return Utilities.base64EncodeWebSafe(s).replace(/=+$/, '');
}

// ---------------------------------------------------------------- gmail rest api

function gmailApi(user, method, path, payload) {
  var url = 'https://gmail.googleapis.com/gmail/v1/users/' +
            encodeURIComponent(user) + '/' + path;

  var options = {
    method: method,
    headers: { Authorization: 'Bearer ' + accessTokenFor(user) },
    muteHttpExceptions: true
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  var res = UrlFetchApp.fetch(url, options);
  if (res.getResponseCode() >= 300) {
    throw new Error('Gmail API ' + res.getResponseCode() + ': ' +
                    res.getContentText().slice(0, 400));
  }
  return JSON.parse(res.getContentText());
}

function gmailSearch(user, query) {
  var ids = [];
  var pageToken = null;

  do {
    var path = 'messages?maxResults=100&q=' + encodeURIComponent(query) +
               (pageToken ? '&pageToken=' + pageToken : '');
    var res = gmailApi(user, 'GET', path);
    (res.messages || []).forEach(function (m) { ids.push(m.id); });
    pageToken = res.nextPageToken;
  } while (pageToken && ids.length < 300);

  if (pageToken && ids.length >= 300) {
    Logger.log('  NOTE: stopped at ' + ids.length + ' messages - there are more' +
               ' matching this query. Narrow the date range to see them all.');
  }

  return ids;
}

function ensureLabels(user) {
  var existing = gmailApi(user, 'GET', 'labels').labels || [];
  var byName = {};
  existing.forEach(function (l) { byName[l.name] = l.id; });

  function ensure(name) {
    if (byName[name]) return byName[name];
    return gmailApi(user, 'POST', 'labels', {
      name: name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    }).id;
  }

  return { processed: ensure(LABEL_PROCESSED), review: ensure(LABEL_REVIEW) };
}

function addLabel(user, messageId, labelId) {
  gmailApi(user, 'POST', 'messages/' + messageId + '/modify',
           { addLabelIds: [labelId] });
}

function headerMap(msg) {
  var out = {};
  ((msg.payload && msg.payload.headers) || []).forEach(function (h) {
    out[h.name.toLowerCase()] = h.value;
  });
  return out;
}

/**
 * Real attached PDFs only. Excludes inline parts (signature logos, embedded
 * images) and anything too small to be a genuine document.
 */
function findPdfParts(payload) {
  var found = [];
  (function walk(part) {
    if (!part) return;
    var name = part.filename || '';
    var isPdf = part.mimeType === 'application/pdf' || /\.pdf$/i.test(name);

    if (name && isPdf && part.body && part.body.attachmentId) {
      var inline = false;
      (part.headers || []).forEach(function (h) {
        var k = String(h.name || '').toLowerCase();
        if (k === 'content-id') inline = true;
        if (k === 'content-disposition' &&
            String(h.value || '').toLowerCase().indexOf('inline') === 0) inline = true;
      });

      var size = Number((part.body && part.body.size) || 0);

      if (inline) {
        Logger.log('  ignoring inline PDF: ' + name);
      } else if (size && size < MIN_PDF_BYTES) {
        Logger.log('  ignoring tiny PDF (' + size + ' bytes, likely a logo): ' + name);
      } else {
        found.push(part);
      }
    }
    (part.parts || []).forEach(walk);
  })(payload);
  return found;
}

function getAttachmentBytes(user, messageId, part) {
  var res = gmailApi(user, 'GET', 'messages/' + messageId +
                     '/attachments/' + part.body.attachmentId);
  return Utilities.base64DecodeWebSafe(res.data);
}

/**
 * Excel attachments, same gates as findPdfParts. Only called for senders
 * in XLSX_INVOICE_SUPPLIERS.
 */
function findExcelParts(payload) {
  var found = [];
  (function walk(part) {
    if (!part) return;
    var name = part.filename || '';
    if (name && /\.xlsx?$/i.test(name) && part.body && part.body.attachmentId) {
      var size = Number((part.body && part.body.size) || 0);
      if (size && size < MIN_PDF_BYTES) {
        Logger.log('  ignoring tiny spreadsheet: ' + name);
      } else if (size > MAX_PDF_MB * 1024 * 1024) {
        Logger.log('  ignoring oversized spreadsheet: ' + name);
      } else {
        found.push(part);
      }
    }
    (part.parts || []).forEach(walk);
  })(payload);
  return found;
}

/**
 * Spreadsheet -> PDF via a temporary Google Sheet in the script owner's
 * Drive, deleted immediately, success or fail. Needs the Drive API advanced
 * service enabled (Editor > Services > + > Drive API) - without it this
 * throws and the message lands in Needs-review, which is the right failure.
 */
function convertExcelToPdf(bytes, name, mimeType) {
  var blob = Utilities.newBlob(bytes,
      mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      name);
  var file = Drive.Files.insert({ title: 'tmp-invoice-convert ' + name },
                                blob, { convert: true });
  try {
    var res = UrlFetchApp.fetch(
        'https://docs.google.com/spreadsheets/d/' + file.id +
        '/export?format=pdf&portrait=true&fitw=true&gridlines=false',
        { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
          muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      throw new Error('Spreadsheet PDF export failed (' + res.getResponseCode() +
                      ') for ' + name);
    }
    return res.getContent();
  } finally {
    try { Drive.Files.remove(file.id); } catch (e) {}
  }
}

/** Returns true if #split was applied. */
function sendToHubdoc(user, bytes, filename, verdict) {
  var to = prop('HUBDOC_EMAIL');
  var boundary = '----tcj' + Date.now();
  var subject = 'Invoice: ' + (verdict.supplier || '') + ' ' + (verdict.period || '');
  var split = false;
  if (verdict.one_per_page === true && Number(verdict.invoice_count) > 1) {
    subject += ' #split';
    split = true;
    Logger.log('  ' + verdict.invoice_count + ' invoices, one per page - using #split');
  }

  var mime =
    'From: ' + user + '\r\n' +
    'To: ' + to + '\r\n' +
    'Subject: ' + subject + '\r\n' +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: multipart/mixed; boundary="' + boundary + '"\r\n\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: text/plain; charset="UTF-8"\r\n\r\n' +
    'Forwarded automatically by the supplier document router.\r\n\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: application/pdf; name="' + filename + '"\r\n' +
    'Content-Transfer-Encoding: base64\r\n' +
    'Content-Disposition: attachment; filename="' + filename + '"\r\n\r\n' +
    Utilities.base64Encode(bytes).replace(/(.{76})/g, '$1\r\n') + '\r\n' +
    '--' + boundary + '--';

  gmailApi(user, 'POST', 'messages/send',
           { raw: Utilities.base64EncodeWebSafe(mime).replace(/=+$/, '') });
  Logger.log('  sent to Hubdoc');
  return split;
}

// ---------------------------------------------------------------- triage (cheap)

/** Pull the plain-text body out of a Gmail message payload. */
function extractBody(payload) {
  var text = '';
  (function walk(part) {
    if (!part || text.length > 4000) return;
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      text += Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data))
                       .getDataAsString() + '\n';
    }
    (part.parts || []).forEach(walk);
  })(payload);

  if (!text) {
    (function walkHtml(part) {
      if (!part || text.length > 4000) return;
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        text += Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data))
                         .getDataAsString().replace(/<[^>]+>/g, ' ') + '\n';
      }
      (part.parts || []).forEach(walkHtml);
    })(payload);
  }

  return text.replace(/\s+/g, ' ').trim().slice(0, 1500);
}

/**
 * Text-only classification from the email itself. Costs a few hundred tokens
 * instead of the several thousand a PDF read costs.
 */
function triage(from, subject, body, filenames) {
  var prompt =
    'An Australian joinery business received this email with PDF attachment(s).\n' +
    'Judge from the email text alone what the attachment(s) most likely are.\n\n' +
    'From: ' + from + '\n' +
    'Subject: ' + subject + '\n' +
    'Attachments: ' + filenames.join(', ') + '\n' +
    'Body: ' + body + '\n\n' +
    'Return JSON only:\n' +
    '  likely - "statement", "invoice", "other", or "unclear"\n' +
    '  confidence - "high" or "low"\n' +
    '  invoice_count - if the email text lists or names separate invoice\n' +
    '             numbers, how many. Use 1 when it clearly refers to a single\n' +
    '             invoice. Use 0 if the email text does not say.\n\n' +
    'Use "high" only when the email text makes it obvious. If the subject is\n' +
    'just a reference number, a date, or a filename, say "unclear" with "low".\n' +
    'If there is ANY hint of a statement of account, monthly account summary,\n' +
    'payment reminder, overdue balance or outstanding balance, say "statement"\n' +
    '- never "invoice".\n' +
    '"other" covers delivery dockets, quotes, order confirmations, receipts,\n' +
    'remittance advices, price lists and marketing.\n\n' +
    '{"likely":"invoice","confidence":"high","invoice_count":1}';

  var payload = {
    model: CLAUDE_MODEL,
    max_tokens: 100,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  };

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': prop('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    return { likely: 'unclear', confidence: 'low', _tokens: 0 };
  }

  var b = JSON.parse(res.getContentText());
  var tok = b.usage ? (b.usage.input_tokens || 0) + (b.usage.output_tokens || 0) : 0;
  var t = b.content.filter(function (x) { return x.type === 'text'; })
           .map(function (x) { return x.text; }).join('')
           .replace(/```json|```/g, '').trim();

  try {
    var parsed = JSON.parse(t);
    parsed._tokens = tok;
    return parsed;
  } catch (e) {
    return { likely: 'unclear', confidence: 'low', _tokens: tok };
  }
}

// ---------------------------------------------------------------- classification

function classify(bytes, filename, subject, from) {
  var prompt =
    'You are sorting documents for an Australian joinery business.\n\n' +
    'Email subject: ' + subject + '\n' +
    'From: ' + from + '\n' +
    'Attachment filename: ' + filename + '\n\n' +
    'Classify the attached PDF.\n\n' +
    'doc_type must be one of:\n' +
    '  "statement" - a statement of account. Lists MULTIPLE transactions or\n' +
    '                invoices over a period and shows a closing or outstanding\n' +
    '                balance. Often says "Statement of Account", may show ageing\n' +
    '                buckets (30/60/90 days). Payment reminders and overdue\n' +
    '                account notices listing several invoices count as well.\n' +
    '  "invoice"   - a tax invoice or bill for a SINGLE order or delivery.\n' +
    '                Has an invoice number and an amount due for that order.\n' +
    '  "other"     - delivery docket, quote, price list, remittance advice,\n' +
    '                marketing, order confirmation, or anything else.\n\n' +
    'Also return:\n' +
    '  supplier - the company that ISSUED the document (not Top Cab Joinery)\n' +
    '  period   - "YYYY-MM". For a statement, the month the statement covers,\n' +
    '             NOT the date it was sent. A statement sent 3 September\n' +
    '             covering August is "2026-08". If a document spans several\n' +
    '             months, use the most recent month it covers. Never return a\n' +
    '             month in the future. For an invoice, the invoice month.\n' +
    '  confidence - "high" or "low". Use "low" if the PDF is unreadable, is a\n' +
    '             scan you cannot parse, or does not clearly fit one type.\n' +
    '  invoice_count - how many SEPARATE invoices this PDF contains (1 if it is\n' +
    '             one invoice, even a long one). Suppliers sometimes batch\n' +
    '             several one-page invoices into a single file.\n' +
    '  one_per_page - true ONLY if there are multiple invoices AND each occupies\n' +
    '             exactly one page. False for a single invoice of any length,\n' +
    '             false if any invoice runs over more than one page, and false\n' +
    '             if a page contains more than one invoice.\n\n' +
    'Reply with ONLY raw JSON, no markdown fences, no commentary:\n' +
    '{"doc_type":"statement","supplier":"Polytec","period":"2026-08","confidence":"high"}';

  var payload = {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: Utilities.base64Encode(bytes)
          }
        },
        { type: 'text', text: prompt }
      ]
    }]
  };

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': prop('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    Logger.log('  Claude API ' + res.getResponseCode() + ': ' +
               res.getContentText().slice(0, 300));
    return { confidence: 'low', _tokens: 0 };
  }

  var body = JSON.parse(res.getContentText());
  var tokens = body.usage
    ? (body.usage.input_tokens || 0) + (body.usage.output_tokens || 0)
    : 0;
  var text = body.content
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('')
    .replace(/```json|```/g, '')
    .trim();

  try {
    var parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      Logger.log('  (model returned ' + parsed.length + ' verdicts, using the first)');
      parsed = parsed[0] || {};
    }
    parsed._tokens = tokens;
    return parsed;
  } catch (e) {
    // Sometimes the model wraps the JSON in prose. Pull out the first object.
    var m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        var salvaged = JSON.parse(m[0]);
        if (Array.isArray(salvaged)) salvaged = salvaged[0] || {};
        salvaged._tokens = tokens;
        Logger.log('  (salvaged JSON from a wrapped reply)');
        return salvaged;
      } catch (e2) {}
    }
    Logger.log('  Unparseable reply. stop_reason=' + (body.stop_reason || '?') +
               '  text="' + text.slice(0, 120) + '"');
    return { confidence: 'low', _tokens: tokens };
  }
}

// ---------------------------------------------------------------- dropbox

/**
 * Overwrite is safe only when the bytes are identical. A payment reminder
 * misread as a statement must never silently replace the real statement at
 * the same supplier+month path, so:
 *   nothing there      -> upload
 *   identical content  -> skip, it is already filed
 *   different content  -> file alongside as _2 and raise it in the digest
 * Returns { path, note } - note is non-empty when a human should look.
 */
function uploadStatement(bytes, verdict) {
  var supplier = sanitise(verdict.supplier || 'Unknown');
  var period = verdict.period;
  var path = DROPBOX_ROOT + '/' + period + '/' + period + '_' + supplier + '.pdf';

  var existing = dropboxContentHash(path);

  if (existing === null) {
    dropboxUpload(path, bytes);
    Logger.log('  filed -> ' + path);
    return { path: path, note: '' };
  }

  if (existing === dropboxHashOf(bytes)) {
    Logger.log('  already filed, identical file -> ' + path);
    return { path: path, note: '' };
  }

  var altPath = DROPBOX_ROOT + '/' + period + '/' + period + '_' + supplier + '_2.pdf';
  dropboxUpload(altPath, bytes);
  Logger.log('  DIFFERENT document already at ' + path + ' - filed as ' + altPath);
  return {
    path: altPath,
    note: 'Two different documents for ' + supplier + ' ' + period +
          '. Check which is the real statement: ' + path + ' and ' + altPath
  };
}

/**
 * Dropbox content_hash: SHA-256 of each 4MB block, digests concatenated,
 * then SHA-256 again. Our 5MB cap means one or two blocks.
 */
function dropboxHashOf(bytes) {
  var BLOCK = 4 * 1024 * 1024;
  var concat = [];
  for (var i = 0; i < bytes.length; i += BLOCK) {
    var block = bytes.slice(i, Math.min(i + BLOCK, bytes.length));
    concat = concat.concat(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, block));
  }
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, concat);
  return digest.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

/** content_hash of whatever is at path, or null if nothing is there. */
function dropboxContentHash(path) {
  var res = UrlFetchApp.fetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + dropboxAccessToken() },
    payload: JSON.stringify({ path: path }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() === 200) {
    return JSON.parse(res.getContentText()).content_hash || '';
  }
  if (res.getContentText().indexOf('not_found') !== -1) return null;

  // Anything else (rate limit, transient): treat as unknown and don't
  // overwrite - the _2 path is the safe side of this decision.
  Logger.log('  could not check ' + path + ': ' + res.getContentText().slice(0, 160));
  return '';
}

function dropboxAccessToken() {
  var store = PropertiesService.getScriptProperties();
  var token = store.getProperty('DBX_TOKEN');
  var expiry = Number(store.getProperty('DBX_TOKEN_EXPIRY') || 0);
  if (token && Date.now() < expiry - 60000) return token;

  var res = UrlFetchApp.fetch('https://api.dropbox.com/oauth2/token', {
    method: 'post',
    payload: {
      grant_type: 'refresh_token',
      refresh_token: prop('DROPBOX_REFRESH_TOKEN'),
      client_id: prop('DROPBOX_APP_KEY'),
      client_secret: prop('DROPBOX_APP_SECRET')
    },
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Dropbox token refresh failed: ' + res.getContentText());
  }

  var body = JSON.parse(res.getContentText());
  store.setProperty('DBX_TOKEN', body.access_token);
  store.setProperty('DBX_TOKEN_EXPIRY', String(Date.now() + body.expires_in * 1000));
  return body.access_token;
}

function dropboxUpload(path, bytes, mode) {
  for (var attempt = 0; attempt < 4; attempt++) {
    var res = UrlFetchApp.fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'post',
      contentType: 'application/octet-stream',
      headers: {
        Authorization: 'Bearer ' + dropboxAccessToken(),
        // Deterministic path + overwrite = a replay lands on the same file
        // instead of creating "(1)". Also collapses repeat reminder emails
        // carrying the same statement into a single file.
        'Dropbox-API-Arg': JSON.stringify({
          path: path, mode: mode || 'overwrite', autorename: false, mute: true
        })
      },
      payload: bytes,
      muteHttpExceptions: true
    });

    if (res.getResponseCode() === 200) return;

    var body = res.getContentText();
    if (body.indexOf('too_many_write_operations') !== -1) {
      Logger.log('  Dropbox busy, retrying...');
      Utilities.sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error('Dropbox upload failed: ' + body);
  }
  throw new Error('Dropbox upload failed after retries: ' + path);
}

/** Run manually to list everything filed so far, with a per-month count. */
function whatsInDropbox() {
  var token = dropboxAccessToken();
  var files = [];

  var res = UrlFetchApp.fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ path: DROPBOX_ROOT, recursive: true, limit: 500 }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    Logger.log('Dropbox error: ' + res.getContentText());
    return;
  }

  var body = JSON.parse(res.getContentText());
  files = files.concat(body.entries || []);

  while (body.has_more) {
    var more = UrlFetchApp.fetch(
      'https://api.dropboxapi.com/2/files/list_folder/continue', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({ cursor: body.cursor }),
        muteHttpExceptions: true
      });
    if (more.getResponseCode() !== 200) break;
    body = JSON.parse(more.getContentText());
    files = files.concat(body.entries || []);
  }

  var pdfs = files.filter(function (f) { return f['.tag'] === 'file'; });
  pdfs.sort(function (a, b) { return a.path_display < b.path_display ? -1 : 1; });

  var byMonth = {};
  pdfs.forEach(function (f) {
    var m = f.path_display.match(/\/(\d{4}-\d{2})\//);
    var key = m ? m[1] : 'other';
    byMonth[key] = (byMonth[key] || 0) + 1;
    Logger.log(f.path_display);
  });

  Logger.log('--- ' + pdfs.length + ' file(s) total ---');
  Object.keys(byMonth).sort().forEach(function (k) {
    Logger.log(k + ': ' + byMonth[k]);
  });
}

// ---------------------------------------------------------------- own mail

/** True if this message came from us, whichever Top Cab address sent it. */
function isOurOwnMail(from) {
  var f = String(from || '').toLowerCase();
  var domain = senderDomain(f);
  if (domain && OUR_DOMAINS.indexOf(domain) !== -1) return true;
  return MAILBOXES.some(function (m) { return f.indexOf(m.toLowerCase()) !== -1; });
}

/**
 * Cut a reply down to what the sender actually wrote. Without this the
 * classifier reads the quoted supplier email underneath and acts on it -
 * which is how one of our own replies reached Hubdoc.
 */
function stripQuoted(body) {
  if (!body) return '';
  var text = String(body);

  var cutPoints = [
    /On .{0,80}?\bwrote:/i,          // On 12 May 2026, X wrote:
    /-{2,}\s*Original Message\s*-{2,}/i,
    /-{2,}\s*Forwarded message\s*-{2,}/i,
    /\bFrom:\s*[^\s@]+@[^\s@]+/i,   // quoted header block
    /\bSent from my \w+/i
  ];

  var cut = text.length;
  cutPoints.forEach(function (re) {
    var m = text.search(re);
    if (m !== -1 && m < cut) cut = m;
  });
  text = text.slice(0, cut);

  // Drop any remaining quote lines.
  text = text.split('\n')
             .filter(function (line) { return line.trim().charAt(0) !== '>'; })
             .join('\n');

  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Diagnostic. Shows how each recent message from a sender would be judged,
 * without classifying or forwarding anything. Use it to prove a specific
 * email is now being skipped:
 *   inspectSender('wepromoteyou.com.au')
 */
function inspectSender(sender) {
  MAILBOXES.forEach(function (user) {
    Logger.log('===== ' + user + ' =====');
    var ids = gmailSearch(user, 'from:' + sender + ' OR to:' + sender +
                          ' newer_than:200d');
    Logger.log(ids.length + ' message(s) in the thread history');

    ids.forEach(function (id) {
      try {
        var msg = gmailApi(user, 'GET', 'messages/' + id + '?format=full');
        var h = headerMap(msg);
        var from = h.from || '';
        var pdfs = findPdfParts(msg.payload);
        var why = [];
        if (isOurOwnMail(from)) why.push('OURS');
        if (!pdfs.length) why.push('NO-PDF');
        if (messageAlreadyDone(id)) why.push('ALREADY-DONE');
        Logger.log((why.length ? 'SKIP [' + why.join(',') + '] ' : 'WOULD PROCESS ') +
                   from + ' | ' + (h.subject || '') +
                   ' | pdfs=' + pdfs.length);
      } catch (e) {
        Logger.log('  error on ' + id + ': ' + e);
      }
    });
  });
}

// ---------------------------------------------------------------- message ledger

/**
 * Per-message record of what has been handled. The Gmail labels are the
 * cheap first filter; this is the guarantee, because a label can be removed
 * by hand or by a repair function without us noticing.
 */
/**
 * Apps Script caps ONE property at 9KB, so ~3000 message IDs cannot live in
 * a single value. The ledger is split across shards: PROC_0 is the newest,
 * and when it fills the whole set rotates and the oldest shard falls off.
 */
var LEDGER_SHARDS = 12;
var LEDGER_PER_SHARD = 250;
var _ledgerCache = null;

function ledgerLoad() {
  if (_ledgerCache) return _ledgerCache;
  var all = PropertiesService.getScriptProperties().getProperties();
  var shards = [];
  for (var i = 0; i < LEDGER_SHARDS; i++) {
    var arr = [];
    try { arr = all['PROC_' + i] ? JSON.parse(all['PROC_' + i]) : []; } catch (e) { arr = []; }
    shards.push(arr);
  }
  _ledgerCache = shards;
  return shards;
}

function messageAlreadyDone(id) {
  if (!id) return false;
  var shards = ledgerLoad();
  for (var i = 0; i < shards.length; i++) {
    if (shards[i].indexOf(id) !== -1) return true;
  }
  return false;
}

function markMessageDone(id) {
  if (!id || messageAlreadyDone(id)) return;
  var shards = ledgerLoad();
  var props = PropertiesService.getScriptProperties();

  shards[0].push(id);

  if (shards[0].length >= LEDGER_PER_SHARD) {
    shards.pop();
    shards.unshift([]);
    var payload = {};
    for (var i = 0; i < LEDGER_SHARDS; i++) {
      payload['PROC_' + i] = JSON.stringify(shards[i] || []);
    }
    props.setProperties(payload);
  } else {
    props.setProperty('PROC_0', JSON.stringify(shards[0]));
  }
  _ledgerCache = shards;
}

/** Add many IDs at once without rewriting every shard per ID. */
function markManyDone(ids) {
  var added = 0;
  ids.forEach(function (id) {
    if (id && !messageAlreadyDone(id)) { markMessageDone(id); added++; }
  });
  return added;
}

function showLedgerSize() {
  var shards = ledgerLoad();
  var total = 0;
  shards.forEach(function (a, i) {
    if (a.length) Logger.log('  PROC_' + i + ': ' + a.length);
    total += a.length;
  });
  Logger.log(total + ' message(s) in the processed ledger');
}

/**
 * ONE-OFF. Fills the ledger from mail already labelled Processed or
 * Needs-review, so switching to per-message tracking does not re-read
 * months of old email. Safe to run more than once.
 */
function seedLedgerFromLabels() {
  // Carry across anything written by the old single-property version.
  var props = PropertiesService.getScriptProperties();
  var legacy = props.getProperty('PROCESSED_IDS');
  if (legacy) {
    try { markManyDone(JSON.parse(legacy)); } catch (e) {}
    props.deleteProperty('PROCESSED_IDS');
    Logger.log('Carried across the old single-property ledger.');
  }

  var found = [];
  MAILBOXES.forEach(function (user) {
    ['bookkeeping-processed', 'bookkeeping-needs-review'].forEach(function (lbl) {
      found = found.concat(gmailSearch(user, 'label:' + lbl + ' newer_than:120d'));
    });
  });

  var added = markManyDone(found);
  Logger.log('Seeded ' + added + ' message(s) from labels.');
  showLedgerSize();
}

/**
 * ONE-OFF repair for ledger entries written by dry runs before the dryRun
 * guard existed. A ledger entry whose message carries NEITHER Bookkeeping
 * label was marked done without being processed - remove it so the next
 * real run picks the message up. Labels are the truth here. Entries whose
 * message cannot be found in any mailbox (deleted mail) are kept: they can
 * never be re-queried, so they are harmless either way.
 * Roughly one Gmail call per entry - a few hundred entries take a couple
 * of minutes. Safe to run more than once.
 */
function repairLedgerAgainstLabels() {
  var labelIds = {};
  MAILBOXES.forEach(function (user) { labelIds[user] = ensureLabels(user); });

  var shards = ledgerLoad();
  var kept = 0, removed = 0;

  for (var s = 0; s < shards.length; s++) {
    var cleaned = [];
    shards[s].forEach(function (id) {
      var found = false;
      var labelled = false;
      for (var m = 0; m < MAILBOXES.length && !found; m++) {
        var user = MAILBOXES[m];
        try {
          var msg = gmailApi(user, 'GET', 'messages/' + id + '?format=minimal');
          found = true;
          var ls = msg.labelIds || [];
          labelled = ls.indexOf(labelIds[user].processed) !== -1 ||
                     ls.indexOf(labelIds[user].review) !== -1;
        } catch (e) {} // not in this mailbox - try the next
      }
      if (found && !labelled) {
        removed++;
        Logger.log('  removing unlabelled ledger entry ' + id);
      } else {
        cleaned.push(id);
        kept++;
      }
    });
    shards[s] = cleaned;
  }

  var payload = {};
  for (var i = 0; i < LEDGER_SHARDS; i++) {
    payload['PROC_' + i] = JSON.stringify(shards[i] || []);
  }
  PropertiesService.getScriptProperties().setProperties(payload);
  _ledgerCache = shards;
  Logger.log('Ledger repair: kept ' + kept + ', removed ' + removed + '.');
}

// ---------------------------------------------------------------- hubdoc ledger

/**
 * Email is the one sink here that can't be undone and doesn't show
 * duplicates. Record every successful forward so a crash between sending
 * and labelling replays into a ledger hit, not a second invoice in Xero.
 */
function hubdocLedger() {
  var raw = PropertiesService.getScriptProperties().getProperty('HUBDOC_SENT');
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

/** Emails received before HUBDOC_START_DATE were handled by hand already. */
function newEnoughForHubdoc(received) {
  if (!HUBDOC_START_DATE) return true;
  var stamp = Utilities.formatDate(received, 'Australia/Sydney', 'yyyy-MM-dd');
  return stamp >= HUBDOC_START_DATE;
}

function alreadySentToHubdoc(key) {
  return !!hubdocLedger()[key];
}

function markSentToHubdoc(key) {
  var led = hubdocLedger();
  led[key] = Date.now();

  // Age out anything older than 60 days - beyond the rolling window, so it
  // can never be reconsidered anyway.
  var cutoff = Date.now() - 60 * 86400000;
  Object.keys(led).forEach(function (k) {
    if (led[k] < cutoff) delete led[k];
  });

  PropertiesService.getScriptProperties()
    .setProperty('HUBDOC_SENT', JSON.stringify(led));
}

function showHubdocLedger() {
  var led = hubdocLedger();
  var keys = Object.keys(led);
  Logger.log(keys.length + ' invoice(s) forwarded to Hubdoc in the last 60 days');
  keys.sort(function (a, b) { return led[b] - led[a]; })
      .slice(0, 40)
      .forEach(function (k) {
        Logger.log('  ' + Utilities.formatDate(new Date(led[k]),
                   'Australia/Sydney', 'yyyy-MM-dd HH:mm') + '  ' + k);
      });
}

// ---------------------------------------------------------------- supplier memory

/** Seed list plus everything the script has taught itself. */
function activeSuppliers() {
  return KNOWN_SUPPLIERS.concat(Object.keys(rememberedSuppliers()));
}

function rememberedSuppliers() {
  var raw = PropertiesService.getScriptProperties().getProperty('AUTO_SUPPLIERS');
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

function rememberSupplier(handle, name) {
  if (!handle) return false;
  if (KNOWN_SUPPLIERS.indexOf(handle) !== -1) return false;
  var d = senderDomain(handle);
  if (d && RELAY_DOMAINS.indexOf(d) !== -1) {
    Logger.log('  not remembering ' + handle + ' - that is a mail relay, not a supplier');
    return false;
  }
  var store = rememberedSuppliers();
  if (store[handle]) return false;
  store[handle] = name || '?';
  PropertiesService.getScriptProperties()
    .setProperty('AUTO_SUPPLIERS', JSON.stringify(store));
  Logger.log('  AUTO-ADDED SUPPLIER: ' + handle + ' (' + name + ')');
  return true;
}

/** Run manually to see every supplier it has taught itself. */
function showSuppliers() {
  var store = rememberedSuppliers();
  Logger.log('Seed list: ' + KNOWN_SUPPLIERS.join(', '));
  Logger.log('Learned:');
  Object.keys(store).forEach(function (k) { Logger.log('  ' + k + '  (' + store[k] + ')'); });
}

/** One-off cleanup: drop any relay addresses that were learned by mistake. */
function forgetRelays() {
  var store = rememberedSuppliers();
  var removed = 0;
  Object.keys(store).forEach(function (h) {
    var d = senderDomain(h);
    if (d && RELAY_DOMAINS.indexOf(d) !== -1) { delete store[h]; removed++; }
  });
  PropertiesService.getScriptProperties()
    .setProperty('AUTO_SUPPLIERS', JSON.stringify(store));
  Logger.log('Removed ' + removed + ' relay address(es) from the learned suppliers.');
}

/**
 * The first confirmed name for a sender wins from then on, so the same
 * supplier always files under one spelling.
 */
function canonicalSupplier(handle, claudeName) {
  if (!handle) return claudeName;

  // CANONICAL_NAMES covers every supplier, seed list included.
  // AUTO_SUPPLIERS is consulted second, for names learned before this existed.
  var names = canonicalNames();
  var known = names[handle] || rememberedSuppliers()[handle];

  if (known && known !== '?') {
    if (claudeName && known !== claudeName) {
      Logger.log('  using known name "' + known + '" (Claude said "' + claudeName + '")');
    }
    if (!names[handle]) rememberCanonicalName(handle, known);
    return known;
  }

  if (claudeName) rememberCanonicalName(handle, claudeName);
  return claudeName;
}

/**
 * First confirmed name per sender. Separate from AUTO_SUPPLIERS because that
 * store deliberately refuses seed-list handles - which meant seed suppliers
 * (hafele.com.au among them) never got a canonical name at all.
 */
function canonicalNames() {
  var raw = PropertiesService.getScriptProperties().getProperty('CANONICAL_NAMES');
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

function rememberCanonicalName(handle, name) {
  if (!handle || !name || name === '?') return;
  var names = canonicalNames();
  if (names[handle]) return;
  names[handle] = name;
  PropertiesService.getScriptProperties()
    .setProperty('CANONICAL_NAMES', JSON.stringify(names));
  Logger.log('  filing ' + handle + ' as "' + name + '" from now on');
}

/** Run manually to see, or correct, the name each supplier files under. */
function showCanonicalNames() {
  var names = canonicalNames();
  var keys = Object.keys(names).sort();
  Logger.log(keys.length + ' supplier name(s) locked in:');
  keys.forEach(function (k) { Logger.log('  ' + k + '  ->  ' + names[k]); });
}

/** Fix a wrong or ugly filing name: setCanonicalName('hafele.com.au', 'Hafele'). */
function setCanonicalName(handle, name) {
  var names = canonicalNames();
  names[handle] = name;
  PropertiesService.getScriptProperties()
    .setProperty('CANONICAL_NAMES', JSON.stringify(names));
  Logger.log(handle + ' will now file as "' + name + '"');
}

function forgetSupplier(handle) {
  var store = rememberedSuppliers();
  delete store[handle];
  PropertiesService.getScriptProperties()
    .setProperty('AUTO_SUPPLIERS', JSON.stringify(store));
  Logger.log('Forgot ' + handle);
}

/** Undo the temperature-bug run: clear Needs-review across Feb-Jun. */
function undoTonight() {
  MAILBOXES.forEach(function (user) {
    var labels = ensureLabels(user);
    var cleared = 0;
    var ids = gmailSearch(user, 'label:bookkeeping-needs-review' +
                          ' after:2026/02/01 before:2026/06/01');
    ids.forEach(function (id) {
      try {
        gmailApi(user, 'POST', 'messages/' + id + '/modify',
                 { removeLabelIds: [labels.review] });
        cleared++;
      } catch (e) {}
    });
    Logger.log(user + ': cleared ' + cleared + ' needs-review label(s)');
  });
}

/** One-off: Cordell is a CUSTOMER, not a supplier - it was learned by mistake. */
function fixCordell() {
  forgetSupplier('cordellconstructions.com.au');
}

// ---------------------------------------------------------------- learning

function fingerprint(from, subject) {
  var domain = senderDomain(from) || 'unknown';
  var subj = String(subject || '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^a-z#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 45);
  return domain + '|' + subj;
}

function learnedStore() {
  var raw = PropertiesService.getScriptProperties().getProperty('LEARNED_SKIPS');
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

function learnedCount(fp) {
  return learnedStore()[fp] || 0;
}

function learnOther(fp) {
  // A blank email subject makes every email from that domain look identical,
  // so learning to skip it could silently skip real statements. Never learn
  // from a blank subject.
  if (!fp || fp.charAt(fp.length - 1) === '|') {
    Logger.log('  (not learning "' + fp + '" - blank subject, too risky to skip)');
    return;
  }

  // Never learn to skip a known supplier. If their ERP sends quotes and
  // statements under one templated subject, two junk verdicts would
  // otherwise silence their statements permanently.
  // Note: suppliers on free email (gmail.com etc) are stored as full
  // addresses, so this domain check would not match them. None today, and
  // protecting all of gmail.com wholesale would be wrong anyway.
  var dom = fp.split('|')[0];
  if (activeSuppliers().indexOf(dom) !== -1) {
    Logger.log('  (not learning "' + fp + '" - ' + dom + ' is a known supplier)');
    return;
  }
  var store = learnedStore();
  store[fp] = (store[fp] || 0) + 1;

  var keys = Object.keys(store);
  if (keys.length > 200) {
    keys.sort(function (a, b) { return store[a] - store[b]; })
        .slice(0, keys.length - 200)
        .forEach(function (k) { delete store[k]; });
  }

  PropertiesService.getScriptProperties()
    .setProperty('LEARNED_SKIPS', JSON.stringify(store));

  if (store[fp] === SKIP_AFTER) {
    Logger.log('  LEARNED: will skip "' + fp + '" from now on');
  }
}

function showLearned() {
  var store = learnedStore();
  var keys = Object.keys(store).sort(function (a, b) { return store[b] - store[a]; });
  Logger.log(keys.length + ' pattern(s) learned:');
  keys.forEach(function (k) {
    Logger.log((store[k] >= SKIP_AFTER ? '[SKIPPING] ' : '[' + store[k] + '/' + SKIP_AFTER + '] ') + k);
  });
}

/**
 * One-off cleanup: removes any learned or blocked patterns that came from
 * blank email subjects (they end in "|"). Those are too broad to be safe.
 */
function forgetBlankSubjects() {
  var learned = learnedStore();
  var removedL = 0;
  Object.keys(learned).forEach(function (fp) {
    if (fp.charAt(fp.length - 1) === '|') { delete learned[fp]; removedL++; }
  });
  PropertiesService.getScriptProperties()
    .setProperty('LEARNED_SKIPS', JSON.stringify(learned));

  var blocked = blockedStore();
  var removedB = 0;
  Object.keys(blocked).forEach(function (fp) {
    if (fp.charAt(fp.length - 1) === '|') { delete blocked[fp]; removedB++; }
  });
  PropertiesService.getScriptProperties()
    .setProperty('BLOCKED_FPS', JSON.stringify(blocked));

  Logger.log('Removed ' + removedL + ' learned and ' + removedB +
             ' blocked blank-subject pattern(s).');
}

function resetLearned() {
  PropertiesService.getScriptProperties().deleteProperty('LEARNED_SKIPS');
  Logger.log('Learned skip list cleared.');
}

// ---------------------------------------------------------------- your blocklist

function blockedStore() {
  var raw = PropertiesService.getScriptProperties().getProperty('BLOCKED_FPS');
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

function isBlocked(fp) {
  return blockedStore()[fp] === true;
}

/** Run after ticking boxes in the review sheet. */
function applyBlocks() {
  var sh = reviewSheet().getSheetByName('Not statements');
  var last = sh.getLastRow();
  if (last < 2) { Logger.log('Nothing in the review sheet yet.'); return; }

  var data = sh.getRange(2, 1, last - 1, 9).getValues();
  var blocked = blockedStore();
  var added = 0, removed = 0;

  data.forEach(function (row) {
    var tick = row[0] === true;
    var fp = row[8];
    if (!fp) return;
    if (tick && !blocked[fp]) { blocked[fp] = true; added++; }
    if (!tick && blocked[fp]) { delete blocked[fp]; removed++; }
  });

  PropertiesService.getScriptProperties()
    .setProperty('BLOCKED_FPS', JSON.stringify(blocked));

  Logger.log('Blocklist updated: ' + added + ' added, ' + removed + ' removed.');
  Logger.log(Object.keys(blocked).length + ' pattern(s) will never be read again.');
}

// ---------------------------------------------------------------- review sheet

function reviewSheet() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('REVIEW_SHEET_ID');
  var ss = null;

  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Statement Filer - Review');
    props.setProperty('REVIEW_SHEET_ID', ss.getId());
    var sh = ss.getSheets()[0];
    sh.setName('Not statements');
    sh.getRange(1, 1, 1, 9).setValues([[
      'Never read again?', 'Times read', 'Last seen', 'Mailbox', 'From',
      'Subject', 'Attachment', 'Claude said', 'Pattern'
    ]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(5, 220);
    sh.setColumnWidth(6, 300);
    sh.setColumnWidth(7, 200);
    sh.setColumnWidth(9, 300);
  }
  return ss;
}

function reviewSheetUrl() {
  return reviewSheet().getUrl();
}

function writeReviewSheet(rows) {
  if (!rows || !rows.length) return;
  var sh = reviewSheet().getSheetByName('Not statements');

  var batch = {};
  rows.forEach(function (r) {
    if (!r.fp) return;
    if (batch[r.fp]) {
      batch[r.fp].count++;
      if (r.date > batch[r.fp].date) batch[r.fp].date = r.date;
    } else {
      batch[r.fp] = {
        count: 1, date: r.date, mailbox: r.mailbox, from: r.from,
        subject: r.subject, filename: r.filename, verdict: r.verdict
      };
    }
  });

  var existingRows = {};
  var last = sh.getLastRow();
  if (last >= 2) {
    var pattern = sh.getRange(2, 9, last - 1, 1).getValues();
    for (var i = 0; i < pattern.length; i++) {
      if (pattern[i][0]) existingRows[pattern[i][0]] = i + 2;
    }
  }

  var toAppend = [];
  Object.keys(batch).forEach(function (fp) {
    var b = batch[fp];
    var rowNum = existingRows[fp];
    if (rowNum && rowNum >= 2) {
      var cell = sh.getRange(rowNum, 2);
      cell.setValue((Number(cell.getValue()) || 0) + b.count);
      sh.getRange(rowNum, 3).setValue(b.date);
    } else {
      toAppend.push([false, b.count, b.date, b.mailbox, b.from,
                     b.subject, b.filename, b.verdict, fp]);
    }
  });

  if (toAppend.length) {
    var start = Math.max(sh.getLastRow() + 1, 2);
    sh.getRange(start, 1, toAppend.length, 9).setValues(toAppend);
    sh.getRange(start, 1, toAppend.length, 1).insertCheckboxes();
  }
}

function openReviewSheet() {
  Logger.log('Review sheet:\n' + reviewSheetUrl());
}

// ---------------------------------------------------------------- helpers

function prop(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('Missing script property: ' + key);
  return v;
}

function labelQuery(name) {
  return name.replace(/\//g, '-').toLowerCase();
}

function senderDomain(from) {
  var m = String(from).match(/@([A-Za-z0-9.\-]+)/);
  return m ? m[1].toLowerCase() : null;
}

function senderHandle(from) {
  var domain = senderDomain(from);
  if (!domain) return null;
  if (FREE_EMAIL_DOMAINS.indexOf(domain) === -1 &&
      RELAY_DOMAINS.indexOf(domain) === -1) return domain;
  var m = String(from).match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+/);
  return m ? m[0].toLowerCase() : null;
}

/**
 * A statement period must be a real recent month. Rejects future months
 * and anything implausibly old, both of which have been seen from the
 * model on ambiguous multi-month documents.
 */
function validPeriod(p) {
  if (!/^\d{4}-\d{2}$/.test(p || '')) return false;
  var now = new Date();
  var current = Utilities.formatDate(now, 'Australia/Sydney', 'yyyy-MM');
  if (p > current) return false;
  var oldest = Utilities.formatDate(new Date(now.getTime() - 800 * 86400000),
                                    'Australia/Sydney', 'yyyy-MM');
  if (p < oldest) return false;
  return true;
}

function sanitise(s) {
  return String(s).replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

function daysAgo(n) {
  var d = new Date(Date.now() - n * 86400000);
  return Utilities.formatDate(d, 'Australia/Sydney', 'yyyy/MM/dd');
}

function tomorrow() {
  var d = new Date(Date.now() + 86400000);
  return Utilities.formatDate(d, 'Australia/Sydney', 'yyyy/MM/dd');
}
