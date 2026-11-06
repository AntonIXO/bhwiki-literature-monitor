import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEuropePmcQuery,
  canonicalPaperId,
  deduplicatePapers,
  extractQuotedEvidence,
  manifestSourceRecord,
  matchWatchTerms,
  parseEuropePmcResult,
  renderProposal,
  type LiteraturePaper,
} from "./model.js";

const paper = (overrides: Partial<LiteraturePaper> = {}): LiteraturePaper => ({
  id: "pmid:1",
  title: "Caffeine and sleep",
  abstract: "Caffeine reduced total sleep time by 20 minutes in 24 adults.",
  url: "https://pubmed.ncbi.nlm.nih.gov/1/",
  doi: "10.1000/example",
  pmid: "1",
  pmcid: null,
  publishedOn: "2026-10-20",
  journal: "Journal",
  authors: ["A"],
  matchedSubstances: ["caffeine"],
  matchedTerms: ["caffeine", "sleep"],
  raw: {},
  ...overrides,
});

test("builds a bounded fielded query with a canonical substance", () => {
  const query = buildEuropePmcQuery({ slug: "caffeine", name: "Caffeine", aliases: ["1,3,7-trimethylxanthine"], tags: ["sleep"] }, "2026-10-15");
  assert.match(query, /TITLE_ABS:/);
  assert.match(query, /caffeine/);
  assert.match(query, /FIRST_PDATE:\[2026-10-15 TO \*\]/);
  assert.ok(query.length < 900);
});

test("deduplicates PMID and DOI aliases into one richer paper", () => {
  const result = deduplicatePapers([paper(), paper({ id: "doi:10.1000/example", pmid: null, abstract: "Caffeine reduced total sleep time by 20 minutes in 24 adults, with the effect persisting through the following morning assessment and requiring full-text review." })]);
  assert.equal(result.length, 1);
  assert.equal(canonicalPaperId(result[0]), "pmid:1");
  assert.match(result[0].abstract, /persisting/);
});

test("only retains contiguous verbatim evidence", () => {
  const abstract = paper().abstract;
  assert.deepEqual(extractQuotedEvidence(["Caffeine reduced total sleep time by 20 minutes"], abstract), ["Caffeine reduced total sleep time by 20 minutes"]);
  assert.deepEqual(extractQuotedEvidence(["Caffeine improved cognition"], abstract), []);
});

test("renders a review proposal and never an article mutation", () => {
  const output = renderProposal({
    id: "pmid:1",
    paper: paper(),
    substanceSlug: "caffeine",
    suggestionType: "new-outcome",
    payload: { outcome: "total sleep time", direction: "harm" },
    rationale: "The abstract reports a measurable sleep outcome.",
    evidenceQuotes: ["Caffeine reduced total sleep time by 20 minutes"],
  });
  assert.match(output, /editorial proposal/);
  assert.match(output, /Human review/);
  assert.match(output, /Caffeine reduced total sleep time by 20 minutes/);
  assert.match(output, /total sleep time/);
  assert.doesNotMatch(output, /content\/substances/);
});

test("manifest source record keeps review fields and drops author contact data", () => {
  const review = {
    pmid: "42880479",
    doi: "10.1016/j.fct.2026.116460",
    authorString: "Santillo MF, Sprando RL, Yourick JJ.",
    abstractText: "Methylliberine and theacrine were profiled.",
    publicationStatus: "aheadofprint",
    pubTypeList: { pubType: ["Journal Article"] },
    grantsList: { grant: [{ agency: "US Food and Drug Administration", orderIn: 0 }] },
  };
  const record = manifestSourceRecord({
    ...review,
    affiliation: "Division of Toxicology, FDA. Electronic address: michael.santillo@fda.hhs.gov.",
    authorList: { author: [{ fullName: "Santillo MF", authorAffiliationDetailsList: { authorAffiliation: [{ affiliation: "FDA. Electronic address: michael.santillo@fda.hhs.gov." }] } }] },
    authorIdList: { authorId: [{ type: "ORCID", value: "0000-0002-1825-0097" }] },
    investigatorList: { investigator: [{ fullName: "Doe J" }] },
  });
  assert.deepEqual(record, review);
});

test("parses a Europe PMC core record's journal and author names", () => {
  const parsed = parseEuropePmcResult(
    {
      pmid: "42880479",
      title: "Evaluating the biological effects of caffeine-related compounds methylliberine and theacrine.",
      authorString: "Santillo MF, Sprando RL, Yourick JJ.",
      journalInfo: {
        journal: {
          title: "Food and chemical toxicology : an international journal published for the British Industrial Biological Research Association",
          medlineAbbreviation: "Food Chem Toxicol",
          isoabbreviation: "Food Chem Toxicol",
        },
      },
      abstractText: "Methylliberine and theacrine were profiled.",
      firstPublicationDate: "2026-10-15",
    },
    { slug: "caffeine", name: "Caffeine", aliases: [], tags: [] },
    ["Caffeine"],
  );
  assert.equal(parsed.journal, "Food Chem Toxicol");
  assert.deepEqual(parsed.authors, ["Santillo MF", "Sprando RL", "Yourick JJ"]);
});

test("matches watch terms once regardless of casing", () => {
  const terms = matchWatchTerms(
    { slug: "caffeine", name: "Caffeine", aliases: ["CYP1A2"], tags: ["stimulant", "Stimulant", "cyp1a2", "CYP1A2"] },
    { title: "Caffeine as a stimulant", abstractText: "CYP1A2 metabolises caffeine." },
  );
  assert.deepEqual(terms, ["Caffeine", "CYP1A2", "stimulant"]);
});

test("merging duplicate papers keeps one matched term per case-insensitive value", () => {
  const result = deduplicatePapers([paper({ matchedTerms: ["Caffeine"] }), paper({ id: "doi:10.1000/example", pmid: null, matchedTerms: ["caffeine", "sleep"] })]);
  assert.deepEqual(result[0].matchedTerms, ["Caffeine", "sleep"]);
});
