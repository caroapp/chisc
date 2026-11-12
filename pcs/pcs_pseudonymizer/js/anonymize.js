/**
 * anonymize.js
 * ============================================================================
 * Pseudonymizes conference submission / review exports, in the browser.
 * Nothing is uploaded anywhere: the CSV files are read locally through
 * FileReader and parsed with d3 (d3.text + d3.csvParseRows).
 *
 * INPUT  (one pair of CSV files per "timestamp" = a stage of the review process.
 *         CHI 2027: T1 = reviews released to authors (round 1),
 *                   T2 = reviews released to authors (round 2))
 *   - a submissions dump   (one row per paper)
 *   - a reviews dump       (one row per review / per reviewer assignment)
 *
 * OUTPUT (download links appended to the page)
 *   1. <T>_pseudonymizedDump.csv        one row per paper, one block of columns per
 *                                       reviewer slot (1AC, 2AC.., E1..): anonymized
 *                                       reviewer ID, scores, review lengths, etc.
 *                                       No free text is exported, only lengths.
 *   2. count_authored_vs_reviewed*.csv  per anonymized person: papers authored,
 *      pcmembers_matrix.csv             papers reviewed, role (PC member / Reviewer),
 *      reviewers_matrix.csv             plus author-vs-reviewer count matrices.
 *
 * EXPECTED PAGE ELEMENTS (ids)
 *   #gobutton, #main, #main_arl, #progressMsg, #progressMsg_arl,
 *   and one #main<T> container per timestamp (#mainT1, #mainT2, ...).
 *   The page must call createScene() once, after load. Needs d3 v5 or later.
 *
 * HOW TO ADAPT IT (everything below is in CONFIG)
 *   - A source column was renamed     -> edit its `from` list (see below).
 *   - Same column, different name across stages/years -> list both names in `from`;
 *                                        the first NON-EMPTY one wins.
 *   - Two columns with the SAME name in the export -> the loader renames the 2nd,
 *                                        3rd... to "<name> [2]", "<name> [3]" and logs
 *                                        a warning; list them all in `from`.
 *   - Collect one more column per reviewer -> add a field to F, then reference it
 *                                        in reviews.slotFields (and firstAcFields).
 *   - Collect one more column per paper    -> add a line to submissions.fields.
 *   - More ACs / more external reviewers   -> raise maxAcSlots / maxExternalSlots.
 *   - New round-2 decision label           -> decisionAcceptRound2.
 *   The output header row is generated from the same lists that read the data,
 *   so a header and its values can no longer drift apart.
 * ============================================================================
 */
(function () {
  "use strict";

  /* ==========================================================================
   * 1. CONFIGURATION
   * ========================================================================== */

  const scoreLabel = "Review Score";

  /*
   * Catalogue of review-form fields collected for each reviewer slot.
   *   header : output column name. "{slot}" is replaced by 1AC, 2AC, E1, ...
   *   from   : candidate source columns, in priority order. The first one that
   *            exists in the CSV is used (handles renames between stages or years).
   *   as     : "length" => export the character count (spaces excluded)
   *            instead of the text itself.
   */
  const F = {
    score:           { header: "{slot} " + scoreLabel,           from: [scoreLabel] },
    // "Review quality" was written "Review Quality" in some exports: both accepted.
    quality:         { header: "{slot} Review Quality",          from: ["Review quality", "Review Quality"] },
    expertise:       { header: "{slot} Expertise",               from: ["Expertise"] },

    // CHI 2027 criteria (replace Originality / Significance / Research Quality of CHI 2026).
    originality:     { header: "{slot} Originality",             from: ["Originality (Round 1)", "Originality"] },
    correctness:     { header: "{slot} Correctness",             from: ["Correctness (Round 1)", "Correctness"] },
    novelty:         { header: "{slot} Novelty",                 from: ["Novelty (Round 1)", "Novelty"] },
    importance:      { header: "{slot} Importance",              from: ["Importance (Round 1)", "Importance"] },
    clarity:         { header: "{slot} Clarity of Exposition",   from: ["Clarity of Exposition (Round 1)", "Clarity of Exposition"] },

    // The CHI27 export has TWO columns named "Recommendation (Round 1)" (the second one
    // is read as "... [2]"). => Caroline has asked the paper chairs for clarifying this
    recommendation:  { header: "{slot} Recommendation",          from: ["Recommendation (Round 1)", "Recommendation (Round 1) [2]", "Recommendation"] },
    reviewLength:    { header: "{slot} Review Length",           from: ["Review (Round 1)", "Review"], as: "length" },
    reReviewLength:  { header: "{slot} re-Review Length",        from: ["Re-review"], as: "length" },

    originality2:    { header: "{slot} Originality (Round 2)",   from: ["Originality (Round 2)"] },
    correctness2:    { header: "{slot} Correctness (Round 2)",   from: ["Correctness (Round 2)"] },
    novelty2:        { header: "{slot} Novelty (Round 2)",       from: ["Novelty (Round 2)"] },
    importance2:     { header: "{slot} Importance (Round 2)",    from: ["Importance (Round 2)"] },
    clarity2:        { header: "{slot} Clarity of Exposition (Round 2)", from: ["Clarity of Exposition (Round 2)"] },
    recommendation2: { header: "{slot} Recommendation (Round 2)",   from: ["Recommendation (Round 2)"] },
  };

  const CONFIG = {
    // Stages of the review process at which you export the data. Each one gets a
    // "Submissions" and a "Reviews" file picker, and the page needs a matching
    // <div id="mainT1"> container. Examples: ["T1"], ["T1","T2"], ["T1",...,"T6"].
    // CHI 2027: T1 = reviews released to authors (round 1), T2 = (round 2).
    timeStamps: ["T1", "T2"],

    // Which timestamp feeds the authored-vs-reviewed counts.
    // Keep T1 (round 1): the RR / RejectRound1 split below relies on the ROUND-1
    // decision labels, which the round-2 export may have replaced by final ones.
    arlTimeStamp: "T1",

    // TODO each year: check the label of the decision "go for round 2" (RR by default).
    decisionAcceptRound2: "RR",

    /* ---------------- Submissions file ---------------- */
    submissions: {
      idCol: "Paper ID",          // also used as the header of the anonymized ID
      statusCol: "Status",        // only rows with this status are used for author counts
      completeValue: "complete",
      decisionCol: "Decision",

      // One output column per entry, in this order (after the anonymized ID).
      fields: [
        { header: "Decision",                         from: ["Decision"] },
        { header: "Overall Score",                    from: ["Overall Score"] },
        // CHI26 only had the "Revised ..." variant of this column; CHI27 has the plain one.
        { header: "PDF page count",                   from: ["Full Text Paper Submission (PDF) pages", "Revised Full Text Paper Submission (PDF) pages"] },
        { header: "Paper length category",            from: ["Paper Length"] },
        { header: "Abstract Length (in char)",        from: ["Submission Abstract", "Abstract"], as: "length" },
        // CHI27: one column replaces the Primary / Secondary subcommittee selections.
        { header: "Subcommittee Assignment",          from: ["subcommittee-assignment"] },
        // Author-chosen keywords, exported as is (for clustering). "Key Words" in CHI26.
        { header: "Keywords",                         from: ["Keywords", "Key Words"] },
      ],
    },

    /* ---------------- Reviews file ---------------- */
    reviews: {
      paperIdCol: "Sub ID",       // NB: differs from submissions.idCol ("Paper ID")
      reviewerIdCol: "Email",
      roleCol: "Role",

      // How the value of roleCol maps to a reviewer slot.
      firstAcRoles: ["AC", "1AC"],  // -> slot 1AC
      otherAcRoles: ["2AC"],        // -> 2AC, 3AC, 4AC... in order of appearance
      externalRoles: ["reviewer"],  // -> E1, E2, ... in order of appearance
      maxAcSlots: 4,                // 1AC..4AC  (reviews beyond that are skipped, with a warning)
      maxExternalSlots: 8,          // E1..E8    (idem)

      // Fields exported for every reviewer slot.
      slotFields: [
        F.score, F.quality, F.expertise,
        F.originality, F.correctness, F.novelty, F.importance, F.clarity,
        F.recommendation, F.reviewLength, F.reReviewLength,
        F.originality2, F.correctness2, F.novelty2, F.importance2, F.clarity2,
        F.recommendation2,
      ],

      // The 1AC exports the same fields, plus the meta-review and the required changes.
      // Headers without "{slot}" are paper-level columns. In CHI27 these columns no
      // longer carry a "1AC: " prefix (CHI26: "1AC: The Meta-Review", ...).
      firstAcFields: [
        // (same list as slotFields, then:)
        "SLOT_FIELDS",
        { header: "The Meta-Review Length",             from: ["The Meta-Review", "1AC: The Meta-Review"], as: "length" },
        { header: "The Meta-Review Length (Round 2)",   from: ["The Meta-Review (Round 2)", "1AC: The Meta-Review (Round 2)"], as: "length" },
        { header: "Required Changes Length",            from: ["Required Changes", "1AC: The Summary of Revisions Required"], as: "length" },
      ],
    },

    /* ---------------- Authored vs reviewed counts ---------------- */
    authoredVsReviewed: {
      // Set to false ONLY for debugging: adds a column with the real e-mail addresses.
      anonymous: true,
      authorEmailCol: "Author {n} - email",
      // The number of "Author n - email" columns is detected from the file itself.
      columns: ["anonymousID", "CountAuthored", "CountReviewed", "Role"],
      pcRoleIncludes: "AC",                  // role containing this => "PC member"
      labels: { pc: "PC member", reviewer: "Reviewer", none: "none" },
    },
  };

  // Expand the "SLOT_FIELDS" placeholder of firstAcFields into the slotFields list.
  CONFIG.reviews.firstAcFields = CONFIG.reviews.firstAcFields.reduce(
    (acc, f) => acc.concat(f === "SLOT_FIELDS" ? CONFIG.reviews.slotFields : [f]), []);

  const S = CONFIG.submissions;
  const R = CONFIG.reviews;
  const A = CONFIG.authoredVsReviewed;

  /* ==========================================================================
   * 2. GENERIC HELPERS
   * ========================================================================== */

  /** Fisher-Yates shuffle, in place (from https://stackoverflow.com/questions/6274339). */
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const x = a[i];
      a[i] = a[j];
      a[j] = x;
    }
    return a;
  }

  /**
   * Builds a random, one-to-one pseudonym for each distinct value.
   * @returns {Map} real value -> "anon<k>" (k is a random permutation of 0..n-1)
   */
  function makeAnonymizer(values) {
    const unique = Array.from(new Set(values));
    const labels = shuffle(unique.map((_, i) => "anon" + i));
    return new Map(unique.map((v, i) => [v, labels[i]]));
  }

  /** Number of characters, spaces excluded (newlines and tabs still count). */
  function countChars(str) {
    if (str == null) return 0;
    return str.replace(/ /g, "").length;
  }

  /** Trimmed string; "" for a missing value (avoids "undefined.trim()" crashes). */
  function trimmed(v) {
    return v == null ? "" : String(v).trim();
  }

  /** Reads one configured field from a CSV row (see F for the field format). */
  function readField(row, field) {
    // First NON-EMPTY candidate wins; if all existing candidates are empty, the first one.
    let raw;
    for (const c of field.from) {
      if (!Object.prototype.hasOwnProperty.call(row, c)) continue;
      if (raw === undefined) raw = row[c];
      if (trimmed(row[c]) !== "") { raw = row[c]; break; }
    }
    return field.as === "length" ? countChars(raw) : raw;
  }

  /**
   * Makes header names unique: the 2nd, 3rd... column called "X" become "X [2]", "X [3]".
   * (d3.csv would silently keep only the LAST of several identically named columns.)
   */
  const warnedDuplicates = new Set();   // warn once per column name, not once per file
  function uniqueHeader(header) {
    const seen = new Map();
    const renamed = [];
    const out = header.map(h => {
      const n = (seen.get(h) || 0) + 1;
      seen.set(h, n);
      if (n === 1) return h;
      renamed.push(h);
      return h + " [" + n + "]";
    });
    const fresh = Array.from(new Set(renamed)).filter(h => !warnedDuplicates.has(h));
    if (fresh.length) {
      fresh.forEach(h => warnedDuplicates.add(h));
      console.warn("Duplicate column names, renamed with a suffix: " + fresh.map(h => "'" + h + "'").join(", "));
    }
    return out;
  }

  /** Loads a CSV (URL or data URL) as an array of {column: value} objects, like d3.csv. */
  function loadCsv(url) {
    return d3.text(url).then(text => {
      const rows = d3.csvParseRows(text.replace(/^\uFEFF/, ""));   // also drops a BOM
      const header = uniqueHeader(rows.shift() || []);
      return rows.map(r => {
        const o = {};
        header.forEach((h, i) => { o[h] = r[i] === undefined ? "" : r[i]; });
        return o;
      });
    });
  }

  /** "Author {n} - email" columns present in the file, ordered by n. */
  function detectAuthorCols(rows) {
    if (rows.length === 0) return [];
    const esc = A.authorEmailCol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{n\\}", "(\\d+)");
    const pattern = new RegExp("^" + esc + "$");
    const byNumber = new Map();
    Object.keys(rows[0]).forEach(k => { const m = pattern.exec(k); if (m) byNumber.set(+m[1], k); });
    return Array.from(byNumber.keys()).sort((a, b) => a - b).map(n => byNumber.get(n));
  }

  /** "{slot} Foo" -> "2AC Foo" */
  function headerFor(field, slot) {
    return field.header.replace("{slot}", slot);
  }

  /** RFC 4180 cell: quoted when it contains a comma, a quote or a line break. */
  function csvCell(v) {
    if (v == null) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** header: array of names; rows: array of arrays. */
  function toCsv(header, rows) {
    return [header].concat(rows)
      .map(r => r.map(csvCell).join(","))
      .join("\r\n") + "\r\n";
  }

  /** Appends a download link for `csv` inside the element matching `containerSel`. */
  function addDownloadLink(containerSel, filename, csv) {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    d3.select(containerSel)
      .append("div").classed("dump-item", true)
      .append("a")
      .classed("dump", true)
      .attr("href", url)
      .attr("download", filename)
      .text(filename);
  }

  function setProgress(sel, msg) {
    d3.select(sel).text(msg);
  }

  /* ==========================================================================
   * 3. PSEUDONYMIZED PAPER DUMP (one CSV per timestamp)
   * ========================================================================== */

  /** Reviewer slots in output order: 1AC, 2AC.., E1.. */
  function buildSlots() {
    const slots = ["1AC"];
    for (let n = 2; n <= R.maxAcSlots; n++) slots.push(n + "AC");
    for (let n = 1; n <= R.maxExternalSlots; n++) slots.push("E" + n);
    return slots;
  }

  function fieldsForSlot(slot) {
    return slot === "1AC" ? R.firstAcFields : R.slotFields;
  }

  /** Full header row, derived from the config. */
  function buildColumns(slots) {
    const cols = [S.idCol].concat(S.fields.map(f => f.header));
    slots.forEach(slot => {
      cols.push(slot);
      fieldsForSlot(slot).forEach(f => cols.push(headerFor(f, slot)));
    });
    return cols;
  }

  /**
   * Decides which slot a review goes to. 2AC-type and external reviewers are
   * numbered in order of appearance for the paper, hence the counters.
   * @returns {string|null} null when the role is not recognized
   */
  function assignSlot(role, paper) {
    if (R.firstAcRoles.includes(role)) return "1AC";
    if (R.otherAcRoles.includes(role)) return (paper.nextAc++) + "AC";
    if (R.externalRoles.includes(role)) return "E" + paper.nextExternal++;
    return null;
  }

  /**
   * Builds one pseudonymized CSV per timestamp.
   * @param {string[]} stamps            timestamps to process
   * @param {Object}   loaded            { T: { subs: rows[], revs: rows[] } }
   * @returns {{files: Object, notes: Object}} CSV text and warnings per timestamp
   */
  function buildPaperDumps(stamps, loaded) {
    // Pseudonyms are shared across timestamps: the same paper ID or the same
    // reviewer e-mail gets the same pseudonym in every file of a run.
    const allSubs = stamps.flatMap(t => loaded[t].subs);
    const allRevs = stamps.flatMap(t => loaded[t].revs);
    const paperAnon = makeAnonymizer(allSubs.map(r => r[S.idCol]));
    const reviewerAnon = makeAnonymizer(allRevs.map(r => r[R.reviewerIdCol]));

    const slots = buildSlots();
    const knownSlots = new Set(slots);
    const columns = buildColumns(slots);

    const files = {};
    const notes = {};

    stamps.forEach(t => {
      const papers = new Map(); // anonymized paper ID -> { row, nextAc, nextExternal }
      const skipped = { unknownPaper: 0, noSlot: 0 };

      // --- paper-level info from the submissions dump
      loaded[t].subs.forEach(subRow => {
        const anonId = paperAnon.get(subRow[S.idCol]);
        const row = { [S.idCol]: anonId };
        S.fields.forEach(f => { row[f.header] = readField(subRow, f); });
        papers.set(anonId, { row, nextAc: 2, nextExternal: 1 });
      });

      // --- reviewer-level info from the reviews dump
      loaded[t].revs.forEach(revRow => {
        const paper = papers.get(paperAnon.get(revRow[R.paperIdCol]));
        if (!paper) { skipped.unknownPaper++; return; } // review of a paper absent from this timestamp's submissions

        const slot = assignSlot(revRow[R.roleCol], paper);
        if (slot === null) return;                       // unrecognized role: ignored, as before
        if (!knownSlots.has(slot)) { skipped.noSlot++; return; }

        paper.row[slot] = reviewerAnon.get(revRow[R.reviewerIdCol]);
        fieldsForSlot(slot).forEach(f => { paper.row[headerFor(f, slot)] = readField(revRow, f); });
      });

      const rows = Array.from(papers.values()).map(p => columns.map(c => p.row[c]));
      files[t] = toCsv(columns, rows);
      notes[t] = skipped;
    });

    return { files, notes };
  }

  /* ==========================================================================
   * 4. AUTHORED vs REVIEWED COUNTS
   *    Uses its own, independent pseudonyms (authors and reviewers together),
   *    so this output cannot be linked to the paper dump by ID.
   * ========================================================================== */

  /** Count matrix as CSV: rows = #authored, columns = #reviewed, cells = #people. */
  function buildMatrixCsv(counts, maxAuthored, maxReviewed) {
    const header = ["|Authored|vs_Reviewed_"];
    for (let j = 0; j <= maxReviewed; j++) header.push(j);
    const rows = [];
    for (let i = 0; i <= maxAuthored; i++) {
      const row = [i];
      for (let j = 0; j <= maxReviewed; j++) row.push(counts[i + "_" + j] || 0);
      rows.push(row);
    }
    return toCsv(header, rows);
  }

  /**
   * @returns {{filename: string, csv: string}[]} in the order they should be listed
   */
  function buildAuthoredVsReviewed(subsRows, revsRows) {
    const authorCols = detectAuthorCols(subsRows);
    if (authorCols.length === 0) console.warn("No '" + A.authorEmailCol + "' column found in the submissions file.");

    const completeSubs = subsRows.filter(s => s[S.statusCol] === S.completeValue);

    // --- 1. everybody (authors of complete submissions + anyone with a review)
    const emails = [];
    completeSubs.forEach(sub => {
      authorCols.forEach(col => { const e = trimmed(sub[col]); if (e !== "") emails.push(e); });
    });
    revsRows.forEach(rev => {
      const e = trimmed(rev[R.reviewerIdCol]);  // empty for unassigned (incomplete) reviews
      if (e !== "") emails.push(e);
    });
    const anon = makeAnonymizer(emails);

    // --- 2. reviewed count + role. Independent of the decision, so computed once.
    //     The role is the one seen on the person's FIRST review (input order matters).
    const reviewed = new Map();
    const role = new Map();
    anon.forEach(id => { reviewed.set(id, 0); role.set(id, A.labels.none); });
    revsRows.forEach(rev => {
      const e = trimmed(rev[R.reviewerIdCol]);
      if (e === "") return;
      const id = anon.get(e);
      reviewed.set(id, reviewed.get(id) + 1);
      if (role.get(id) === A.labels.none) {
        role.set(id, trimmed(rev[R.roleCol]).includes(A.pcRoleIncludes) ? A.labels.pc : A.labels.reviewer);
      }
    });

    // --- 3. one output per decision filter (only authored counts depend on it)
    const acc = CONFIG.decisionAcceptRound2;
    const variants = [
      { suffix: "",             keep: () => true,      withMatrices: true }, // all decisions
      { suffix: "RejectRound1", keep: d => d !== acc },                      // X1 and DR
      { suffix: acc,            keep: d => d === acc },                      // RR
    ];

    const outputs = [];
    variants.forEach(v => {
      const authored = new Map();
      anon.forEach(id => authored.set(id, 0));
      completeSubs.filter(sub => v.keep(sub[S.decisionCol])).forEach(sub => {
        authorCols.forEach(col => {
          const e = trimmed(sub[col]);
          if (e !== "") { const id = anon.get(e); authored.set(id, authored.get(id) + 1); }
        });
      });

      const header = (A.anonymous ? [] : ["email"]).concat(A.columns);
      const rows = [];
      const pcCounts = {}, regCounts = {};
      let maxAuthPC = 0, maxRevPC = 0, maxAuthReg = 0, maxRevReg = 0;

      anon.forEach((id, email) => {
        rows.push((A.anonymous ? [] : [email]).concat([id, authored.get(id), reviewed.get(id), role.get(id)]));

        // Note: people who never reviewed (role "none") land in the "regular" matrix.
        const isPC = role.get(id) === A.labels.pc;
        const counts = isPC ? pcCounts : regCounts;
        const key = authored.get(id) + "_" + reviewed.get(id);
        counts[key] = (counts[key] || 0) + 1;
        if (isPC) {
          maxAuthPC = Math.max(maxAuthPC, authored.get(id));
          maxRevPC = Math.max(maxRevPC, reviewed.get(id));
        } else {
          maxAuthReg = Math.max(maxAuthReg, authored.get(id));
          maxRevReg = Math.max(maxRevReg, reviewed.get(id));
        }
      });

      outputs.push({ filename: "count_authored_vs_reviewed" + v.suffix + ".csv", csv: toCsv(header, rows) });
      if (v.withMatrices) {
        outputs.push({ filename: "pcmembers_matrix.csv",  csv: buildMatrixCsv(pcCounts, maxAuthPC, maxRevPC) });
        outputs.push({ filename: "reviewers_matrix.csv", csv: buildMatrixCsv(regCounts, maxAuthReg, maxRevReg) });
      }
    });
    return outputs;
  }

  /* ==========================================================================
   * 5. PAGE / UI
   * ========================================================================== */

  // Loaded files (as data URLs), per timestamp: { T1: { subs, revs }, ... }
  const files = {};

  function loadCsvPair(t) {
    return Promise.all([loadCsv(files[t].subs), loadCsv(files[t].revs)])
      .then(([subs, revs]) => ({ subs, revs }));
  }

  function runPaperDumps(stamps) {
    setProgress("#progressMsg", "in progress...");
    return Promise.all(stamps.map(loadCsvPair)).then(pairs => {
      const loaded = {};
      stamps.forEach((t, i) => { loaded[t] = pairs[i]; });

      const result = buildPaperDumps(stamps, loaded);
      stamps.forEach(t => {
        addDownloadLink("#main", t + "_pseudonymizedDump.csv", result.files[t]);

        const n = result.notes[t];
        const msgs = [];
        if (n.unknownPaper) msgs.push(n.unknownPaper + " review(s) skipped: paper not found in the submissions file");
        if (n.noSlot) msgs.push(n.noSlot + " review(s) skipped: more reviewers than slots (raise maxAcSlots / maxExternalSlots)");
        if (msgs.length) {
          console.warn(t + ": " + msgs.join("; "));
          setProgress("#progressMsg" + t, msgs.join("; "));
        }
      });
      setProgress("#progressMsg", "Done.");
    }).catch(err => {
      console.error(err);
      setProgress("#progressMsg", "Error, see the console.");
    });
  }

  function runAuthoredVsReviewed() {
    const t = CONFIG.arlTimeStamp;
    if (!files[t] || !files[t].subs || !files[t].revs) {
      setProgress("#progressMsg_arl", "Skipped: load both files for " + t + ".");
      return Promise.resolve();
    }
    setProgress("#progressMsg_arl", "in progress...");
    return loadCsvPair(t).then(({ subs, revs }) => {
      buildAuthoredVsReviewed(subs, revs).forEach(o => addDownloadLink("#main_arl", o.filename, o.csv));
      setProgress("#progressMsg_arl", "Done.");
    }).catch(err => {
      console.error(err);
      setProgress("#progressMsg_arl", "Error, see the console.");
    });
  }

  function go() {
    const stamps = CONFIG.timeStamps.filter(t => files[t].subs && files[t].revs);
    // Remove links from a previous run: each run uses NEW random pseudonyms,
    // so files from two different runs must not end up side by side.
    d3.selectAll(".dump-item").remove();

    if (stamps.length === 0) {
      setProgress("#progressMsg", "Load both files (submissions + reviews) for at least one timestamp.");
    } else {
      runPaperDumps(stamps);
    }
    runAuthoredVsReviewed();
  }

  /** Adds a label + a CSV file picker inside `div`; calls onLoaded(dataUrl) on selection. */
  function addFilePicker(div, label, onLoaded) {
    div.append("span").classed("textEl", true).text(label);
    div.append("input")
      .attr("type", "file")
      .attr("accept", ".csv")
      .on("change", function () {
        const file = this.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onloadend = evt => onLoaded(evt.target.result); // (reading a data URL fails in IE)
        reader.readAsDataURL(file);
      });
  }

  function populateDiv(t) {
    files[t] = { subs: null, revs: null };
    const div = d3.select("#main" + t);
    addFilePicker(div, "Submissions:", dataUrl => { files[t].subs = dataUrl; });
    addFilePicker(div, "Reviews:",      dataUrl => { files[t].revs = dataUrl; });
    div.append("span").attr("id", "progressMsg" + t).classed("textEl", true);
  }

  /** Entry point: to be called by the page once it is loaded. */
  function createScene() {
    CONFIG.timeStamps.forEach(populateDiv);
    document.getElementById("gobutton").addEventListener("click", go);
  }

  window.createScene = createScene;
})();
