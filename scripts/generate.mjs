// Regenerates the SVG panels in assets/ and the stats block in README.md
// from commit history. Runs daily in .github/workflows/update-profile.yml.
//
// This repo is public and so are its Action logs: never print a repository
// name, commit message or raw API error from here. Private projects are
// identified only by numeric repo id in profile.config.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(path.join(ROOT, "profile.config.json"), "utf8"));
const TOKEN = process.env.PROFILE_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

const WEEKS = 12;
const DAYS = WEEKS * 7;
const RECENT = 30;

function fail(message) {
  console.error(`generate: ${message}`);
  process.exit(1);
}

if (!TOKEN) fail("no token. Set the PROFILE_TOKEN repository secret.");

// ---------------------------------------------------------------- data

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${TOKEN}`, "content-type": "application/json", "user-agent": "profile-generator" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) fail(`GitHub API returned HTTP ${res.status}.`);
  const body = await res.json();
  if (body.errors?.length) fail(`GitHub API query failed (${body.errors[0].type ?? "error"}).`);
  return body.data;
}

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone });
const dayKey = (date) => dayFmt.format(date);
const shiftDay = (key, delta) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

const today = dayKey(new Date());
const days = Array.from({ length: DAYS }, (_, i) => shiftDay(today, i - (DAYS - 1)));
const dayIndex = new Map(days.map((d, i) => [d, i]));
const since = new Date(Date.now() - (DAYS + 2) * 86400000).toISOString();

const { user } = await gql(
  `query($login: String!) {
    user(login: $login) {
      id
      repositories(first: 100, isFork: false,
        affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
        ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
        orderBy: { field: PUSHED_AT, direction: DESC }) {
        nodes {
          databaseId name pushedAt owner { login }
          languages(first: 8, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } }
        }
      }
    }
  }`,
  { login: config.login },
);

// The profile repo itself is not project work.
const repos = user.repositories.nodes.filter((r) => !(r.owner.login === config.login && r.name === config.login));
const visible = new Set(repos.map((r) => r.databaseId));
const missing = config.projects.filter((p) => !visible.has(p.repoId));
if (missing.length) {
  fail(
    `${missing.length} configured project(s) are not readable with this token ` +
      `(${missing.map((p) => p.slug).join(", ")}). Panels left unchanged.`,
  );
}

async function commitDays(repo) {
  const counts = new Array(DAYS).fill(0);
  let cursor = null;
  do {
    const data = await gql(
      `query($owner: String!, $name: String!, $author: ID!, $since: GitTimestamp!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef { target { ... on Commit {
            history(first: 100, after: $cursor, since: $since, author: { id: $author }) {
              pageInfo { hasNextPage endCursor }
              nodes { committedDate }
            }
          } } }
        }
      }`,
      { owner: repo.owner.login, name: repo.name, author: user.id, since, cursor },
    );
    const history = data.repository?.defaultBranchRef?.target?.history;
    if (!history) break;
    for (const node of history.nodes) {
      const i = dayIndex.get(dayKey(new Date(node.committedDate)));
      if (i !== undefined) counts[i] += 1;
    }
    cursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
  } while (cursor);
  return counts;
}

const sum = (list) => list.reduce((a, b) => a + b, 0);
const weekly = (counts) => Array.from({ length: WEEKS }, (_, w) => sum(counts.slice(w * 7, w * 7 + 7)));

const active = [];
for (const repo of repos.filter((r) => r.pushedAt >= since)) {
  const counts = await commitDays(repo);
  if (sum(counts) > 0) active.push({ repo, counts });
}

const total = new Array(DAYS).fill(0);
for (const { counts } of active) counts.forEach((c, i) => (total[i] += c));

const recent = total.slice(-RECENT);
const stats = {
  commits30: sum(recent),
  activeDays30: recent.filter((c) => c > 0).length,
  projects30: active.filter(({ counts }) => sum(counts.slice(-RECENT)) > 0).length,
  weeks: weekly(total),
  recent,
};

const langBytes = new Map();
for (const { repo } of active) {
  for (const edge of repo.languages.edges) langBytes.set(edge.node.name, (langBytes.get(edge.node.name) ?? 0) + edge.size);
}
const langTotal = sum([...langBytes.values()]) || 1;
const ranked = [...langBytes.entries()].sort((a, b) => b[1] - a[1]).map(([name, size]) => ({ name, share: size / langTotal }));
const languages = ranked.slice(0, 3).filter((l) => l.share >= 0.01);
const otherShare = 1 - sum(languages.map((l) => l.share));
if (otherShare >= 0.005) languages.push({ name: "Other", share: otherShare, other: true });

const projects = config.projects.map((project) => {
  const counts = active.find(({ repo }) => repo.databaseId === project.repoId)?.counts ?? new Array(DAYS).fill(0);
  const last = counts.findLastIndex((c) => c > 0);
  return { ...project, commits30: sum(counts.slice(-RECENT)), weeks: weekly(counts), lastDay: last === -1 ? null : days[last] };
});

// ---------------------------------------------------------------- drawing

const THEMES = {
  light: {
    surface: "#ffffff", border: "#d1d9e0", ink: "#1f2328", ink2: "#59636e", muted: "#6e7781", grid: "#e6e8eb", axis: "#c3c9d0",
    series: ["#2a78d6", "#eb6834", "#1baf7a"], other: "#a8b0b9", empty: "#eceef1",
    ramp: ["#9ec5f4", "#5598e7", "#2a78d6", "#184f95"], more: "darker", good: "#0ca30c",
  },
  dark: {
    surface: "#0d1117", border: "#3d444d", ink: "#f0f6fc", ink2: "#9198a1", muted: "#8b949e", grid: "#21262d", axis: "#3d444d",
    series: ["#3987e5", "#d95926", "#199e70"], other: "#656c76", empty: "#1c2128",
    ramp: ["#184f95", "#256abf", "#3987e5", "#86b6ef"], more: "brighter", good: "#0ca30c",
  },
};

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const TILE_W = 408;
const PAD = 20;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n) => n.toLocaleString("en-IN");
const r1 = (n) => Math.round(n * 10) / 10;
const pct = (share) => (share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (key) => `${Number(key.slice(8))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`;
const longDate = (key) => `${shortDate(key)} ${key.slice(0, 4)}`;

function wrap(text, fontSize, width, maxLines) {
  const limit = Math.floor(width / (fontSize * 0.5));
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > limit) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[\s,.;:]+\S*$/, "") + "…";
  }
  return lines;
}

// Column with a rounded data end and a square foot on the baseline.
function column(x, base, w, h, r) {
  const rr = Math.min(r, h, w / 2);
  const top = base - h;
  return `M${r1(x)} ${r1(base)}V${r1(top + rr)}Q${r1(x)} ${r1(top)} ${r1(x + rr)} ${r1(top)}H${r1(x + w - rr)}Q${r1(x + w)} ${r1(top)} ${r1(x + w)} ${r1(top + rr)}V${r1(base)}Z`;
}

function niceMax(value) {
  if (value <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 4, 5, 10]) if (step * pow >= value) return step * pow;
  return 10 * pow;
}

function frame(t, width, height, label, body, extraCss = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
<style>
text{font-family:${FONT};fill:${t.ink}}
.s{fill:${t.ink2}}.m{fill:${t.muted}}.b{font-weight:600}
.grow{transform-box:fill-box;transform-origin:50% 100%;animation:grow .8s cubic-bezier(.2,.8,.2,1) both}
.fade{animation:fade .7s ease-out both}
@keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes fade{from{opacity:0}to{opacity:1}}
${extraCss}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="10" fill="${t.surface}" stroke="${t.border}"/>
${body}
</svg>
`;
}

function commitsTile(t) {
  const H = 232;
  const left = PAD + 30;
  const right = TILE_W - PAD;
  const top = 108;
  const base = 192;
  const max = niceMax(Math.max(...stats.weeks));
  const band = (right - left) / WEEKS;
  const barW = Math.min(20, band - 6);
  const y = (v) => base - (v / max) * (base - top);
  const peak = stats.weeks.indexOf(Math.max(...stats.weeks));

  let body = `<text x="${PAD}" y="33" font-size="13" class="s">Commits, last ${RECENT} days</text>
<text x="${PAD}" y="76" font-size="38" class="b">${num(stats.commits30)}</text>
<text x="${right}" y="33" font-size="12" class="m" text-anchor="end">per week, last ${WEEKS} weeks</text>`;
  for (const tick of [max / 2, max]) {
    body += `\n<line x1="${left}" x2="${right}" y1="${r1(y(tick))}" y2="${r1(y(tick))}" stroke="${t.grid}"/>
<text x="${left - 8}" y="${r1(y(tick) + 4)}" font-size="11" class="m" text-anchor="end">${num(tick)}</text>`;
  }
  stats.weeks.forEach((value, i) => {
    if (!value) return;
    const x = left + i * band + (band - barW) / 2;
    const h = Math.max(2, (value / max) * (base - top));
    body += `\n<path class="grow" style="animation-delay:${i * 45}ms" d="${column(x, base, barW, h, 4)}" fill="${t.series[0]}"/>`;
    if (i === peak) {
      body += `\n<text class="fade b" style="animation-delay:700ms" x="${r1(x + barW / 2)}" y="${r1(base - h - 6)}" font-size="11" text-anchor="middle">${num(value)}</text>`;
    }
  });
  body += `\n<line x1="${left}" x2="${right}" y1="${base}" y2="${base}" stroke="${t.axis}"/>
<text x="${left}" y="${base + 18}" font-size="11" class="m">${shortDate(days[0])}</text>
<text x="${right}" y="${base + 18}" font-size="11" class="m" text-anchor="end">${shortDate(today)}</text>`;
  return frame(t, TILE_W, H, `${num(stats.commits30)} commits in the last ${RECENT} days`, body);
}

function rhythmTile(t) {
  const H = 232;
  const right = TILE_W - PAD;
  const cell = 10;
  const gap = (right - PAD - cell * RECENT) / (RECENT - 1);
  const peak = Math.max(1, ...stats.recent);
  const shade = (count) => t.ramp[Math.min(3, Math.floor(((count - 1) / peak) * 4))];

  let body = `<text x="${PAD}" y="33" font-size="13" class="s">Active days, last ${RECENT} days</text>
<text x="${PAD}" y="76" font-size="38" class="b">${stats.activeDays30}<tspan font-size="15" font-weight="400" class="s" dx="8">of ${RECENT}</tspan></text>`;
  stats.recent.forEach((count, i) => {
    const x = PAD + i * (cell + gap);
    body += `\n<rect class="fade" style="animation-delay:${i * 20}ms" x="${r1(x)}" y="94" width="${cell}" height="22" rx="2" fill="${count ? shade(count) : t.empty}"/>`;
  });
  body += `\n<text x="${PAD}" y="134" font-size="11" class="m">One cell per day, ${t.more} means more commits</text>
<text x="${right}" y="134" font-size="11" class="m" text-anchor="end">${shortDate(today)}</text>
<text x="${PAD}" y="168" font-size="13" class="s">Languages in active projects</text>`;

  const barY = 180;
  const full = right - PAD;
  const usable = full - 2 * (languages.length - 1);
  let x = PAD;
  let legendX = PAD;
  languages.forEach((lang, i) => {
    const color = lang.other ? t.other : t.series[i];
    const w = Math.max(3, lang.share * usable);
    body += `\n<rect x="${r1(x)}" y="${barY}" width="${r1(w)}" height="10" rx="2" fill="${color}"/>`;
    x += w + 2;
    const label = `${lang.name} ${pct(lang.share)}`;
    body += `\n<rect x="${r1(legendX)}" y="204" width="10" height="10" rx="2" fill="${color}"/>
<text x="${r1(legendX + 16)}" y="213" font-size="12" class="s">${esc(label)}</text>`;
    legendX += 16 + label.length * 6.6 + 16;
  });
  return frame(t, TILE_W, H, `Active on ${stats.activeDays30} of the last ${RECENT} days`, body);
}

function projectTile(t, project) {
  const H = 212;
  const right = TILE_W - PAD;
  const inner = right - PAD;
  let body = `<text x="${PAD}" y="36" font-size="17" class="b">${esc(project.title)}</text>
<text x="${PAD}" y="57" font-size="12" class="m">${esc(project.context)}</text>`;
  wrap(project.summary, 13, inner, 3).forEach((line, i) => {
    body += `\n<text x="${PAD}" y="${82 + i * 18}" font-size="13" class="s">${esc(line)}</text>`;
  });
  body += `\n<text x="${PAD}" y="146" font-size="12" class="m">${esc(project.stack)}</text>
<line x1="${PAD}" x2="${right}" y1="160" y2="160" stroke="${t.grid}"/>`;

  const base = 196;
  const max = Math.max(1, ...project.weeks);
  project.weeks.forEach((value, i) => {
    const x = PAD + i * 9;
    if (!value) {
      body += `\n<rect x="${x}" y="${base - 2}" width="7" height="2" fill="${t.empty}"/>`;
      return;
    }
    const h = Math.max(3, (value / max) * 24);
    body += `\n<path class="grow" style="animation-delay:${i * 40}ms" d="${column(x, base, 7, h, 2)}" fill="${t.series[0]}"/>`;
  });
  const activity = project.commits30
    ? `${num(project.commits30)} ${project.commits30 === 1 ? "commit" : "commits"} in ${RECENT} days`
    : `No commits in ${RECENT} days`;
  body += `\n<text x="${right}" y="182" font-size="13" class="b" text-anchor="end">${activity}</text>
<text x="${right}" y="198" font-size="11" class="m" text-anchor="end">${project.lastDay ? `Last commit ${longDate(project.lastDay)}` : `Weekly commits, ${WEEKS} weeks`}</text>`;
  return frame(t, TILE_W, H, `${project.title}: ${activity}`, body);
}

function contactTile(t) {
  const H = 212;
  const css = `.pulse{transform-box:fill-box;transform-origin:center;animation:pulse 2.2s ease-out infinite}
@keyframes pulse{0%{transform:scale(1);opacity:.55}70%,100%{transform:scale(2.6);opacity:0}}`;
  let body = `<circle class="pulse" cx="${PAD + 5}" cy="31" r="5" fill="${t.good}"/>
<circle cx="${PAD + 5}" cy="31" r="5" fill="${t.good}"/>
<text x="${PAD + 18}" y="36" font-size="17" class="b">Open for new projects</text>
<text x="${PAD}" y="57" font-size="12" class="m">Freelance · ${esc(config.location)} · IST (UTC+5:30)</text>`;
  wrap("If your business runs on spreadsheets, paper registers or software that only half fits, I can build the system it actually needs.", 13, TILE_W - 2 * PAD, 3).forEach((line, i) => {
    body += `\n<text x="${PAD}" y="${82 + i * 18}" font-size="13" class="s">${esc(line)}</text>`;
  });
  body += `\n<line x1="${PAD}" x2="${TILE_W - PAD}" y1="160" y2="160" stroke="${t.grid}"/>
<text x="${PAD}" y="182" font-size="13" class="b">${esc(config.email)}</text>
<text x="${PAD}" y="198" font-size="11" class="m">Email to start a conversation</text>`;
  return frame(t, TILE_W, H, `Open for new projects. Email ${config.email}`, body, css);
}

function banner(t) {
  const W = 840;
  const H = 190;
  const css = `.rise{animation:rise .8s cubic-bezier(.2,.8,.2,1) both}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.draw{transform-box:fill-box;transform-origin:0 50%;animation:draw .9s .35s cubic-bezier(.2,.8,.2,1) both}
@keyframes draw{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.cell{animation:lit 6s ease-in-out infinite}
@keyframes lit{0%,100%{opacity:.16}12%{opacity:1}30%{opacity:.16}}`;
  let body = `<text class="rise" x="36" y="68" font-size="38" font-weight="700">${esc(config.name)}</text>
<rect class="draw" x="36" y="84" width="72" height="4" rx="2" fill="${t.series[0]}"/>
<text class="rise" style="animation-delay:.15s" x="36" y="126" font-size="25" font-weight="600">${esc(config.headline)}</text>
<text class="rise s" style="animation-delay:.3s" x="36" y="156" font-size="15">Full-stack developer · CRM, HRMS, BMS and internal tools</text>`;
  // A grid of modules lighting up one after another.
  const cols = 7;
  const rows = 5;
  const size = 18;
  const step = 26;
  const x0 = W - 36 - (cols - 1) * step - size;
  const y0 = (H - ((rows - 1) * step + size)) / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const delay = (((c * 3 + r * 5) % 11) * 0.5).toFixed(1);
      body += `\n<rect class="cell" style="animation-delay:${delay}s" x="${r1(x0 + c * step)}" y="${r1(y0 + r * step)}" width="${size}" height="${size}" rx="4" fill="${t.series[0]}" opacity=".16"/>`;
    }
  }
  return frame(t, W, H, `${config.name}. ${config.headline}`, body, css);
}

// ---------------------------------------------------------------- output

await mkdir(path.join(ROOT, "assets"), { recursive: true });
const panels = { banner, commits: commitsTile, rhythm: rhythmTile, contact: contactTile };
for (const [mode, theme] of Object.entries(THEMES)) {
  for (const [name, draw] of Object.entries(panels)) {
    await writeFile(path.join(ROOT, "assets", `${name}-${mode}.svg`), draw(theme));
  }
  for (const project of projects) {
    await writeFile(path.join(ROOT, "assets", `project-${project.slug}-${mode}.svg`), projectTile(theme, project));
  }
}

const picture = (name, alt, width) =>
  `<picture><source media="(prefers-color-scheme: dark)" srcset="assets/${name}-dark.svg"><img src="assets/${name}-light.svg" alt="${esc(alt)}" width="${width}"></picture>`;

const block = [
  picture("commits", `${num(stats.commits30)} commits in the last ${RECENT} days, shown per week for ${WEEKS} weeks`, TILE_W),
  picture("rhythm", `Active on ${stats.activeDays30} of the last ${RECENT} days. Languages: ${languages.map((l) => `${l.name} ${pct(l.share)}`).join(", ")}`, TILE_W),
  "",
  "<details>",
  "<summary>The same numbers as a table</summary>",
  "",
  "| Measure | Value |",
  "| --- | --- |",
  `| Commits, last ${RECENT} days | ${num(stats.commits30)} |`,
  `| Active days, last ${RECENT} days | ${stats.activeDays30} of ${RECENT} |`,
  `| Projects with commits, last ${RECENT} days | ${stats.projects30} |`,
  ...languages.map((l) => `| ${l.name} share of code in active projects | ${pct(l.share)} |`),
  "",
  "| Week ending | Commits |",
  "| --- | --- |",
  ...stats.weeks.map((value, i) => `| ${longDate(days[i * 7 + 6])} | ${num(value)} |`),
  "",
  "</details>",
  "",
  `<sub>Counted from my commits on the default branch of every repository I work in, private ones included. Updated ${longDate(today)}.</sub>`,
].join("\n");

const readmePath = path.join(ROOT, "README.md");
const readme = await readFile(readmePath, "utf8");
const START = "<!-- stats:start -->";
const END = "<!-- stats:end -->";
if (!readme.includes(START) || !readme.includes(END)) fail("README.md is missing the stats markers.");
const before = readme.slice(0, readme.indexOf(START) + START.length);
const after = readme.slice(readme.indexOf(END));
await writeFile(readmePath, `${before}\n${block}\n${after}`);

console.log(`generate: ${stats.commits30} commits, ${stats.activeDays30} active days, ${stats.projects30} projects in the last ${RECENT} days.`);
