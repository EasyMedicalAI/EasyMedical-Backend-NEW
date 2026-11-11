// PubMed (the National Library of Medicine's index of medical journals): recent articles with abstracts.
// Only the search term is sent. Nothing about the person is sent.

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const TOOL_NAME = 'EasyMedicalPersonal';
const SEARCH_LIMIT = 15;
const YEARS_BACK = 3;
const MAX_ABSTRACT_CHARACTERS = 1500;

// Reviews, guidelines and meta-analyses give an overview, which suits most questions. Used first.
const OVERVIEW_TYPES = '(review[pt] OR practice guideline[pt] OR guideline[pt] OR meta-analysis[pt] OR systematic review[pt])';

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function plainText(xml) {
  return decodeEntities(xml.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match ? plainText(match[1]) : '';
}

// One article from a PubmedArticle block. Articles without an abstract are skipped.
function parseArticle(block) {
  const pmid = firstTag(block, 'PMID');
  const title = firstTag(block, 'ArticleTitle');
  const journal = firstTag(block, 'ISOAbbreviation') || firstTag(block, 'Title');
  const year = block.match(/<Year>(\d{4})<\/Year>/)?.[1] || block.match(/(\d{4})/)?.[1] || '';
  const parts = [];
  const abstractRe = /<AbstractText(\s[^>]*)?>([\s\S]*?)<\/AbstractText>/g;
  let match;
  while ((match = abstractRe.exec(block)) !== null) {
    const label = match[1]?.match(/Label="([^"]+)"/)?.[1];
    const text = plainText(match[2]);
    if (text) parts.push(label ? `${label}: ${text}` : text);
  }
  const abstract = parts.join(' ').slice(0, MAX_ABSTRACT_CHARACTERS);
  if (!pmid || !title || !abstract) return null;
  const publicationTypes = [...block.matchAll(/<PublicationType[^>]*>([^<]*)<\/PublicationType>/g)].map((m) => decodeEntities(m[1]));
  return { pmid, title, journal, year, abstract, publicationTypes };
}

// NCBI allows about three requests a second without an API key. Requests are spaced out, and one retry is
// made if NCBI still answers 429 (too many requests).
const MIN_GAP_MS = 400;
let lastRequest = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function pubmedGet(url) {
  const wait = MIN_GAP_MS - (Date.now() - lastRequest);
  if (wait > 0) await pause(wait);
  lastRequest = Date.now();
  let response = await fetch(url);
  if (response.status === 429) {
    await pause(1200);
    lastRequest = Date.now();
    response = await fetch(url);
  }
  return response;
}

function apiKeyParam(params) {
  if (process.env.NCBI_API_KEY) params.set('api_key', process.env.NCBI_API_KEY);
  return params;
}

async function searchTerm(term, field, extra) {
  const now = new Date().getFullYear();
  const params = apiKeyParam(new URLSearchParams({
    db: 'pubmed',
    term: `"${term.replace(/["\[\]]/g, '')}"[${field}] AND hasabstract${extra}`,
    retmax: String(SEARCH_LIMIT),
    sort: 'pub date',
    datetype: 'pdat',
    mindate: String(now - YEARS_BACK),
    maxdate: String(now),
    retmode: 'json',
    tool: TOOL_NAME,
  }));
  const response = await pubmedGet(`${EUTILS}/esearch.fcgi?${params.toString()}`);
  if (!response.ok) throw new Error(`PubMed search failed (${response.status})`);
  const json = await response.json();
  return json.esearchresult?.idlist || [];
}

// Recent articles about a condition. The search is widened in steps, and the first step with at least three
// articles is used: titles first, then the abstract too, with overview articles preferred at each step.
async function searchIds(condition) {
  const steps = [
    ['Title', ` AND ${OVERVIEW_TYPES}`],
    ['Title/Abstract', ` AND ${OVERVIEW_TYPES}`],
    ['Title/Abstract', ''],
  ];
  let ids = [];
  for (const [field, extra] of steps) {
    ids = await searchTerm(condition, field, extra);
    if (ids.length >= 3) return ids;
  }
  return ids;
}

async function fetchArticles(ids, limit) {
  if (ids.length === 0) return [];
  const params = apiKeyParam(new URLSearchParams({ db: 'pubmed', id: ids.join(','), retmode: 'xml', tool: TOOL_NAME }));
  const response = await pubmedGet(`${EUTILS}/efetch.fcgi?${params.toString()}`);
  if (!response.ok) throw new Error(`PubMed fetch failed (${response.status})`);
  const xml = await response.text();
  const articles = [];
  for (const block of xml.split('<PubmedArticle>').slice(1)) {
    const article = parseArticle(block);
    if (article) articles.push(article);
    if (articles.length === limit) break;
  }
  return articles;
}

// Up to `limit` recent articles with abstracts for a condition name.
async function articlesFor(condition, limit) {
  const ids = await searchIds(condition);
  return fetchArticles(ids, limit);
}

function sourceOf(article) {
  return {
    pmid: article.pmid,
    title: article.title,
    journal: article.journal,
    year: article.year,
    url: `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`,
  };
}

module.exports = { articlesFor, parseArticle, sourceOf, decodeEntities };
