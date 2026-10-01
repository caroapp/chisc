# Repository for CHI SC data tools

## Repo structure

```
.
├── pcs                          # PCS anonymizer
├── ...
```

## 1. PCS anonymizer

A small browser tool that pseudonymizes PCS (Precision Conference System)
submission and review exports, so that data can be
shared or analyzed without compromizing anonymity.

Everything runs **locally in client's browser**. The CSV files loaded in pcsanonymizer 
load are never uploaded anywhere, and the real-to-pseudonym mapping is never saved.

### What it does

Chairs (paper chairs or TPCs) export two CSV files from PCS at one or more stages of the review
process (for example, for CHI '26: reviews released to authors round 1, the day before
the PC meeting, reviews released to authors round 2) and load them into the
page. It then produces:

1. **A pseudonymized submissions+reviews table**, one per stage: one row per
   paper, with anonymized reviewer IDs, scores, etc.
2. **An authored-vs-reviewed load analysis**: for each anonymized person, how
   many papers they authored vs. reviewed, their role (PC member / Reviewer),
   and two count matrices (PC members, regular reviewers).

Paper IDs and reviewer e-mails are replaced with random `anonN` labels. The
two outputs above use **independent** pseudonyms, so the load-analysis file
cannot be linked back to the per-paper dump.

### Usage

1. Clone or download this repo.
2. Open `index.html` directly in your browser (double-click it, or
   `open index.html` / `start index.html`).
3. For each stage you have data for, load the matching **Submissions** and
   **Reviews** CSV export from PCS. A stage with only one of the two files is
   skipped.
4. Click **Anonymize**.
5. Download the generated files. Every click of **Anonymize** draws new
   random pseudonyms, so use the files from a single run together.

### Test data

This repo includes synthetic CSV files
(`chi26c_submission_synthetic.csv`, `chi26c_reviews_synthetic.csv`) with
realistic but entirely fake data: 500 papers, 2,500 reviews, fake names and
`@example.org` emails. Column headers for these synthetic datasets come from
the PCS configuration for CHI '26.

## Repo structure

```
.
├── pcs_pseudonymizer/
│   ├── index.html                      # all the processing logic + its configuration
│   └── js/
│       ├── anonymize.js                    # all the processing logic + its configuration
│       └── d3.v5.min.js                    # d3 v5, used to parse the CSVs
├── synthetic_data/
│   ├── chi26c_submission_synthetic.csv     # synthetic test data (submissions)
│   └── chi26c_reviews_synthetic.csv        # synthetic test data (reviews)
```

### Adapting it to a different PCS export

Column names in PCS exports change slightly from year to year, and you may
want to collect extra columns. Everything configurable lives at the top of
`js/anonymize.js`, in a single `CONFIG` object — there's no need to touch the
processing logic itself.

- **A column was renamed:** edit its `from` list.
- **Same column, different name in different years:** list both names in
  `from`; the first one found in the file is used.
- **Collect one more field per reviewer:** add an entry to the `F` field
  catalogue, then reference it in `reviews.slotFields` (and
  `firstAcFields` if it should also apply to the 1AC).
- **Collect one more field per paper:** add a line to `submissions.fields`.
- **More ACs or more external reviewers per paper:** raise `maxAcSlots` /
  `maxExternalSlots`.
- **A different label for "accepted to round 2":** edit
  `decisionAcceptRound2`.
- **A different stage set:** edit `timeStamps`, and add or remove a matching
  `<div id="mainT…">` card in `index.html`.

### Anomymity

- All processing happens client-side; nothing is sent over the network.
- Pseudonyms are regenerated (randomly) on every run and are not persisted
  anywhere — there is no way to recover who `anon17` was after the fact
  unless you kept the original files.
- Review and meta-review text are never exported, only their lengths.

