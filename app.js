const API_ROOT = "https://api.github.com";
const FILE_LIMIT = 48;
const FILE_SIZE_LIMIT = 180000;
const form = document.querySelector("#analyze-form");
const input = document.querySelector("#repo-url");
const button = document.querySelector("#analyze-button");
const statusMessage = document.querySelector("#status");
const results = document.querySelector("#results");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusMessage.textContent = "";
  const repo = parseRepositoryUrl(input.value);

  if (!repo) {
    statusMessage.textContent = "Enter a valid public GitHub repository URL, such as https://github.com/owner/repo.";
    input.focus();
    return;
  }

  setLoading(true);
  results.hidden = true;
  try {
    const report = await analyzeRepository(repo);
    renderReport(report);
    results.hidden = false;
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    statusMessage.textContent = error.message;
  } finally {
    setLoading(false);
  }
});

document.querySelector("#new-analysis").addEventListener("click", () => {
  results.hidden = true;
  input.focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

function parseRepositoryUrl(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const owner = segments[0];
    const repository = segments[1].replace(/\.git$/i, "");
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repository)) return null;
    return { owner, repository };
  } catch {
    return null;
  }
}

async function analyzeRepository({ owner, repository }) {
  const endpoint = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const repoResponse = await githubFetch(endpoint);
  const repoInfo = await repoResponse.json();
  if (!repoResponse.ok) throw githubError(repoResponse, repoInfo);

  if (repoInfo.private) throw new Error("This repository is private. RepoLens can only scan public repositories.");
  const treeResponse = await githubFetch(`${endpoint}/git/trees/${encodeURIComponent(repoInfo.default_branch)}?recursive=1`);
  const tree = await treeResponse.json();
  if (!treeResponse.ok) throw githubError(treeResponse, tree);

  const files = tree.tree.filter((item) => item.type === "blob" && item.size <= FILE_SIZE_LIMIT);
  const candidates = selectFiles(files);
  const selected = candidates.slice(0, FILE_LIMIT);
  if (selected.length === 0) throw new Error("No suitable text or configuration files were found in this repository.");

  statusMessage.textContent = `Scanning ${selected.length} of ${candidates.length} eligible files…`;
  const contents = await fetchBlobs(endpoint, selected);
  return buildReport(repoInfo, files, contents, candidates.length, tree.truncated);
}

async function githubFetch(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  return response;
}

function githubError(response, body) {
  if (response.status === 404) return new Error("Repository not found, or it is not publicly accessible.");
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    return new Error("GitHub's unauthenticated API limit has been reached. Please try again later.");
  }
  if (response.status === 403) return new Error("GitHub denied this request. The public API may be temporarily rate-limited.");
  return new Error(body.message || `GitHub returned an error (${response.status}).`);
}

function selectFiles(files) {
  const priority = (path) => {
    const name = path.toLowerCase();
    if (/^(security\.md|readme(?:\.[^/]*)?|license(?:\.[^/]*)?|\.github\/dependabot\.yml|renovate\.json|\.github\/workflows\/[^/]+)$/.test(name)) return 0;
    if (/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|pyproject\.toml|requirements[^/]*\.txt|cargo\.toml|cargo\.lock|go\.mod|go\.sum|composer\.json|composer\.lock|gemfile|gemfile\.lock|pom\.xml|build\.gradle|gradle\.lockfile|dockerfile)$/.test(name)) return 1;
    if (/(^|\/)(test|tests|spec|specs)(\/|$)|(\.test\.|\.spec\.)/.test(name)) return 2;
    if (/\.(js|jsx|ts|tsx|py|go|rs|java|rb|php|cs|c|cc|cpp|h|hpp|sh|yml|yaml|toml|tf)$/.test(name)) return 3;
    return 10;
  };
  return files
    .map((file) => ({ ...file, priority: priority(file.path) }))
    .filter((file) => file.priority < 10)
    .sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
}

async function fetchBlobs(endpoint, files) {
  const contents = [];
  for (let i = 0; i < files.length; i += 6) {
    const batch = files.slice(i, i + 6);
    const responses = await Promise.all(batch.map(async (file) => {
      const response = await githubFetch(`${endpoint}/git/blobs/${file.sha}`);
      const blob = await response.json();
      if (!response.ok) throw githubError(response, blob);
      if (!blob.content || blob.encoding !== "base64") {
        throw new Error(`GitHub did not return readable file contents for ${file.path}.`);
      }
      try {
        const binary = atob(blob.content.replace(/\s/g, ""));
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return { path: file.path, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
      } catch (error) {
        throw new Error(`Could not decode ${file.path}: ${error.message}`);
      }
    }));
    contents.push(...responses);
  }
  return contents;
}

function buildReport(repo, files, contents, eligibleCount, treeTruncated) {
  const paths = new Set(files.map((file) => file.path.toLowerCase()));
  const scanned = contents.map(({ path, text }) => ({ path, text, lower: path.toLowerCase() }));
  const findings = [];
  const checks = [];
  const addFinding = (severity, title, detail, path = "") => findings.push({ severity, title, detail, path });
  const hasPath = (matcher) => [...paths].some((path) => matcher.test(path));

  const securityPolicy = hasPath(/(^|\/)security\.md$/);
  if (!securityPolicy) addFinding("medium", "No security policy found", "A SECURITY.md file helps users report vulnerabilities and understand how security issues are handled.");
  checks.push({ label: "Security policy", pass: securityPolicy });

  const dependencyConfig = hasPath(/(^|\/)(\.github\/dependabot\.yml|renovate\.json)$/);
  if (!dependencyConfig) addFinding("medium", "Automated dependency updates not detected", "No Dependabot or Renovate configuration was found in the repository file tree.");
  checks.push({ label: "Dependency update bot", pass: dependencyConfig });

  const hasManifest = hasPath(/(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|cargo\.toml|go\.mod|composer\.json|gemfile|pom\.xml|build\.gradle)$/);
  const hasLockfile = hasPath(/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|cargo\.lock|go\.sum|composer\.lock|gemfile\.lock|gradle\.lockfile)$/);
  if (hasManifest && !hasLockfile) addFinding("medium", "No dependency lockfile detected", "A lockfile helps reproduce dependency versions consistently. Some libraries intentionally omit one.");
  checks.push({ label: "Dependency lockfile", pass: !hasManifest || hasLockfile });

  const workflowFiles = scanned.filter((file) => file.lower.startsWith(".github/workflows/") && /\.(yml|yaml)$/.test(file.lower));
  if (workflowFiles.length === 0) {
    addFinding("low", "No GitHub Actions workflow found", "Automated CI can catch regressions and run security checks before changes are merged.");
  } else {
    const workflowText = workflowFiles.map((file) => file.text).join("\n");
    if (!/^\s*permissions\s*:/m.test(workflowText)) {
      addFinding("medium", "Workflow permissions are not explicitly scoped", "Set top-level or job-level GITHUB_TOKEN permissions to the minimum required.", ".github/workflows/");
    }
    if (/\bpull_request_target\b/.test(workflowText)) {
      addFinding("high", "Review pull_request_target workflow usage", "This event runs with elevated repository context. Ensure untrusted pull-request code is never checked out or executed.", ".github/workflows/");
    }
    const uses = [...workflowText.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
    if (uses.some((action) => !/@[a-f0-9]{40}$/i.test(action))) {
      addFinding("medium", "Some GitHub Actions are not pinned to a full commit SHA", "Pin actions to a verified full-length commit SHA to reduce the risk of mutable tag changes.", ".github/workflows/");
    }
  }
  checks.push({ label: "CI workflow", pass: workflowFiles.length > 0 });

  const testsFound = hasPath(/(^|\/)(test|tests|spec|specs)(\/|$)|\.(test|spec)\.[^/]+$/);
  if (!testsFound) addFinding("low", "Automated tests not detected", "No conventional test directory or .test./.spec. file was found in the repository tree.");
  checks.push({ label: "Test files", pass: testsFound });

  const readmeFound = hasPath(/(^|\/)readme(?:\.[^/]*)?$/);
  if (!readmeFound) addFinding("low", "No README found", "A README makes setup, usage, and project expectations easier to understand.");
  checks.push({ label: "Project documentation", pass: readmeFound });

  const licenseFound = hasPath(/(^|\/)license(?:\.[^/]*)?$/);
  if (!licenseFound) addFinding("low", "No license file found", "Without a license, other people may not know what permissions they have to use or modify this project.");
  checks.push({ label: "License", pass: licenseFound });

  const patterns = [
    { regex: /\beval\s*\(/g, severity: "high", title: "Dynamic code evaluation detected", detail: "eval() can turn untrusted input into executable code. Confirm the input is trusted or replace dynamic evaluation.", weight: 1.2 },
    { regex: /\bnew\s+Function\s*\(/g, severity: "medium", title: "Dynamic function construction detected", detail: "The Function constructor dynamically executes code and may create injection risks.", weight: 0.6 },
    { regex: /\binnerHTML\s*=/g, severity: "medium", title: "Direct HTML injection sink detected", detail: "Assigning untrusted content to innerHTML can enable cross-site scripting. Prefer textContent or sanitize trusted markup.", weight: 0.7 },
    { regex: /\brejectUnauthorized\s*:\s*false\b/g, severity: "high", title: "TLS certificate validation appears disabled", detail: "Disabling certificate verification can expose connections to interception.", weight: 1.2 },
    { regex: /\bverify\s*=\s*False\b/g, severity: "medium", title: "TLS verification may be disabled", detail: "A request with verify=False skips certificate validation and can expose connections to interception.", weight: 0.7 },
    { regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, severity: "critical", title: "Private key material detected", detail: "A private-key header was found in a scanned file. Treat it as exposed and rotate it if it is real.", weight: 2.2 },
    { regex: /\b(?:api[_-]?key|secret|access[_-]?token|password)\s*[:=]\s*["'][A-Za-z0-9_\/+=.-]{20,}["']/gi, severity: "high", title: "Possible hard-coded credential detected", detail: "A credential-like assignment was found. The value is not displayed; verify it and rotate it if it is real.", weight: 1.5 }
  ];

  const matchesPerRule = new Map();
  for (const file of scanned) {
    const content = file.text.slice(0, FILE_SIZE_LIMIT);
    for (const rule of patterns) {
      rule.regex.lastIndex = 0;
      if (rule.regex.test(content)) {
        const key = `${rule.title}:${file.path}`;
        if (!matchesPerRule.has(key)) {
          matchesPerRule.set(key, true);
          addFinding(rule.severity, rule.title, rule.detail, file.path);
          rule.detected = true;
        }
      }
    }
  }

  const deductions = findings.reduce((total, finding) => {
    const rule = patterns.find((item) => item.title === finding.title);
    if (rule) return total + rule.weight;
    return total + ({ critical: 2, high: 1.3, medium: 0.65, low: 0.25 }[finding.severity] || 0.4);
  }, 0);
  const score = Math.max(0, Math.min(10, Math.round((10 - deductions) * 10) / 10));
  const scoreTitle = score >= 8.5 ? "Strong signals" : score >= 6.5 ? "A good foundation" : score >= 4 ? "Room to improve" : "Needs attention";
  const scoreSummary = score >= 8.5
    ? "Good practices showed up in this scan. Keep reviewing changes and dependencies."
    : score >= 6.5
      ? "Several good signals are present, with a few worthwhile gaps to address."
      : score >= 4
        ? "This scan found gaps that could make the project harder to maintain or secure."
        : "Multiple risk indicators or missing safeguards deserve prompt review.";

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.title.localeCompare(b.title));
  return {
    repo, score, scoreTitle, scoreSummary, findings, checks,
    scannedCount: contents.length,
    eligibleCount,
    treeTruncated,
    language: repo.language || "Not specified",
    stars: repo.stargazers_count,
    branch: repo.default_branch,
    description: repo.description || ""
  };
}

function severityRank(severity) {
  return ({ critical: 0, high: 1, medium: 2, low: 3 })[severity] ?? 4;
}

function renderReport(report) {
  const fullName = report.repo.full_name || `${report.repo.owner.login}/${report.repo.name}`;
  document.querySelector("#repo-name").textContent = fullName;
  const repoLink = document.querySelector("#repo-link");
  repoLink.href = report.repo.html_url;
  repoLink.textContent = report.repo.html_url.replace(/^https:\/\//, "");
  document.querySelector("#score-value").textContent = report.score.toFixed(1);
  document.querySelector("#score-title").textContent = report.scoreTitle;
  document.querySelector("#score-summary").textContent = report.scoreSummary;
  document.querySelector("#score-ring").style.setProperty("--progress", `${report.score * 36}deg`);
  document.querySelector("#repo-stats").replaceChildren(
    stat("LANGUAGE", report.language),
    stat("STARS", Number(report.stars).toLocaleString()),
    stat("DEFAULT BRANCH", report.branch),
    stat("FILES SCANNED", `${report.scannedCount}/${report.eligibleCount}`)
  );
  const checkList = document.querySelector("#check-list");
  checkList.replaceChildren(...report.checks.map((check) => {
    const row = document.createElement("div");
    row.className = "check-row";
    const icon = document.createElement("span");
    icon.className = `check-icon${check.pass ? "" : " warn"}`;
    icon.textContent = check.pass ? "✓" : "–";
    const label = document.createElement("span");
    label.textContent = check.label;
    row.append(icon, label);
    return row;
  }));
  const findings = document.querySelector("#findings");
  document.querySelector("#finding-count").textContent = report.findings.length;
  if (report.findings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-findings";
    empty.textContent = "No review signals were found in the sampled files. This is not proof that the repository is free of issues.";
    findings.replaceChildren(empty);
  } else {
    findings.replaceChildren(...report.findings.map(createFinding));
  }
  statusMessage.textContent = `Scan complete · ${report.scannedCount} files reviewed${report.eligibleCount > report.scannedCount ? ` (${report.eligibleCount} sampled)` : ""}.${report.treeTruncated ? " GitHub returned a partial file tree." : ""}`;
}

function stat(label, value) {
  const item = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = `${label} `;
  item.append(strong, document.createTextNode(value));
  return item;
}

function createFinding(finding) {
  const article = document.createElement("article");
  article.className = `finding severity-${finding.severity}`;
  const dot = document.createElement("span");
  dot.className = "severity-dot";
  dot.setAttribute("aria-hidden", "true");
  const body = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = finding.title;
  const detail = document.createElement("p");
  detail.textContent = finding.detail;
  body.append(title, detail);
  if (finding.path) {
    const file = document.createElement("div");
    file.className = "finding-path";
    file.textContent = finding.path;
    body.append(file);
  }
  const severity = document.createElement("span");
  severity.className = "severity-label";
  severity.textContent = finding.severity;
  article.append(dot, body, severity);
  return article;
}

function setLoading(loading) {
  button.disabled = loading;
  button.querySelector("span:first-child").textContent = loading ? "Analyzing…" : "Analyze repo";
  if (loading) statusMessage.textContent = "Connecting to GitHub…";
}
