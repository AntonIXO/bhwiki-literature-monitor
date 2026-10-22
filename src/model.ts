import { createHash } from "node:crypto";

export type WatchTarget = { slug: string; name: string; aliases: string[]; tags: string[] };
export type LiteraturePaper = {
  id: string;
  title: string;
  abstract: string;
  url: string;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  publishedOn: string | null;
  journal: string | null;
  authors: string[];
  matchedSubstances: string[];
  matchedTerms: string[];
  raw: Record<string, unknown>;
};
export type SuggestionType = "new-reference" | "new-outcome" | "new-effect" | "new-claim" | "new-caution" | "ignore";

const compact = (value: string) => value.replace(/\s+/g, " ").trim();
const unique = (values: string[]) => [...new Set(values.map(compact).filter((v) => v.length >= 2))];
const quoted = (value: string) => `"${compact(value).toLowerCase().replaceAll('"', '\\"')}"`;

export function buildEuropePmcQuery(target: WatchTarget, since: string): string {
  const names = unique([target.name, ...target.aliases]).map(quoted).join(" OR ");
  const tags = unique(target.tags).map(quoted).join(" OR ");
  return `TITLE_ABS:(${names})${tags ? ` AND TITLE_ABS:(${tags})` : ""} AND FIRST_PDATE:[${since} TO *]`;
}

export function canonicalPaperId(paper: Pick<LiteraturePaper, "pmid" | "doi" | "title" | "publishedOn">): string {
  if (paper.pmid?.trim()) return `pmid:${paper.pmid.trim()}`;
  if (paper.doi?.trim()) return `doi:${paper.doi.trim().toLowerCase()}`;
  const basis = `${compact(paper.title).toLowerCase()}|${paper.publishedOn ?? ""}`;
  return `title:${createHash("sha256").update(basis).digest("hex").slice(0, 24)}`;
}

function identityKeys(paper: LiteraturePaper): string[] {
  return [...new Set([
    paper.pmid?.trim() ? `pmid:${paper.pmid.trim()}` : "",
    paper.doi?.trim() ? `doi:${paper.doi.trim().toLowerCase()}` : "",
    canonicalPaperId(paper),
  ].filter(Boolean))];
}

export function deduplicatePapers(papers: LiteraturePaper[]): LiteraturePaper[] {
  const index = new Map<string, LiteraturePaper>();
  for (const paper of papers) {
    const existingKey = identityKeys(paper).find((key) => index.has(key));
    const current = existingKey ? index.get(existingKey)! : undefined;
    const merged: LiteraturePaper = current ? {
      ...current,
      abstract: paper.abstract.length > current.abstract.length ? paper.abstract : current.abstract,
      doi: current.doi ?? paper.doi,
      pmid: current.pmid ?? paper.pmid,
      pmcid: current.pmcid ?? paper.pmcid,
      authors: [...new Set([...current.authors, ...paper.authors])],
      matchedSubstances: [...new Set([...current.matchedSubstances, ...paper.matchedSubstances])],
      matchedTerms: [...new Set([...current.matchedTerms, ...paper.matchedTerms])],
      raw: { ...current.raw, ...paper.raw },
    } : { ...paper, id: canonicalPaperId(paper) };
    for (const key of [...identityKeys(paper), ...identityKeys(merged)]) index.set(key, merged);
  }
  return [...new Set(index.values())].sort((a, b) => (b.publishedOn ?? "").localeCompare(a.publishedOn ?? ""));
}

export function extractQuotedEvidence(quotes: string[], abstract: string): string[] {
  const source = compact(abstract).toLocaleLowerCase();
  return [...new Set(quotes.map(compact).filter((quote) => quote.length >= 12 && source.includes(quote.toLocaleLowerCase())))];
}

export function renderProposal(input: {
  id: string;
  paper: LiteraturePaper;
  substanceSlug: string;
  suggestionType: SuggestionType;
  payload: Record<string, unknown>;
  rationale: string;
  evidenceQuotes: string[];
}): string {
  const quoteBlock = input.evidenceQuotes.length ? input.evidenceQuotes.map((q) => `> ${q}`).join("\n") : "> No abstract quote retained; full-text inspection is required.";
  return [
    "# Automated editorial proposal",
    "",
    `- Proposal ID: ${input.id}`,
    `- Substance: ${input.substanceSlug}`,
    `- Suggestion type: ${input.suggestionType}`,
    `- Source: [${input.paper.title}](${input.paper.url})`,
    `- PMID: ${input.paper.pmid ?? "not indexed"}`,
    `- DOI: ${input.paper.doi ?? "not indexed"}`,
    `- Published: ${input.paper.publishedOn ?? "not stated"}`,
    `- Journal: ${input.paper.journal ?? "not stated"}`,
    "",
    "This file is a review proposal. It is not a published BHWiki article and must not be treated as medical guidance.",
    "",
    "## Proposed structured change",
    "",
    "```json",
    JSON.stringify(input.payload, null, 2),
    "```",
    "",
    "## Model rationale",
    "",
    input.rationale,
    "",
    "## Verbatim evidence from the abstract",
    "",
    quoteBlock,
    "",
    "## Human review",
    "",
    "- [ ] Open the canonical publication and inspect the strongest permitted full text.",
    "- [ ] Verify article version, retraction/correction state, population, exposure, comparator, outcome and limitations.",
    "- [ ] Verify funding/conflict and reuse rights; remove any unsupported field.",
    "- [ ] Apply changes manually to the appropriate Markdown source; do not edit this proposal into public content.",
    "- [ ] Run `bun run content:validate`, `bun run test`, and the normal publisher before merging.",
    "",
  ].join("\n");
}

export function parseEuropePmcResult(result: Record<string, unknown>, target: WatchTarget, matchedTerms: string[]): LiteraturePaper {
  const pmid = typeof result.pmid === "string" ? result.pmid : null;
  const doi = typeof result.doi === "string" ? result.doi : null;
  const pmcid = typeof result.pmcid === "string" ? result.pmcid : null;
  const paper: LiteraturePaper = {
    id: "pending",
    title: compact(String(result.title ?? "Untitled publication")),
    abstract: compact(String(result.abstractText ?? result.abstract ?? "")),
    url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : doi ? `https://doi.org/${doi}` : "https://europepmc.org/",
    doi,
    pmid,
    pmcid,
    publishedOn: typeof result.firstPublicationDate === "string" ? result.firstPublicationDate : null,
    journal: typeof result.journalTitle === "string" ? result.journalTitle : null,
    authors: typeof result.authorString === "string" ? result.authorString.split(",").map(compact).filter(Boolean) : [],
    matchedSubstances: [target.slug],
    matchedTerms,
    raw: result,
  };
  paper.id = canonicalPaperId(paper);
  return paper;
}
