const $ = (id) => document.getElementById(id);
let selectedFolder = null;
let selectedProject = null;
let latest = null;
let caseHistory = [];
let selectedFindingIndex = null;
const HISTORY_KEY = 'gotham-case-history-v1';

try { caseHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); if (!Array.isArray(caseHistory)) caseHistory = []; } catch { caseHistory = []; }
renderCaseHistory();
$('chooseBtn').addEventListener('click', chooseFolder);
$('chooseFilesBtn').addEventListener('click', () => $('filesInput').click());
$('folderInput').addEventListener('change', e => loadFileList(e.target.files));
$('filesInput').addEventListener('change', e => loadFileList(e.target.files));
$('scanBtn').addEventListener('click', runAudit);
$('exportBtn').addEventListener('click', exportReport);
$('severityFilter').addEventListener('change', renderFindings);
$('returnToBoardBtn').addEventListener('click', closeMissionReport);
$('enterBatcaveBtn').addEventListener('click', () => { $('dedicationOverlay').hidden = true; $('chooseBtn').focus(); });

async function chooseFolder() {
  // Chromium desktop folder access where supported; otherwise use a folder input.
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({mode:'read'});
      const files = [];
      async function walk(dir, prefix='') {
        for await (const [name, entry] of dir.entries()) {
          if (entry.kind === 'directory') {
            if (['node_modules','.git','dist','build','.next','vendor','venv','.venv'].includes(name)) continue;
            await walk(entry, prefix + name + '/');
          } else {
            const path = prefix + name;
            if (isScannable(path)) { const file = await entry.getFile(); files.push({path, file}); }
          }
          if (files.length >= 1500) return;
        }
      }
      await walk(handle);
      if (!files.length) { showError('No supported source files were found in that folder. Choose HTML, CSS, JS/TS, Python, or C/C++ files.'); return; }
      selectedProject = {root:handle.name, files:await readFiles(files)};
      setProjectReady(handle.name, files.length, 'Folder selected using browser permission. Source stays on this device.');
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      // Some browsers reject folder access; fall back to the picker.
    }
  }
  $('folderInput').click();
}
function isScannable(path) { return /\.(html?|css|scss|sass|less|jsx?|mjs|cjs|tsx?|vue|svelte|py|cpp|cc|cxx|h|hpp|hh|hxx|json|md)$/i.test(path); }
async function readFiles(items) {
  const result=[];
  for (const item of items) {
    try { result.push({path:item.path.replace(/\\/g,'/'), content:await item.file.text()}); }
    catch { /* skip unreadable file */ }
  }
  return result;
}
async function loadFileList(fileList) {
  const chosen = [...(fileList || [])].filter(f => isScannable(f.webkitRelativePath || f.name));
  if (!chosen.length) { showError('No supported files selected. Choose HTML, CSS, JS/TS, Python, or C/C++ source files.'); return; }
  const root = chosen[0].webkitRelativePath ? chosen[0].webkitRelativePath.split('/')[0] : 'Selected files';
  const items = chosen.map(file => ({path:file.webkitRelativePath || file.name, file}));
  selectedProject = {root, files:await readFiles(items)};
  setProjectReady(root, selectedProject.files.length, 'Files selected locally. No source code is uploaded.');
  $('folderInput').value = ''; $('filesInput').value = '';
}
function setProjectReady(root, count, note) {
  selectedFolder = root;
  $('projectName').textContent = root;
  $('projectPath').textContent = `${count} supported files · ${note}`;
  $('scanBtn').disabled = !selectedProject || !selectedProject.files.length;
  $('statusText').textContent = 'Project selected. Ready to scan.';
}

function normalizeRelativePath(base, reference) {
  const clean = reference.replace(/^\//, '');
  const parts = (base.includes('/') ? base.slice(0, base.lastIndexOf('/')) + '/' : '')
    .concat(clean).split('/');
  const normalized = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return normalized.join('/');
}

async function runAudit() {
  if (!selectedProject || !selectedProject.files.length) return;
  $('scanBtn').disabled = true; $('chooseBtn').disabled = true; $('chooseFilesBtn').disabled = true;
  $('scanBtn').textContent = 'Scanning…'; $('statusText').textContent = 'Analyzing selected files locally…';
  try {
    const project = selectedProject;
    latest = analyzeProject(project);
    latest.root = project.root;
    latest.fileContents = Object.fromEntries(project.files.map(f => [f.path, f.content]));
    latest.fileCount = project.files.length; latest.truncated = project.files.length >= 1500;
    updateSummary(latest); updateMission(latest);
    const caseNumber = $('caseNumber').textContent;
    caseHistory.unshift({caseNumber, root:project.root, files:project.files.length, findings:latest.findings.length, time:new Date().toLocaleString()});
    caseHistory = caseHistory.slice(0, 8);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(caseHistory)); } catch {}
    renderCaseHistory(); renderFindings(); showMissionReport(latest);
    $('exportBtn').disabled = false;
    $('statusText').textContent = latest.truncated ? 'Scan limit reached; review the evidence.' : 'Case reviewed locally. Evidence is ready for your review.';
  } catch (e) { showError(e.message); }
  finally { $('scanBtn').disabled = !selectedProject; $('chooseBtn').disabled = false; $('chooseFilesBtn').disabled = false; $('scanBtn').textContent = 'Run diagnostics'; }
}

function analyzeProject(project) {
  const findings = [];
  const files = project.files;
  const add = (severity, category, title, file, line, detail, fix) =>
    findings.push({severity, category, title, file, line, detail, fix});
  const byPath = new Map(files.map(f => [f.path, f]));
  const htmlFiles = files.filter(f => /\.(html?|vue|svelte)$/i.test(f.path));
  const cssFiles = files.filter(f => /\.(css|scss|sass|less)$/i.test(f.path));
  const jsFiles = files.filter(f => /\.(jsx?|mjs|cjs|tsx?|vue|svelte)$/i.test(f.path));
  const pythonFiles = files.filter(f => /\.py$/i.test(f.path));
  const cppFiles = files.filter(f => /\.(cpp|cc|cxx|h|hpp|hh|hxx)$/i.test(f.path));
  const packageFile = byPath.get('package.json');
  const pkg = packageFile ? safeJSON(packageFile.content) : null;

  if (!packageFile) add('Info','Project setup','No package.json found', '(project root)', null,
    'This may be a static HTML/CSS project or the package file may be outside the selected folder.',
    'For Node-based frameworks, run the audit from the project root so dependencies and scripts can be detected.');

  if (pkg) {
    const deps = {...(pkg.dependencies||{}), ...(pkg.devDependencies||{})};
    if (deps.next) add('Info','Framework','Next.js project detected','package.json',null,'The project declares Next.js. This scan uses general static checks and does not replace Next.js build or lint tools.','Run the project’s own lint and build scripts for framework-aware diagnostics.');
    else if (deps.react) add('Info','Framework','React project detected','package.json',null,'The project declares React. JSX and TSX files are included in static checks.','Run the project’s configured linter and tests for deeper analysis.');
    if (deps.vue) add('Info','Framework','Vue project detected','package.json',null,'Vue files are included in text-pattern checks.','Use Vue-specific linting for template-aware checks.');
    if (deps.svelte) add('Info','Framework','Svelte project detected','package.json',null,'Svelte files are included in text-pattern checks.','Use Svelte check for framework-specific diagnostics.');
    if (!pkg.scripts || (!pkg.scripts.lint && !pkg.scripts.check)) add('Low','Project setup','No lint/check script detected','package.json',null,'The package scripts do not expose a conventional lint or check command.','Consider adding ESLint or the framework’s recommended checker, if appropriate.');
  }

  for (const f of htmlFiles) {
    const ext = f.path.split('.').pop().toLowerCase();
    if (ext === 'vue' || ext === 'svelte') continue;
    const c = f.content;
    const base = f.path;
    if (!/<title\b[^>]*>[\s\S]*?<\/title\s*>/i.test(c))
      add('Medium','Accessibility & SEO','Missing or empty page title',base,lineOf(c, /<title\b/i),
        'The document does not appear to have a non-empty title element. Titles help users identify pages and are used by browsers and search results.',
        'Add a descriptive <title>Page name</title> inside the document head.');
    const imgRegex = /<img\b[^>]*>/gi; let m;
    while ((m = imgRegex.exec(c))) {
      if (!/\balt\s*=/i.test(m[0])) add('Medium','Accessibility','Image is missing alt text',base,lineOf(c,m[0],imgRegex.lastIndex-m[0].length),
        'Images without an alt attribute may be inaccessible to screen-reader users. Decorative images should use empty alt text.',
        'Add alt="meaningful description" or alt="" for a purely decorative image.');
      else if (/\balt\s*=\s*["']\s*["']/i.test(m[0]) && !/\brole\s*=\s*["']presentation["']/i.test(m[0]))
        add('Info','Accessibility','Image has empty alt text',base,lineOf(c,m[0],imgRegex.lastIndex-m[0].length),
          'Empty alt text is valid for decorative images but may be wrong for informative images.',
          'Confirm this image is decorative; otherwise provide concise descriptive alt text.');
    }
    const inputs = /<(input|select|textarea)\b[^>]*>/gi;
    while ((m = inputs.exec(c))) {
      if (/\btype\s*=\s*["']hidden["']/i.test(m[0])) continue;
      const id = (m[0].match(/\bid\s*=\s*["']([^"']+)["']/i)||[])[1];
      const hasAria = /\baria-label\s*=\s*["'][^"']+["']/i.test(m[0]) || /\baria-labelledby\s*=/i.test(m[0]);
      const hasPlaceholder = /\bplaceholder\s*=\s*["'][^"']+["']/i.test(m[0]);
      const labelLinked = id && new RegExp(`<label\\b[^>]*\\bfor\\s*=\\s*["']${escapeRegex(id)}["']`, 'i').test(c);
      if (!hasAria && !labelLinked) add('Medium','Accessibility','Form control may lack an accessible label',base,lineOf(c,m[0],inputs.lastIndex-m[0].length),
        'A placeholder alone is not a reliable replacement for a programmatic label.',
        'Add a visible <label for="control-id"> or a suitable aria-label/aria-labelledby.');
    }
    const links = /<a\b[^>]*>/gi;
    while ((m = links.exec(c))) {
      const href = (m[0].match(/\bhref\s*=\s*["']([^"']*)["']/i)||[])[1];
      if (href === '') add('Low','HTML quality','Link has an empty href',base,lineOf(c,m[0],links.lastIndex-m[0].length),
        'An empty link destination can be confusing and may navigate unexpectedly.',
        'Use a real destination or use a button for an action.');
    }
    if (/<html\b/i.test(c) && !/<html\b[^>]*\blang\s*=/i.test(c))
      add('Low','Accessibility','HTML language is not declared',base,lineOf(c,/<html\b/i),
        'Assistive technology uses the document language to pronounce content correctly.',
        'Set an appropriate language, for example <html lang="en">.');
    if (/<form\b/i.test(c) && !/<button\b[^>]*\btype\s*=\s*["']submit["']/i.test(c) && !/<input\b[^>]*\btype\s*=\s*["']submit["']/i.test(c))
      add('Info','HTML quality','Form has no explicit submit control detected',base,lineOf(c,/<form\b/i),
        'This heuristic may miss buttons created dynamically or controls without explicit types.',
        'Confirm the form has a clear submit action and that buttons have intentional types.');
    const externalBlankLinks = /<a\b[^>]*target\s*=\s*["']_blank["'][^>]*>/gi; let blankMatch;
    while ((blankMatch = externalBlankLinks.exec(c))) {
      if (!/\brel\s*=\s*["'][^"']*\bnoopener\b/i.test(blankMatch[0]))
        add('Medium','Security review','New-tab link may need rel="noopener"',base,lineOf(c,blankMatch[0],blankMatch.index),
          'Links opened in a new tab should generally use rel="noopener" to prevent the opened page from controlling the original tab in older or affected browser contexts.',
          'Add rel="noopener noreferrer" to the anchor, while preserving any existing rel values.');
    }
    const duplicateIds = [...c.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(x=>x[1]);
    const seen = new Set();
    for (const id of duplicateIds) {
      if (seen.has(id)) { add('Medium','HTML quality','Duplicate id attribute: '+id,base,lineOf(c,new RegExp(`\\bid\\s*=\\s*["']${escapeRegex(id)}["']`,'i')) ,
        'IDs should be unique in a document; duplicate IDs can break labels, selectors and scripts.',
        'Give each element a unique id or use a class for repeated styling.'); break; }
      seen.add(id);
    }
    const refs = [...c.matchAll(/(?:src|href)\s*=\s*["']([^"'#]+)["']/gi)].map(x=>x[1]);
    for (const ref of refs) {
      if (/^(?:https?:|mailto:|tel:|data:|\/\/|javascript:)/i.test(ref)) continue;
      const clean = decodeURI(ref.split('?')[0]);
      const candidate = normalizeRelativePath(base, clean);
      if (candidate.startsWith('../')) continue;
      if (!byPath.has(candidate) && !byPath.has(clean.replace(/^\//,'')) && !clean.startsWith('{{') && !clean.startsWith('{%')) {
        add('Low','Project references','Local asset/reference not found in scanned files',base,lineOf(c,ref),
          'This path did not match a scanned file. It may be generated, served from public/, or resolved by a framework, so verify before changing it.',
          'Check the path and whether the asset is in a public/static folder or generated at build time.');
        break;
      }
    }
  }

  for (const f of cssFiles) {
    const c=f.content, base=f.path;
    const lines=c.split(/\r?\n/);
    lines.forEach((line,i)=>{
      if (/(^|[;{]\s*)width\s*:\s*(?:[7-9]\d{2,}|1\d{3,})px/i.test(line) && !/max-width/i.test(line))
        add('Low','Responsive design','Large fixed width may overflow smaller screens',base,i+1,
          'A fixed width is not always wrong, but large pixel widths can create horizontal scrolling on phones.',
          'Consider max-width: 100%, a flexible grid, or a breakpoint if this element should shrink.');
      if (/!important\s*!important/i.test(line))
        add('Low','CSS quality','Repeated !important declaration',base,i+1,'The declaration appears to repeat !important.','Keep one declaration and prefer resolving selector specificity when possible.');
    });
    const selectors = [...c.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const seenRules = new Set();
    for (const match of selectors) {
      const selector=match[1].trim().replace(/\/\*[\s\S]*?\*\//g,'').trim();
      const body=match[2].trim().replace(/\s+/g,' ');
      if (!selector || selector.startsWith('@') || !body) continue;
      const key=selector+'{'+body+'}';
      if (seenRules.has(key)) { add('Info','CSS quality','Repeated CSS rule detected',base,lineOf(c,match[0]),
        'An identical selector and declaration block appears more than once in this file.',
        'Consider consolidating the duplicate if the repetition is not intentional.'); break; }
      seenRules.add(key);
    }
    if (/(^|[;{]\s*)color\s*:\s*#(?:fff|ffffff)\s*;/i.test(c) && /(^|[;{]\s*)background(?:-color)?\s*:\s*#(?:fff|ffffff)\s*;/i.test(c))
      add('Info','Accessibility','Potential white-on-white CSS colors',base,null,
        'White text and a white background appear in the same stylesheet; selectors may not overlap, so verify visually.',
        'Check foreground/background contrast for affected elements.');
  }

  for (const f of jsFiles) {
    const c=f.content, base=f.path;
    const todo = /\b(TODO|FIXME|XXX)\b/g; let m;
    while ((m=todo.exec(c))) {
      add('Info','Code maintenance','Developer note: '+m[1],base,lineOf(c,m[0],m.index),
        'A TODO/FIXME marker may identify unfinished work; it is not automatically a defect.',
        'Review this note before release and close it or track it in your issue list.');
      if (findings.filter(x=>x.title.startsWith('Developer note')).length>=15) break;
    }
    if (/console\.(?:log|debug)\s*\(/.test(c))
      add('Info','Code maintenance','Console logging detected',base,lineOf(c,/console\.(?:log|debug)\s*\(/),
        'Debug logging can be intentional, but noisy logs may leak implementation details or clutter production consoles.',
        'Review before release; remove sensitive data and unnecessary debug output.');
    if (/\beval\s*\(/.test(c))
      add('High','Security review','eval() usage detected',base,lineOf(c,/\beval\s*\(/),
        'eval executes strings as code and can create serious injection risk depending on data flow.',
        'Avoid eval where possible. Use safer explicit parsing or dispatch logic.');
    if (/innerHTML\s*=/.test(c))
      add('Medium','Security review','innerHTML assignment needs review',base,lineOf(c,/innerHTML\s*=/),
        'Assigning untrusted strings to innerHTML can enable cross-site scripting. This pattern alone does not prove a vulnerability.',
        'If content can include user-controlled data, use textContent or a trusted sanitization approach.');
    if (/\bdebugger\s*;?/.test(c))
      add('Low','Code maintenance','debugger statement detected',base,lineOf(c,/\bdebugger\s*;?/),
        'A debugger statement can pause execution when developer tools are open and is usually temporary development code.',
        'Remove it before release unless it is intentionally part of a debugging workflow.');
    if (/https?:\/\/[^"'`\s]+/.test(c) && /localhost|127\.0\.0\.1/.test(c))
      add('Info','Configuration','Local development URL may be hard-coded',base,lineOf(c,/https?:\/\/[^"'`\s]*(?:localhost|127\.0\.0\.1)/),
        'A local URL can be appropriate in development but may fail in deployed builds.',
        'Check whether this should come from environment-specific configuration.');
  }


  for (const f of pythonFiles) {
    const c=f.content, base=f.path;
    if (/\beval\s*\(/.test(c)) add('High','Python security review','eval() usage detected',base,lineOf(c,/\beval\s*\(/),'eval() executes a string as Python code. Risk depends on whether the input can be influenced by an untrusted source.','Avoid eval for data parsing; use safer explicit parsing or a constrained mapping.');
    if (/\bexec\s*\(/.test(c)) add('High','Python security review','exec() usage needs review',base,lineOf(c,/\bexec\s*\(/),'exec() dynamically executes Python code and can be dangerous when input is not fully trusted.','Review the data flow and replace dynamic execution where possible.');
    if (/\bpickle\.loads?\s*\(/.test(c)) add('High','Python security review','Pickle deserialization needs review',base,lineOf(c,/\bpickle\.loads?\s*\(/),'Loading pickle data from untrusted sources can execute code during deserialization.','Only unpickle trusted data; consider JSON for simple data interchange.');
    if (/except\s*:\s*(?:#.*)?(?:\r?\n|$)/.test(c)) add('Low','Python reliability','Bare except clause detected',base,lineOf(c,/except\s*:/),'A bare except catches nearly all exceptions and can hide unexpected failures.','Catch the specific exception types expected, unless a broad catch is intentional and carefully handled.');
    if (/\bprint\s*\(/.test(c)) add('Info','Python maintenance','print() call detected',base,lineOf(c,/\bprint\s*\(/),'Print statements can be intentional, but application diagnostics are often easier to manage with logging.','Review whether this is debugging output or intended user-facing output.');
    if (/\b(?:password|secret|api_key|token)\s*=\s*["'][^"']{6,}["']/i.test(c)) add('High','Security review','Possible hard-coded secret',base,lineOf(c,/\b(?:password|secret|api_key|token)\s*=/i),'A variable name and string literal resemble a hard-coded credential. This is heuristic and may be a placeholder.','Verify the value; move real secrets to environment variables and rotate any exposed credential.');
  }
  for (const f of cppFiles) {
    const c=f.content, base=f.path;
    if (/\bgets\s*\(/.test(c)) add('High','C/C++ security review','Unsafe gets() call detected',base,lineOf(c,/\bgets\s*\(/),'gets() cannot limit input length and is unsafe; it was removed from modern C standards.','Use a bounded input method such as fgets or std::getline as appropriate.');
    if (/\bstrcpy\s*\(/.test(c)) add('Medium','C/C++ security review','strcpy() use needs bounds review',base,lineOf(c,/\bstrcpy\s*\(/),'strcpy() does not know the destination buffer size and can overflow it.','Verify buffer sizing and consider safer bounded alternatives or std::string.');
    if (/\b(?:sprintf|vsprintf)\s*\(/.test(c)) add('Medium','C/C++ security review','Unbounded formatting call detected',base,lineOf(c,/\b(?:sprintf|vsprintf)\s*\(/),'Unbounded formatting can overflow a destination buffer if output exceeds its capacity.','Use a bounded formatting approach and verify truncation/error handling.');
    if (/\b(?:system|popen)\s*\(/.test(c)) add('Medium','C/C++ security review','Shell execution call needs review',base,lineOf(c,/\b(?:system|popen)\s*\(/),'Shell execution can create command-injection risk if arguments include untrusted input.','Trace input sources and prefer APIs that pass arguments without invoking a shell.');
    if (/\b(?:TODO|FIXME|XXX)\b/.test(c)) add('Info','Code maintenance','Developer note detected',base,lineOf(c,/\b(?:TODO|FIXME|XXX)\b/),'A TODO/FIXME marker may indicate unfinished work; it is not automatically a defect.','Review the note before release and close it or track it in an issue list.');
  }

  if (!files.length) add('Medium','Project scan','No supported source files found','(project folder)',null,
    'No files with supported frontend extensions were found within the scan limits.',
    'Choose the project root containing your source files. Generated folders such as node_modules and dist are skipped intentionally.');
  const priority={High:0,Medium:1,Low:2,Info:3};
  findings.sort((a,b)=>priority[a.severity]-priority[b.severity] || a.file.localeCompare(b.file));
  const detected = [];
  if (htmlFiles.length) detected.push('HTML');
  if (pythonFiles.length) detected.push('Python (heuristic checks)');
  if (cppFiles.length) detected.push('C/C++ (heuristic checks)');
  if (cssFiles.length) detected.push('CSS');
  if (jsFiles.some(f=>/\.(jsx|tsx)$/i.test(f.path)) || (pkg && pkg.dependencies && pkg.dependencies.react)) detected.push('React/JSX');
  if (jsFiles.some(f=>/\.tsx?$/i.test(f.path))) detected.push('TypeScript');
  if (jsFiles.some(f=>/\.vue$/i.test(f.path)) || (pkg && pkg.dependencies && pkg.dependencies.vue)) detected.push('Vue');
  if (jsFiles.some(f=>/\.svelte$/i.test(f.path)) || (pkg && pkg.dependencies && pkg.dependencies.svelte)) detected.push('Svelte');
  if (pkg && pkg.dependencies && pkg.dependencies.next) detected.push('Next.js');
  return {findings, stacks:[...new Set(detected)]};
}

function safeJSON(s){try{return JSON.parse(s)}catch{return null}}
function lineOf(content, needle, startAt=0) {
  if (needle instanceof RegExp) { const m=needle.exec(content); if(!m)return null; startAt=m.index; }
  else if (typeof needle === 'string' && startAt===0) { const i=content.indexOf(needle); if(i<0)return null; startAt=i; }
  return content.slice(0,Math.max(0,startAt)).split(/\r?\n/).length;
}
function escapeRegex(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
function updateSummary(data) {
  $('fileCount').textContent=data.fileCount;
  $('issueCount').textContent=data.findings.length;
  $('highCount').textContent=data.findings.filter(x=>x.severity==='High').length;
  $('stackCount').textContent=data.stacks.length || '—';
  $('resultCaption').textContent=`${data.findings.length} finding(s) · ${data.stacks.length ? data.stacks.join(', ') : 'No framework detected'}`;
}
function updateMission(data) {
  const counts = {
    High: data.findings.filter(x => x.severity === 'High').length,
    Medium: data.findings.filter(x => x.severity === 'Medium').length,
    Low: data.findings.filter(x => x.severity === 'Low').length,
    Info: data.findings.filter(x => x.severity === 'Info').length
  };
  const score = Math.min(100, counts.High * 25 + counts.Medium * 10 + counts.Low * 4 + counts.Info * 1);
  const label = score >= 65 ? 'SEVERE' : score >= 35 ? 'ELEVATED' : score >= 12 ? 'GUARDED' : 'LOW';
  $('threatLabel').textContent = label;
  $('threatScore').textContent = score;
  $('threatHint').textContent = score >= 65 ? 'Prioritise high-impact clues first.' : score >= 35 ? 'Several clues need detective review.' : score >= 12 ? 'Review the evidence and verify each clue.' : 'Few pattern matches. This does not mean bug-free.';
  $('threatFill').style.width = score + '%';
  $('threatFill').parentElement.setAttribute('aria-valuenow', String(score));
  $('threatFill').parentElement.dataset.level = label.toLowerCase();
  $('missionStatus').textContent = data.findings.length ? 'Evidence collected · Review recommended' : 'No pattern matches · Keep investigating';
  const panel = $('missionComplete');
  panel.hidden = false;
  $('caseNumber').textContent = String(Date.now()).slice(-3);
  $('missionTitle').textContent = score >= 65 ? 'Gotham needs you, Dark Knight.' : 'Mission complete, Dark Knight.';
  $('missionMessage').textContent = `${data.fileCount} files investigated. ${data.findings.length} potential clue(s) collected. Verify the evidence before making changes.`;
}

function showMissionReport(data) {
  const caseNumber = $('caseNumber').textContent;
  $('overlayCaseNumber').textContent = caseNumber;
  $('overlayFileCount').textContent = data.fileCount;
  $('overlayIssueCount').textContent = data.findings.length;
  $('overlayHighCount').textContent = data.findings.filter(x => x.severity === 'High').length;
  $('overlayMissionMessage').textContent = data.findings.length
    ? `${data.findings.length} potential clue(s) collected across ${data.fileCount} file(s). Verify each finding before making changes.`
    : `No pattern matches were found across ${data.fileCount} file(s). Keep investigating with your framework's own tests and lint tools.`;
  $('missionOverlay').hidden = false;
  $('returnToBoardBtn').focus();
}

function closeMissionReport() {
  $('missionOverlay').hidden = true;
  $('dashboardMain').scrollIntoView({behavior: 'smooth', block: 'start'});
  $('scanBtn').focus();
}

function renderFindings() {
  const host=$('findings'); host.replaceChildren();
  if(!latest) return;
  const filter=$('severityFilter').value;
  const rows=latest.findings.filter(x=>filter==='all'||x.severity===filter);
  if(!rows.length){
    const div=document.createElement('div'); div.className='empty-state';
    const strong=document.createElement('strong'); strong.textContent=filter==='all'?'No findings from the current checks':'No findings for this severity';
    const p=document.createElement('p'); p.textContent='This is not a guarantee that the project is bug-free. Run your framework linter, tests, and browser checks for deeper coverage.';
    div.append(strong,p); host.append(div); return;
  }
  for(const item of rows) {
    const row=document.createElement('article'); row.className='finding'; row.dataset.severity=item.severity.toLowerCase(); row.tabIndex=0; row.setAttribute('role','button'); row.setAttribute('aria-label','Inspect finding: '+item.title); row.addEventListener('click',()=>showFindingDetails(item)); row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();showFindingDetails(item);}});
    const sev=document.createElement('span'); sev.className='severity '+item.severity; sev.textContent=item.severity;
    const body=document.createElement('div');
    const h=document.createElement('h4'); h.textContent=item.title;
    const p=document.createElement('p'); p.textContent=item.detail;
    const loc=document.createElement('div'); loc.className='location'; loc.textContent=item.file+(item.line?':'+item.line:'');
    const fix=document.createElement('div'); fix.className='fix'; const b=document.createElement('b'); b.textContent='Suggested next step: '; fix.append(b,document.createTextNode(item.fix));
    body.append(h,p,loc,fix);
    const tag=document.createElement('span'); tag.className='tag'; tag.textContent=item.category;
    row.append(sev,body,tag); host.append(row);
  }
}
function showFindingDetails(item) {
  selectedFindingIndex = latest ? latest.findings.indexOf(item) : null;
  const panel = $('findingDetails');
  if (!panel || !latest) return;
  panel.hidden = false;
  $('detailTitle').textContent = item.title;
  $('detailSeverity').textContent = item.severity;
  $('detailCategory').textContent = item.category;
  $('detailLocation').textContent = item.file + (item.line ? ':' + item.line : '');
  $('detailWhy').textContent = item.detail;
  $('detailFix').textContent = item.fix;
  const content = latest.fileContents && latest.fileContents[item.file];
  const lines = typeof content === 'string' ? content.split(/\r?\n/) : [];
  if (item.line && lines.length) {
    const start = Math.max(1, item.line - 2), end = Math.min(lines.length, item.line + 2);
    $('detailSource').textContent = lines.slice(start - 1, end).map((line, i) => String(start + i).padStart(4, ' ') + '  ' + line).join('\n');
  } else $('detailSource').textContent = 'Source excerpt is not available for this finding. Open the file location above to inspect it manually.';
  panel.scrollIntoView({behavior:'smooth', block:'nearest'});
}
function renderCaseHistory() {
  const host = $('caseHistory'); if (!host) return;
  host.replaceChildren();
  if (!caseHistory.length) { host.textContent = 'Completed scans will appear here during this session.'; return; }
  caseHistory.forEach(entry => {
    const row = document.createElement('div'); row.className = 'history-row';
    const strong = document.createElement('strong'); strong.textContent = 'CASE ' + entry.caseNumber + ' · ' + entry.findings + ' clues';
    const small = document.createElement('small'); small.textContent = entry.root + ' · ' + entry.files + ' files · ' + entry.time;
    row.append(strong, small); host.append(row);
  });
}
async function copySelectedFix() {
  const text = $('detailFix').textContent;
  try { await navigator.clipboard.writeText(text); $('copyFixBtn').textContent = 'Copied ✓'; }
  catch { $('detailFix').textContent = text + '\n\n(Clipboard access unavailable; select and copy this text manually.)'; }
}
$('copyFixBtn').addEventListener('click', copySelectedFix);
$('closeDetailsBtn').addEventListener('click', () => { $('findingDetails').hidden = true; });

function makeReport() {
  if(!latest) return '';
  const lines=['GOTHAM FRONTEND COMMAND — CASE FILE','='.repeat(38),`Project: ${latest.root}`,`Files scanned: ${latest.fileCount}`,`Findings: ${latest.findings.length}`,`Detected: ${latest.stacks.join(', ')||'No framework detected'}`,'','IMPORTANT: Static pattern checks can produce false positives and miss issues. Review findings before changing code.',''];
  lines.push('', 'CASE NOTE: Findings are heuristic clues, not confirmed defects. Verify before changing source code.', '');
  latest.findings.forEach((x,i)=>lines.push(`CLUE ${String(i+1).padStart(3,'0')} · [${x.severity}] ${x.title}`,`   Category: ${x.category}`,`   Location: ${x.file}${x.line?':'+x.line:''}`,`   Why: ${x.detail}`,`   Suggested next step: ${x.fix}`,''));
  return lines.join('\n');
}
async function exportReport() {
  if(!latest)return;
  try { const blob=new Blob([makeReport()],{type:'text/plain;charset=utf-8'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`Gotham-Case-${$('caseNumber').textContent || 'report'}.txt`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); $('statusText').textContent='Report downloaded.'; } catch(e){showError(e.message)}
}
function showError(message) {
  $('statusText').textContent='Error: '+message;
  const host=$('findings'); host.replaceChildren();
  const div=document.createElement('div'); div.className='empty-state';
  const strong=document.createElement('strong'); strong.textContent='We could not complete the scan';
  const p=document.createElement('p'); p.textContent=message||'An unexpected error occurred.';
  div.append(strong,p); host.append(div);
}
