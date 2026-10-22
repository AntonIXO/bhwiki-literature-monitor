import matter from "gray-matter";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  buildEuropePmcQuery,
  canonicalPaperId,
  deduplicatePapers,
  extractQuotedEvidence,
  parseEuropePmcResult,
  renderProposal,
  type LiteraturePaper,
  type SuggestionType,
  type WatchTarget,
} from "./model.js";

const exec = promisify(execFile);
const root = path.resolve(process.env.BHWIKI_MONITOR_HOME ?? "/var/lib/bhwiki-literature-monitor");
const repoDir = path.resolve(process.env.BHWIKI_REPO_DIR ?? path.join(root, "BHWiki"));
const repoUrl = process.env.BHWIKI_REPO_URL ?? "https://github.com/AntonIXO/BHWiki.git";
const githubRepo = process.env.BHWIKI_GITHUB_REPO ?? "AntonIXO/BHWiki";
const baseBranch = process.env.BHWIKI_BASE_BRANCH ?? "main";
const lockDir = path.join(root, "run.lock");
const runId = `auto-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const args = new Set(process.argv.slice(2));
const arg = (name: string, fallback?: string) => process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const since = arg("since", new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10))!;
const perQuery = Number(arg("limit", "10"));
const maxSubstances = Number(arg("max-substances", "0"));
const onlySlug = arg("slug");
const dryRun = args.has("--dry-run");
const noLlm = args.has("--no-llm");
const llmBaseUrl = (process.env.BHWIKI_LLM_BASE_URL ?? "").replace(/\/$/, "");
const llmApiKey = process.env.BHWIKI_LLM_API_KEY;
const llmModel = process.env.BHWIKI_LLM_MODEL ?? "configured-model";
const validTypes = new Set<SuggestionType>(["new-reference", "new-outcome", "new-effect", "new-claim", "new-caution", "ignore"]);

if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("--since must be YYYY-MM-DD");
if (!Number.isInteger(perQuery) || perQuery < 1 || perQuery > 100) throw new Error("--limit must be 1..100");
if (!Number.isInteger(maxSubstances) || maxSubstances < 0) throw new Error("--max-substances must be non-negative");
if (!noLlm && !llmBaseUrl) throw new Error("BHWIKI_LLM_BASE_URL is required unless --no-llm is explicit");

async function shell(command: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function acquireLock(): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true });
  try {
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, "owner"), `${process.pid} ${new Date().toISOString()}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Monitor lock exists: ${lockDir}`);
    throw error;
  }
  return async () => rm(lockDir, { recursive: true, force: true });
}

async function prepareRepo(): Promise<void> {
  if (!existsSync(path.join(repoDir, ".git"))) {
    await mkdir(path.dirname(repoDir), { recursive: true });
    await shell("git", ["clone", "--depth", "1", "--branch", baseBranch, repoUrl, repoDir]);
    return;
  }
  const dirty = await shell("git", ["status", "--porcelain"], repoDir);
  if (dirty) throw new Error(`BHWiki clone is dirty; refusing to reset it: ${repoDir}`);
  await shell("git", ["fetch", "origin", baseBranch], repoDir);
  await shell("git", ["checkout", "-B", baseBranch, `origin/${baseBranch}`], repoDir);
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

async function readWatchTargets(): Promise<WatchTarget[]> {
  const conceptFiles = await markdownFiles(path.join(repoDir, "content", "concepts"));
  const labels = new Map<string, string>();
  for (const file of conceptFiles) {
    const data = matter(await readFile(file, "utf8")).data as Record<string, unknown>;
    const slug = typeof data.slug === "string" ? data.slug : path.basename(file, ".md");
    const label = typeof data.name === "string" ? data.name : typeof data.label === "string" ? data.label : slug;
    labels.set(slug, label);
  }
  const directory = path.join(repoDir, "content", "substances");
  const files = (await readdir(directory)).filter((f) => f.endsWith(".md")).sort();
  const targets: WatchTarget[] = [];
  for (const file of files) {
    const source = await readFile(path.join(directory, file), "utf8");
    const frontmatter = matter(source).data as Record<string, unknown>;
    const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
    if (!name) continue;
    const aliases = Array.isArray(frontmatter.aliases) ? frontmatter.aliases.map(String) : [];
    const rawTags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [];
    const tags = rawTags.flatMap((tag) => [tag, labels.get(tag) ?? ""]);
    targets.push({ slug: String(frontmatter.slug ?? file.slice(0, -3)), name, aliases, tags });
  }
  const selected = onlySlug ? targets.filter((target) => target.slug === onlySlug) : targets;
  return maxSubstances ? selected.slice(0, maxSubstances) : selected;
}

async function searchEuropePmc(query: string): Promise<Record<string, unknown>[]> {
  const endpoint = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("resultType", "core");
  endpoint.searchParams.set("pageSize", String(perQuery));
  const response = await fetch(endpoint, { headers: { accept: "application/json", "user-agent": "BHWiki-literature-monitor/0.1 (+https://github.com/AntonIXO/bhwiki-literature-monitor)" } });
  if (!response.ok) throw new Error(`Europe PMC HTTP ${response.status}`);
  const body = await response.json() as { resultList?: { result?: Record<string, unknown>[] } };
  return body.resultList?.result ?? [];
}

function matchedTerms(target: WatchTarget, result: Record<string, unknown>): string[] {
  const text = `${result.title ?? ""} ${result.abstractText ?? result.abstract ?? ""}`.toLocaleLowerCase();
  return [...new Set([target.name, ...target.aliases, ...target.tags].filter((term) => term.length >= 2 && text.includes(term.toLocaleLowerCase())))];
}

async function callLlm(paper: LiteraturePaper): Promise<Array<{ substanceSlug: string; suggestionType: SuggestionType; payload: Record<string, unknown>; rationale: string; evidenceQuotes: string[]; confidence?: number }>> {
  const prompt = [
    "You are an evidence triage assistant for BHWiki.",
    "Use only this title and abstract. Never invent identifiers, doses, mechanisms, certainty, funding, licensing, or missing study details.",
    "Return JSON exactly as {suggestions:[{substanceSlug,suggestionType,payload,rationale,evidenceQuotes,confidence}]}.",
    "suggestionType must be new-reference, new-outcome, new-effect, new-claim, new-caution, or ignore.",
    "Each evidenceQuotes entry must be a contiguous verbatim span from the abstract; use [] when no sufficient span exists.",
    `Matched substances: ${paper.matchedSubstances.join(", ")}`,
    `Title: ${paper.title}`,
    `Abstract: ${paper.abstract || "(no abstract)"}`,
  ].join("\n");
  const response = await fetch(`${llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(llmApiKey ? { authorization: `Bearer ${llmApiKey}` } : {}) },
    body: JSON.stringify({ model: llmModel, temperature: 0, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }),
  });
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = (body.choices?.[0]?.message?.content ?? "{}").replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const parsed = JSON.parse(content) as { suggestions?: unknown };
  if (!Array.isArray(parsed.suggestions)) return [];
  return parsed.suggestions.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const type = String(item.suggestionType) as SuggestionType;
    const substanceSlug = String(item.substanceSlug ?? paper.matchedSubstances[0]);
    const rationale = String(item.rationale ?? "").trim();
    const payload = item.payload && typeof item.payload === "object" ? item.payload as Record<string, unknown> : {};
    const quotes = Array.isArray(item.evidenceQuotes) ? extractQuotedEvidence(item.evidenceQuotes.map(String), paper.abstract) : [];
    const confidence = typeof item.confidence === "number" ? item.confidence : undefined;
    if (!validTypes.has(type) || !paper.matchedSubstances.includes(substanceSlug) || !rationale || (confidence !== undefined && (confidence < 0 || confidence > 1))) return [];
    return [{ substanceSlug, suggestionType: type, payload, rationale, evidenceQuotes: quotes, confidence }];
  });
}

function safe(value: string): string { return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 150); }

async function writeRunOutput(papers: LiteraturePaper[], proposals: Array<{ id: string; paper: LiteraturePaper; substanceSlug: string; suggestionType: SuggestionType; payload: Record<string, unknown>; rationale: string; evidenceQuotes: string[]; confidence?: number }>): Promise<string[]> {
  const base = dryRun ? path.join(root, "dry-runs", runId) : path.join(repoDir, "data", "research", "auto-proposals");
  const proposalPaths: string[] = [];
  await mkdir(base, { recursive: true });
  for (const proposal of proposals) {
    const filename = `${safe(proposal.paper.id)}-${safe(proposal.substanceSlug)}.md`;
    const target = path.join(base, filename);
    if (!dryRun && existsSync(target)) continue;
    await writeFile(target, renderProposal(proposal));
    proposalPaths.push(target);
  }
  if (proposalPaths.length) {
    const manifest = {
      runId,
      source: "europepmc",
      since,
      retrievedAt: new Date().toISOString(),
      llm: noLlm ? null : { provider: "openai-compatible", model: llmModel },
      papers: papers.map((paper) => ({ id: canonicalPaperId(paper), title: paper.title, url: paper.url, doi: paper.doi, pmid: paper.pmid, pmcid: paper.pmcid, publishedOn: paper.publishedOn, matchedSubstances: paper.matchedSubstances, matchedTerms: paper.matchedTerms, raw: paper.raw })),
      proposals: proposals.map(({ id, paper, substanceSlug, suggestionType, payload, rationale, evidenceQuotes, confidence }) => ({ id, paperId: canonicalPaperId(paper), substanceSlug, suggestionType, payload, rationale, evidenceQuotes, confidence })),
    };
    await writeFile(path.join(base, `manifest-${runId}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return proposalPaths;
}

async function createPr(paths: string[]): Promise<string> {
  const branch = `literature/${runId}`;
  await shell("git", ["checkout", "-b", branch], repoDir);
  const relative = paths.map((p) => path.relative(repoDir, p));
  await shell("git", ["add", ...relative, "data/research/auto-proposals/manifest-" + runId + ".json"], repoDir);
  await shell("git", ["commit", "-m", `research: add automated literature proposals ${runId}`], repoDir);
  await shell("git", ["push", "--set-upstream", "origin", branch], repoDir);
  const body = [
    "## Automated literature proposals",
    "",
    `Run: ${runId}`,
    `Source: Europe PMC, rolling window since ${since}`,
    `Proposal files: ${paths.length}`,
    "",
    "This PR contains review artifacts only. It does not modify published substance Markdown. Human review must verify the canonical publication, article version, limitations, funding/conflicts, rights, and apply any accepted change manually before merging.",
  ].join("\n");
  const bodyPath = path.join(root, `${runId}-pr-body.md`);
  await writeFile(bodyPath, body);
  return shell("gh", ["pr", "create", "--repo", githubRepo, "--head", branch, "--base", baseBranch, "--title", `research: automated literature proposals ${runId}`, "--body-file", bodyPath], repoDir);
}

async function main(): Promise<void> {
  const release = await acquireLock();
  try {
    await prepareRepo();
    const targets = await readWatchTargets();
    const fetched: LiteraturePaper[] = [];
    for (const target of targets) {
      const results = await searchEuropePmc(buildEuropePmcQuery(target, since));
      for (const result of results) {
        const terms = matchedTerms(target, result);
        if (terms.length) fetched.push(parseEuropePmcResult(result, target, terms));
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const papers = deduplicatePapers(fetched);
    const proposals: Array<{ id: string; paper: LiteraturePaper; substanceSlug: string; suggestionType: SuggestionType; payload: Record<string, unknown>; rationale: string; evidenceQuotes: string[]; confidence?: number }> = [];
    if (!noLlm) {
      for (const paper of papers) {
        if (!paper.abstract) continue;
        try {
          for (const suggestion of await callLlm(paper)) {
            const id = `proposal:${createHash("sha256").update(JSON.stringify([paper.id, suggestion.substanceSlug, suggestion.suggestionType, suggestion.payload, suggestion.rationale])).digest("hex").slice(0, 32)}`;
            proposals.push({ id, paper, ...suggestion });
          }
        } catch (error) {
          console.error(`LLM triage failed for ${paper.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const paths = await writeRunOutput(papers, proposals);
    const pr = !dryRun && paths.length ? await createPr(paths) : null;
    console.log(JSON.stringify({ runId, since, targets: targets.length, papers: papers.length, proposals: proposals.length, files: paths.length, dryRun, pr }, null, 2));
  } finally {
    await release();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
