import http from 'node:http';
import { URL } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const BUILT_IN_URL = process.env.BUILT_IN_FORGE_API_URL;
const BUILT_IN_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const DATA_DIR = path.join(process.cwd(), 'data');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat-history.json');
const RAG_URL = process.env.RAG_URL || 'http://127.0.0.1:8090';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
let SYSTEM_PROMPT = 'You are a helpful conversational study tutor. Never fabricate citations.';
let authStore = { users: [], sessions: [] };
let chatStore = [];

const curatedSources = [
  { id: 'openstax', name: 'OpenStax textbooks', category: 'Science · Maths', url: 'https://openstax.org/subjects', description: 'Free peer-reviewed textbooks for science, mathematics, business, and more.' },
  { id: 'khan', name: 'Khan Academy', category: 'Core subjects', url: 'https://www.khanacademy.org/', description: 'Practice exercises and lessons across mathematics, science, computing, and humanities.' },
  { id: 'mit-ocw', name: 'MIT OpenCourseWare', category: 'University courses', url: 'https://ocw.mit.edu/search/', description: 'Lecture notes, assignments, and course materials from MIT.' },
  { id: 'libretexts', name: 'LibreTexts', category: 'Open textbooks', url: 'https://libretexts.org/', description: 'Open educational textbooks across chemistry, biology, physics, mathematics, and social sciences.' },
  { id: 'ncert', name: 'NCERT textbooks', category: 'Indian curriculum', url: 'https://ncert.nic.in/textbook.php', description: 'Official school textbooks and curriculum material for India.' },
  { id: 'swayam', name: 'SWAYAM', category: 'Indian higher education', url: 'https://swayam.gov.in/', description: 'Indian government-supported online courses from universities and institutions.' },
  { id: 'wikipedia', name: 'Wikipedia', category: 'Reference', url: 'https://www.wikipedia.org/', description: 'A broad starting reference for definitions, timelines, and connected concepts.' },
  { id: 'britannica', name: 'Encyclopaedia Britannica', category: 'Reference', url: 'https://www.britannica.com/', description: 'Editorial reference articles; some content may require access depending on the page.' },
  { id: 'arxiv', name: 'arXiv', category: 'Research papers', url: 'https://arxiv.org/', description: 'Open research papers in physics, mathematics, computer science, and related fields.' },
  { id: 'pubmed', name: 'PubMed', category: 'Biomedical research', url: 'https://pubmed.ncbi.nlm.nih.gov/', description: 'Searchable biomedical and life-sciences literature from the National Library of Medicine.' },
  { id: 'gutenberg', name: 'Project Gutenberg', category: 'Literature', url: 'https://www.gutenberg.org/', description: 'Free public-domain ebooks for literature and humanities study.' },
  { id: 'internet-archive', name: 'Internet Archive', category: 'Archives', url: 'https://archive.org/', description: 'Digitized books, media, historical collections, and public web archives.' },
  { id: 'our-world-in-data', name: 'Our World in Data', category: 'Open data', url: 'https://ourworldindata.org/', description: 'Research-backed charts and datasets on global health, society, economics, and environment.' },
  { id: 'data-gov', name: 'Data.gov', category: 'Government data', url: 'https://data.gov/', description: 'Open government datasets for civic, economic, environmental, and public-policy study.' },
  { id: 'nasa', name: 'NASA', category: 'Space · Earth science', url: 'https://www.nasa.gov/learning-resources/', description: 'Educational resources and primary information for space and Earth science.' },
  { id: 'who', name: 'World Health Organization', category: 'Public health', url: 'https://www.who.int/publications', description: 'Official health guidance, reports, and public-health evidence.' },
  { id: 'cdc', name: 'CDC', category: 'Health reference', url: 'https://www.cdc.gov/', description: 'Public health information, data, and educational references from the US CDC.' },
  { id: 'nist', name: 'NIST', category: 'Computing · Standards', url: 'https://www.nist.gov/publications', description: 'Technical publications, standards, and cybersecurity research.' },
  { id: 'python-docs', name: 'Python documentation', category: 'Programming', url: 'https://docs.python.org/3/', description: 'Official Python language and standard-library documentation.' },
  { id: 'mdn', name: 'MDN Web Docs', category: 'Web development', url: 'https://developer.mozilla.org/', description: 'Reference documentation for HTML, CSS, JavaScript, and web APIs.' },
];

let library = [];

async function loadLibrary() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { library = JSON.parse(await fs.readFile(LIBRARY_FILE, 'utf8')); } catch { library = []; }
  for (const item of library) await ragIngest(item);
}
async function saveLibrary() { await fs.mkdir(DATA_DIR, { recursive: true }); await fs.writeFile(LIBRARY_FILE, JSON.stringify(library, null, 2)); }
async function loadAuth() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { authStore = JSON.parse(await fs.readFile(AUTH_FILE, 'utf8')); } catch { authStore = { users: [], sessions: [] }; }
  try { chatStore = JSON.parse(await fs.readFile(CHAT_FILE, 'utf8')); } catch { chatStore = []; }
}
async function saveAuth() { await fs.writeFile(AUTH_FILE, JSON.stringify(authStore, null, 2)); }
async function saveChats() { await fs.writeFile(CHAT_FILE, JSON.stringify(chatStore, null, 2)); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) { return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') }; }
function verifyPassword(password, user) { const hash = crypto.scryptSync(password, user.salt, 64).toString('hex'); return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passwordHash, 'hex')); }
function parseCookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2)); }
function authUser(req) { const sid = parseCookies(req).studymate_sid; const session = authStore.sessions.find(item => item.id === sid && item.expiresAt > Date.now()); return session ? authStore.users.find(user => user.id === session.userId) : null; }
function setSessionCookie(res, id, maxAge = 60 * 60 * 24 * 30) { res.setHeader('Set-Cookie', `studymate_sid=${encodeURIComponent(id)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`); }
function publicUser(user) { return user ? { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt } : null; }
function publicSession(item) { return { id: item.id, title: item.title, updatedAt: item.updatedAt, messageCount: item.messages.length }; }
async function ragRequest(endpoint, payload) {
  try {
    const response = await fetch(`${RAG_URL}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}
async function ragIngest(item) { return ragRequest('/ingest', { id: item.id, name: item.name, text: item.text }); }
async function ragDelete(id) { return ragRequest('/delete', { id }); }
async function ragRetrieve(query) {
  const result = await ragRequest('/retrieve', { query, limit: 5 });
  return (result?.results || []).map(item => ({ title: item.name, url: null, snippet: item.text, kind: 'rag', libraryId: item.documentId, score: item.score }));
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); }
function stripHtml(value) { return value.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }
function textPreview(text) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500); }

function extractDuckResults(html, query) {
  const results = [];
  const blocks = html.match(/<a[^>]+class="result__a"[^>]*>[\s\S]*?<\/a>[\s\S]*?(?=<a[^>]+class="result__a"|$)/gi) || [];
  for (const block of blocks.slice(0, 6)) {
    const link = block.match(/href="([^"]+)"/i)?.[1];
    const title = stripHtml(block.match(/<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/i)?.[1] || 'Web result');
    const text = stripHtml(block);
    if (!link || !title) continue;
    results.push({ title, url: link.startsWith('//') ? `https:${link}` : link, snippet: text.replace(title, '').slice(0, 280) || `Public web result for ${query}`, kind: 'web' });
  }
  return results;
}

function retrievalQuery(query) {
  const stopwords = new Set('what how does do the a an and or of in for to from with is are be this that should when why can improve main roles role compare explain involving about into using only sentence sentences two three first simple briefly please tell me'.split(' '));
  const words = query.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(word => word.length > 3 && !stopwords.has(word));
  return [...new Set(words)].slice(0, 12).join(' ');
}

function keepRelevantSources(results, query) {
  const terms = retrievalQuery(query).split(/\s+/).filter(term => term.length > 3);
  if (!terms.length) return results;
  const relevant = results.filter(source => {
    const haystack = `${source.title} ${source.snippet}`.toLowerCase();
    return terms.some(term => haystack.includes(term));
  });
  return relevant;
}

async function webSearch(query) {
  if (/\b(my|your)\b.*\b(right now|currently|bedroom|room|house|location|appearance|device)\b/i.test(query)) return [];
  let results = [];
  const searchTerm = retrievalQuery(query) || query;
  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchTerm)}`, { headers: { 'User-Agent': 'StudyWebChatbot/0.2 (educational prototype)' } });
    if (response.ok) results = extractDuckResults(await response.text(), searchTerm);
  } catch { /* use Wikipedia fallback */ }
  if (!results.length) {
    const focusedTerms = [searchTerm, 'retrieval augmented generation', 'information retrieval', 'grounded generation citations'].filter((term, index, all) => term && all.indexOf(term) === index);
    for (const focused of focusedTerms) {
      try {
        const api = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(focused)}&srlimit=4&format=json&origin=*`;
        const searchResponse = await fetch(api, { headers: { 'User-Agent': 'StudyWebChatbot/0.2' } });
        if (!searchResponse.ok) continue;
        const hits = (await searchResponse.json()).query?.search || [];
        for (const hit of hits.slice(0, 4)) {
          const summaryResponse = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/\s+/g, '_'))}`, { headers: { 'User-Agent': 'StudyWebChatbot/0.2' } });
          if (!summaryResponse.ok) continue;
          const data = await summaryResponse.json();
          if (data.extract) results.push({ title: data.title || hit.title, url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/\s+/g, '_'))}`, snippet: data.extract, kind: 'web' });
        }
        if (results.length) break;
      } catch { /* try the next focused term */ }
    }
  }
  return keepRelevantSources(results, query);
}

function rankLibrary(question) {
  const words = question.toLowerCase().split(/\W+/).filter(word => word.length > 3);
  return library.map(item => ({ item, score: words.reduce((score, word) => score + (item.text?.toLowerCase().includes(word) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score).slice(0, 3).map(({ item }) => ({ title: item.name, url: null, snippet: textPreview(item.text), kind: 'uploaded', libraryId: item.id }));
}

function fallbackAnswer(question, sources, librarySources = []) {
  if (!sources.length && !librarySources.length) return `I can help with “${question}” using my general knowledge, but no public or imported source was attached to this turn. Ask a more specific question or open Library to import your notes.`;
  const all = [...librarySources, ...sources];
  const bullets = all.slice(0, 4).map((source, index) => `**${index + 1}. ${source.title}** — ${source.snippet}`).join('\n\n');
  return `Here is a source-grounded starting explanation for **${question}**.\n\n${bullets}\n\n**Study tip:** Write the idea in your own words, then ask me to generate a quiz from it.`;
}

async function callModel(messages, fallback) {
  if (!BUILT_IN_URL || !BUILT_IN_KEY) return { answer: fallback, model: 'source-summary-fallback' };
  try {
    const response = await fetch(`${BUILT_IN_URL.replace(/\/$/, '')}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BUILT_IN_KEY}` }, body: JSON.stringify({ model: process.env.STUDY_CHAT_MODEL || 'gpt-4.1-mini', messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages.filter(message => message.role !== 'system')], temperature: 0.35 }) });
    if (!response.ok) throw new Error('LLM unavailable');
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('Empty model response');
    return { answer, model: data.model || process.env.STUDY_CHAT_MODEL || 'built-in-llm' };
  } catch { return { answer: fallback, model: 'source-summary-fallback' }; }
}

async function callStructured(messages, schemaName, schema, fallback) {
  if (!BUILT_IN_URL || !BUILT_IN_KEY) return fallback;
  try {
    const response = await fetch(`${BUILT_IN_URL.replace(/\/$/, '')}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BUILT_IN_KEY}` }, body: JSON.stringify({ model: process.env.STUDY_CHAT_MODEL || 'gpt-4.1-mini', messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages], temperature: 0.1, response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } } }) });
    if (!response.ok) throw new Error('Structured LLM unavailable');
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);
    return { ...parsed, model: data.model || process.env.STUDY_CHAT_MODEL || 'built-in-llm' };
  } catch { return fallback; }
}

async function synthesize(question, sources, librarySources, mode, history = []) {
  const allSources = [...librarySources, ...sources];
  const context = allSources.length ? allSources.map((source, index) => `[${index + 1}] ${source.title}\n${source.url ? `URL: ${source.url}\n` : 'Private imported material.\n'}Excerpt: ${source.snippet}`).join('\n\n') : 'No reliable public or imported source excerpts were returned. Do not state uncertain facts as verified.';
  const conversation = history.slice(-8).map(item => `${item.role === 'user' ? 'Student' : 'Tutor'}: ${String(item.content).slice(0, 1800)}`).join('\n');
  const prompt = `Answer the latest student message using only the numbered knowledge context below. You may use conversation history to resolve references, but do not import unsupported facts from memory. Give a direct answer, then a concise explanation in ${mode === 'exam' ? 'exam-ready' : 'teaching'} language. Every factual claim that depends on the context must be supported by one or more citation numbers. If the context is insufficient, say that clearly instead of guessing.\n\nConversation:\n${conversation || '(new conversation)'}\n\nLatest question: ${question}\n\nKnowledge context:\n${context}`;
  const answerSchema = { type: 'object', properties: { answer: { type: 'string' }, citationIds: { type: 'array', items: { type: 'integer' } }, confidence: { type: 'string', enum: ['high', 'medium', 'low', 'insufficient'] }, caveat: { type: 'string' } }, required: ['answer', 'citationIds', 'confidence', 'caveat'], additionalProperties: false };
  const draft = await callStructured([{ role: 'user', content: prompt }], 'grounded_study_answer', answerSchema, { answer: fallbackAnswer(question, sources, librarySources), citationIds: [], confidence: allSources.length ? 'low' : 'insufficient', caveat: 'This answer used the available fallback because a structured model response was unavailable.', model: 'source-summary-fallback' });
  const validIds = [...new Set((draft.citationIds || []).filter(id => Number.isInteger(id) && id >= 1 && id <= allSources.length))];
  const verifierSchema = { type: 'object', properties: { supported: { type: 'boolean' }, confidence: { type: 'string', enum: ['high', 'medium', 'low', 'insufficient'] }, issue: { type: 'string' } }, required: ['supported', 'confidence', 'issue'], additionalProperties: false };
  const verification = allSources.length ? await callStructured([{ role: 'user', content: `Verify this proposed study answer against the sources. Mark supported=false if it contains a material claim not supported by the excerpts or if citations are missing for source-dependent claims.\n\nProposed answer:\n${draft.answer}\n\nCitations supplied: ${validIds.join(', ') || 'none'}\n\nSources:\n${context}` }], 'grounding_check', verifierSchema, { supported: false, confidence: 'low', issue: 'The answer could not be automatically verified.', model: draft.model }) : { supported: false, confidence: 'insufficient', issue: 'No source context was available.' };
  const safeAnswer = verification.supported ? draft.answer : `${draft.answer}\n\n> **Verification note:** ${verification.issue || draft.caveat || 'Some claims could not be verified against the available sources. Treat this as a starting explanation and review the cited material.'}`;
  const partial = /insufficient|not contain|does not contain|missing|could not|lacks/i.test(`${draft.answer} ${draft.caveat} ${verification.issue}`);
  const calibratedConfidence = verification.supported ? (partial && verification.confidence === 'high' ? 'medium' : verification.confidence) : 'low';
  return { answer: safeAnswer, citationIds: validIds, confidence: calibratedConfidence, verified: Boolean(verification.supported), caveat: verification.issue || draft.caveat || '', model: draft.model };
}

function extractMultipart(buffer, contentType) {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) throw new Error('Upload boundary missing');
  const marker = Buffer.from(`--${boundary}`); const parts = []; let start = 0;
  while (true) { const index = buffer.indexOf(marker, start); if (index < 0) break; if (start > 0) parts.push(buffer.subarray(start, index)); start = index + marker.length; }
  for (const part of parts) {
    const clean = part.subarray(part.indexOf(Buffer.from('\r\n')) + 2); const divider = clean.indexOf(Buffer.from('\r\n\r\n')); if (divider < 0) continue;
    const headers = clean.subarray(0, divider).toString('utf8'); let body = clean.subarray(divider + 4); if (body.subarray(-2).toString() === '\r\n') body = body.subarray(0, -2);
    const filename = headers.match(/filename="([^"]*)"/i)?.[1]; if (filename) return { filename: path.basename(filename), content: body };
  }
  throw new Error('No file found in upload');
}

async function extractText(filename, content) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf' || ext === '.docx') {
    const temp = path.join(os.tmpdir(), `studymate-${Date.now()}-${filename.replace(/[^a-z0-9.]/gi, '_')}`); await fs.writeFile(temp, content);
    try {
      if (ext === '.pdf') return (await execFileAsync('pdftotext', [temp, '-'], { maxBuffer: 2 * 1024 * 1024 })).stdout;
      const xml = (await execFileAsync('unzip', ['-p', temp, 'word/document.xml'], { maxBuffer: 2 * 1024 * 1024 })).stdout; return stripHtml(xml);
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  if (ext === '.json') { try { return JSON.stringify(JSON.parse(content.toString('utf8')), null, 2); } catch { return content.toString('utf8'); } }
  return content.toString('utf8');
}

async function readBody(req, limit = 200000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request is too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function studyTool(body) {
  const item = library.find(entry => entry.id === body.materialId);
  if (!item) return { error: 'Choose an imported material first.' };
  const text = item.text.slice(0, 30000); const action = ['summary', 'flashcards', 'quiz'].includes(body.action) ? body.action : 'summary';
  const instruction = action === 'summary' ? 'Create a concise study summary with headings, key definitions, and five takeaways.' : action === 'flashcards' ? 'Create 8 flashcards in the format Question: ... Answer: ... Use only the material.' : 'Create 5 multiple-choice questions with four options, the correct answer, and a one-sentence explanation.';
  const fallback = action === 'summary' ? `**Summary of ${item.name}**\n\n${textPreview(text)}\n\n**Next step:** ask a question about one section to go deeper.` : action === 'flashcards' ? `**Flashcards from ${item.name}**\n\n1. **What is the central topic?**\nAnswer: ${textPreview(text).slice(0, 240)}\n\n2. **What should you review next?**\nAnswer: Identify the key terms and examples in the material.` : `**Quiz from ${item.name}**\n\n1. What is the main idea of this material?\nA. The opening concept\nB. An unrelated topic\nC. A random detail\nD. None of these\n\nAnswer: A — review the material and ask for a harder quiz.`;
  return { action, materialId: item.id, name: item.name, ...(await callModel([{ role: 'system', content: 'You create accurate learning materials from supplied text. Do not add facts not present in the text.' }, { role: 'user', content: `${instruction}\n\nMaterial: ${item.name}\n\n${text}` }], fallback)) };
}

async function handleChat(body) {
  const question = String(body.question || '').trim(); const mode = body.mode === 'exam' ? 'exam' : 'teach';
  const history = Array.isArray(body.history) ? body.history.filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string').slice(-8) : [];
  if (question.length < 2) return { error: 'Ask a question first.' };
  const [sources, ragSources] = await Promise.all([webSearch(question), ragRetrieve(question)]);
  const librarySources = ragSources.length ? ragSources : rankLibrary(question);
  const result = await synthesize(question, sources, librarySources, mode, history);
  return { question, mode, ...result, sources: [...librarySources, ...sources], searchedAt: new Date().toISOString() };
}

async function persistChat(user, body, result) {
  if (!user) return result;
  const sessionId = String(body.sessionId || `chat_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  let session = chatStore.find(item => item.id === sessionId && item.userId === user.id);
  if (!session) { session = { id: sessionId, userId: user.id, title: String(body.question || 'Study session').slice(0, 72), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] }; chatStore.unshift(session); }
  session.messages.push({ role: 'user', content: result.question, mode: result.mode, createdAt: new Date().toISOString() }, { role: 'assistant', content: result.answer, sources: result.sources, confidence: result.confidence, verified: result.verified, createdAt: new Date().toISOString() });
  session.updatedAt = new Date().toISOString();
  await saveChats();
  return { ...result, sessionId };
}

try { SYSTEM_PROMPT = await fs.readFile(path.join(process.cwd(), 'study_prompt.md'), 'utf8'); } catch { /* default prompt remains active */ }
await loadLibrary();
await loadAuth();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(await fs.readFile(new URL('./public/index.html', import.meta.url))); return; }
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'study-chatbot-prototype', uploadedMaterials: library.length });
    if (req.method === 'GET' && url.pathname === '/api/auth/me') return json(res, 200, { user: publicUser(authUser(req)) });
    if (req.method === 'POST' && (url.pathname === '/api/auth/register' || url.pathname === '/api/auth/login')) {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); const email = String(body.email || '').trim().toLowerCase(); const password = String(body.password || '');
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return json(res, 400, { error: 'Use a valid email and a password of at least 8 characters.' });
      let user = authStore.users.find(item => item.email === email);
      if (url.pathname.endsWith('/register')) { if (user) return json(res, 409, { error: 'An account with that email already exists.' }); const credentials = hashPassword(password); user = { id: `user_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`, email, name: String(body.name || email.split('@')[0]).slice(0, 60), ...credentials, createdAt: new Date().toISOString() }; authStore.users.push(user); }
      else if (!user || !verifyPassword(password, user)) return json(res, 401, { error: 'Email or password is incorrect.' });
      const session = { id: crypto.randomBytes(32).toString('hex'), userId: user.id, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30 }; authStore.sessions = authStore.sessions.filter(item => item.expiresAt > Date.now() && item.userId !== user.id); authStore.sessions.push(session); await saveAuth(); setSessionCookie(res, session.id); return json(res, 200, { user: publicUser(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') { const sid = parseCookies(req).studymate_sid; authStore.sessions = authStore.sessions.filter(item => item.id !== sid); await saveAuth(); res.setHeader('Set-Cookie', 'studymate_sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/api/sessions') { const user = authUser(req); if (!user) return json(res, 401, { error: 'Sign in to view saved sessions.' }); return json(res, 200, { sessions: chatStore.filter(item => item.userId === user.id).map(publicSession) }); }
    if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/')) { const user = authUser(req); if (!user) return json(res, 401, { error: 'Sign in to view saved sessions.' }); const session = chatStore.find(item => item.id === url.pathname.split('/').pop() && item.userId === user.id); return session ? json(res, 200, { session }) : json(res, 404, { error: 'Session not found.' }); }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/sessions/')) { const user = authUser(req); if (!user) return json(res, 401, { error: 'Sign in to manage saved sessions.' }); const id = url.pathname.split('/').pop(); chatStore = chatStore.filter(item => !(item.id === id && item.userId === user.id)); await saveChats(); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/api/library') return json(res, 200, { curated: curatedSources, uploads: library.map(item => ({ id: item.id, name: item.name, size: item.size, importedAt: item.importedAt, preview: textPreview(item.text) })) });
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/library/')) { const id = url.pathname.split('/').pop(); library = library.filter(item => item.id !== id); await saveLibrary(); await ragDelete(id); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/import') { const buffer = await readBody(req, MAX_UPLOAD_BYTES); const file = extractMultipart(buffer, req.headers['content-type'] || ''); const text = (await extractText(file.filename, file.content)).replace(/\u0000/g, '').trim(); if (!text) return json(res, 400, { error: 'The file did not contain readable text.' }); const item = { id: `upload_${Date.now()}`, name: file.filename, size: file.content.length, text: text.slice(0, 150000), importedAt: new Date().toISOString() }; library.unshift(item); await saveLibrary(); await ragIngest(item); return json(res, 200, { ok: true, item: { id: item.id, name: item.name, size: item.size, preview: textPreview(item.text) } }); }
    if (req.method === 'POST' && url.pathname === '/api/chat') { const body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); const result = await handleChat(body); return json(res, 200, await persistChat(authUser(req), body, result)); }
    if (req.method === 'POST' && url.pathname === '/api/study') { const body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); return json(res, 200, await studyTool(body)); }
    return json(res, 404, { error: 'Not found' });
  } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Request failed' }); }
});
server.listen(PORT, HOST, () => console.log(`Study chatbot listening on ${HOST}:${PORT}`));
