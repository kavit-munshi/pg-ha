import fs from "node:fs/promises";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const OUT_DIR = "C:/Users/kavit/OneDrive/Documents/bayshore-postgres-ha/artifacts/backup-options-deck-build/rendered";
const FINAL_PPTX = "C:/Users/kavit/OneDrive/Documents/bayshore-postgres-ha/ansible-pg-ha/BACKUP_RECOVERY_OPTIONS_EXECUTIVE_DECK.pptx";

const C = {
  ink: "#0B1320",
  muted: "#596273",
  rule: "#B8BCC4",
  panel: "#EDEDED",
  pale: "#F5F7F9",
  accent: "#6DCBF4",
  accentStrong: "#3D8DFF",
  white: "#FFFFFF",
  amber: "#F5B942",
  red: "#C53B3B",
  green: "#2E8B67",
};

const repoRunbook = "Repository: DB_BACKUP_AND_RECOVERY_RUNBOOK.md";
const repoArchitecture = "Repository: SYSTEM_ARCHITECTURE_AND_RECOVERY.md";
const rubrikCompat = "https://docs.rubrik.com/en-us/compat_matrix/compat_matrix/cm_postgresql_protection.html";
const rubrikOverview = "https://docs.rubrik.com/en-us/saas/postgresql/postgresql.html";
const rubrikPrereq = "https://docs.rubrik.com/en-us/saas/postgresql/postgresql_protection_prereq.html";
const rubrikLimits = "https://docs.rubrik.com/en-us/saas/postgresql/postgresql_limitations.html";
const rubrikApi = "https://developer.rubrik.com/Rubrik-Security-Cloud-API/Data-Protection/Data-Center/PostgreSQL/";
const pgPitr = "https://www.postgresql.org/docs/18/continuous-archiving.html";
const pgBase = "https://www.postgresql.org/docs/18/app-pgbasebackup.html";

const deck = Presentation.create({ slideSize: { width: 1280, height: 720 } });

function box(slide, name, left, top, width, height, fill = C.pale, line = C.rule) {
  return slide.shapes.add({
    geometry: "rect",
    name,
    position: { left, top, width, height },
    fill,
    line: { style: "solid", fill: line, width: line === "none" ? 0 : 1 },
  });
}

function text(slide, name, value, left, top, width, height, size = 20, options = {}) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    name,
    position: { left, top, width, height },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = value;
  shape.text.style = {
    fontSize: size,
    typeface: "Arial",
    color: options.color || C.ink,
    bold: options.bold || false,
    alignment: options.align || "left",
    verticalAlignment: options.valign || "top",
  };
  return shape;
}

function title(slide, value, number) {
  text(slide, `title-${number}`, value, 56, 38, 1130, 78, 38, { bold: true });
  box(slide, `title-rule-${number}`, 56, 122, 1168, 2, C.ink, "none");
  text(slide, `page-${number}`, String(number).padStart(2, "0"), 1180, 666, 44, 22, 13, {
    color: C.muted,
    align: "right",
  });
}

function eyebrow(slide, value, left = 56, top = 46) {
  text(slide, `eyebrow-${deck.slides.items.length}`, value.toUpperCase(), left, top, 500, 24, 14, {
    bold: true,
    color: C.accentStrong,
  });
}

function notes(slide, sources, presenter = "") {
  const lines = [];
  if (presenter) lines.push(presenter, "");
  lines.push("[Sources]", ...sources.map((s) => `- ${s}`), "[/Sources]");
  slide.speakerNotes.textFrame.setText(lines.join("\n"));
}

function optionColumn(slide, x, index, heading, body, accent) {
  box(slide, `option-${index}-top`, x, 200, 8, 310, accent, "none");
  text(slide, `option-${index}-number`, `0${index}`, x + 26, 198, 70, 55, 32, {
    bold: true,
    color: accent,
  });
  text(slide, `option-${index}-heading`, heading, x + 26, 254, 320, 96, 25, { bold: true });
  text(slide, `option-${index}-body`, body, x + 26, 364, 320, 170, 18, { color: C.muted });
}

function twoColumnOption(slide, number, heading, subtitle, leftTitle, leftBody, rightTitle, rightBody, callout) {
  title(slide, heading, number);
  text(slide, `subtitle-${number}`, subtitle, 56, 145, 1120, 42, 20, { color: C.muted });
  box(slide, `left-field-${number}`, 56, 220, 545, 325, C.pale, "none");
  box(slide, `right-field-${number}`, 637, 220, 587, 325, C.white, C.rule);
  text(slide, `left-title-${number}`, leftTitle, 82, 246, 485, 40, 24, { bold: true, color: C.accentStrong });
  text(slide, `left-body-${number}`, leftBody, 82, 302, 485, 218, 18, { color: C.ink });
  text(slide, `right-title-${number}`, rightTitle, 663, 246, 525, 40, 24, { bold: true });
  text(slide, `right-body-${number}`, rightBody, 663, 302, 525, 218, 18, { color: C.ink });
  box(slide, `callout-rule-${number}`, 56, 582, 8, 58, C.accentStrong, "none");
  text(slide, `callout-${number}`, callout, 82, 579, 1090, 64, 20, { bold: true });
}

// Slide 1 — cover, based on Codex Grid slide 01 sparse stacked-text hierarchy.
{
  const slide = deck.slides.add();
  slide.background.fill = C.white;
  eyebrow(slide, "Executive decision brief");
  text(slide, "cover-title", "PostgreSQL HA\nbackup and recovery options", 56, 178, 900, 210, 56, { bold: true });
  text(slide, "cover-subtitle", "Neutral comparison of three operating models", 56, 438, 760, 48, 26, {
    color: C.muted,
  });
  box(slide, "cover-accent", 56, 540, 1168, 10, C.accentStrong, "none");
  text(slide, "cover-footer", "PostgreSQL 18 • pg_auto_failover • Rubrik • Ansible", 56, 585, 900, 34, 18, {
    color: C.muted,
  });
  text(slide, "cover-date", "Decision support | August 2026", 900, 585, 324, 34, 18, {
    color: C.muted,
    align: "right",
  });
  notes(slide, [repoRunbook, repoArchitecture]);
}

// Slide 2 — three-column option landscape, based on Codex Grid slide 07.
{
  const slide = deck.slides.add();
  slide.background.fill = C.white;
  title(slide, "Three operating models; one proof standard", 2);
  text(slide, "s2-lead", "The decision is about ownership and orchestration—not whether base backups and WAL are required.", 56, 150, 1120, 46, 21, { color: C.muted });
  optionColumn(slide, 56, 1, "Rubrik with native HA integration", "Potentially product-led end to end. Conditional on PostgreSQL 18 and pg_auto_failover support being confirmed and proven.", C.accentStrong);
  optionColumn(slide, 450, 2, "Rubrik without native HA integration", "Central protection with explicit DBA orchestration for primary changes, monitor recovery, fencing, and cluster rejoin.", C.accent);
  optionColumn(slide, 844, 3, "Ansible WAL plus manual base backup", "Maximum control and transparency, with the largest internal engineering, operations, and assurance burden.", C.amber);
  box(slide, "s2-bottom", 56, 576, 1168, 62, C.ink, "none");
  text(slide, "s2-bottom-text", "No option is accepted until an isolated restore proves the recovery chain and measures RPO/RTO.", 80, 590, 1120, 36, 21, { bold: true, color: C.white, align: "center" });
  notes(slide, [repoRunbook, pgPitr]);
}

// Slide 3 — recovery-chain diagram.
{
  const slide = deck.slides.add();
  slide.background.fill = C.white;
  title(slide, "HA keeps service running; backup reverses damage", 3);
  text(slide, "s3-lead", "Replication alone reproduces logical corruption. WAL alone cannot rebuild a cluster.", 56, 148, 1120, 42, 22, { color: C.muted });

  // Directional elements are created before nodes so they sit behind them.
  for (const x of [332, 650, 968]) {
    slide.shapes.add({
      geometry: "rightArrow",
      name: `s3-arrow-${x}`,
      position: { left: x, top: 310, width: 72, height: 42 },
      fill: C.accent,
      line: { style: "solid", fill: "none", width: 0 },
    });
  }

  const nodes = [
    { x: 56, title: "Base backup", body: "A consistent physical starting point", fill: C.pale },
    { x: 374, title: "WAL chain", body: "Every required segment and timeline", fill: "#EAF7FC" },
    { x: 692, title: "Isolated restore", body: "Recover recent state or a precise point", fill: C.pale },
    { x: 1010, title: "Validated service", body: "DBA and application acceptance", fill: "#EAF7FC" },
  ];
  nodes.forEach((n, i) => {
    box(slide, `s3-node-${i}`, n.x, 242, 238, 182, n.fill, C.rule);
    text(slide, `s3-node-title-${i}`, n.title, n.x + 20, 270, 198, 42, 24, { bold: true });
    text(slide, `s3-node-body-${i}`, n.body, n.x + 20, 326, 198, 70, 18, { color: C.muted });
  });
  text(slide, "s3-foundation", "Every option must preserve this chain off-host—and prove it by restore.", 136, 503, 1008, 50, 26, { bold: true, align: "center" });
  text(slide, "s3-foot", "Current state: WAL archive exists on the monitor; retained recovery base backups and isolated restore evidence remain pending.", 136, 572, 1008, 48, 18, { color: C.muted, align: "center" });
  notes(slide, [repoRunbook, pgPitr, pgBase]);
}

// Slide 4 — Option 1.
{
  const slide = deck.slides.add();
  slide.background.fill = C.white;
  twoColumnOption(
    slide,
    4,
    "Option 1 could consolidate ownership—if support is real",
    "Rubrik-managed PostgreSQL protection with native pg_auto_failover integration",
    "Potential operating model",
    "• SLA-driven data and WAL protection\n• Product follows the writable primary\n• Central retention, immutability and reporting\n• Product-led recent-state and PITR recovery\n• Lower custom automation after validation",
    "Evidence still required",
    "• Exact release supporting PostgreSQL 18\n• Written pg_auto_failover support statement\n• Behavior during and after promotion\n• Monitor backup and replacement workflow\n• Fencing and safe rejoin after restore\n• Measured restore and application validation",
    "Current public compatibility evidence reviewed here lists Community PostgreSQL through version 17; treat the new-release claim as conditional."
  );
  notes(slide, [rubrikCompat, rubrikOverview, rubrikApi, repoRunbook], "Do not present this option as supported until Rubrik confirms the exact version and architecture in writing.");
}

// Slide 5 — Option 2.
{
  const slide = deck.slides.add();
  slide.background.fill = C.white;
  twoColumnOption(
    slide,
    5,
    "Option 2 uses Rubrik but keeps HA orchestration manual",
    "Protect the PostgreSQL cluster with standard Rubrik workflows; protect the monitor separately",
    "What Rubrik can centralize",
    "• Policy-driven data and WAL protection\n• Off-host retention and recovery catalog\n• Encryption, access control and reporting\n• Product-assisted recent-state or PITR restore\n• Separate monitor VM/application policy",
    "What operations must own",
    "• Identify the authoritative primary after failover\n• Prevent duplicate or stale protection sources\n• Fence old primaries before restore\n• Recover or replace monitor control state safely\n• Re-register/reseed nodes after recovery\n• Coordinate Rubrik, DBA and VMware runbooks",
    "This model is viable only if the shared recovery procedure prevents stale primary or stale monitor state from re-entering the cluster."
  );
  notes(slide, [rubrikOverview, rubrikPrereq, rubrikLimits, rubrikApi, repoRunbook]);
}

// Slide 6 — Option 3.
{
  const slide = deck.slides.add();
  slide.background.fill = C.white;
  twoColumnOption(
    slide,
    6,
    "Option 3 maximizes control—and internal accountability",
    "Ansible-managed WAL archive with operator-run physical base backups",
    "Designed technical pattern",
    "• Discover exactly one writable primary\n• Run rate-limited pg_basebackup\n• Stream startup WAL into the backup\n• Verify SHA-256 manifest with pg_verifybackup\n• Publish atomically only after verification\n• Retain the matching WAL/timeline chain",
    "Controls the team must build and sustain",
    "• Dedicated backup storage and capacity guardrails\n• Off-host immutable copy and catalog\n• WAL/base-backup retention coupling\n• Credentials, alerting and audit evidence\n• Recovery orchestration and fencing\n• Quarterly isolated restore exercises",
    "The repository has the WAL layer and a detailed base-backup design; the retained base-backup service is not yet operational."
  );
  notes(slide, [repoRunbook, repoArchitecture, pgPitr, pgBase]);
}

// Slide 7 — neutral comparison table, based on Codex Grid slide 14.
{
  const slide = deck.slides.add();
  slide.background.fill = C.white;
  title(slide, "Product dependency trades off against operating burden", 7);
  text(slide, "s7-lead", "Qualitative tendencies only; service levels must come from measured recovery tests.", 56, 145, 1120, 38, 19, { color: C.muted });
  const values = [
    ["Decision dimension", "1  Rubrik + native HA", "2  Rubrik + manual HA", "3  Ansible + manual base"],
    ["Failover awareness", "Product-managed if proven", "Shared orchestration", "Custom discovery"],
    ["Custom automation", "Lowest potential", "Moderate", "Highest"],
    ["Off-host protection", "Rubrik policy", "Rubrik policy", "Separate target required"],
    ["Monitor recovery", "Must be confirmed", "Separate policy/runbook", "Separate backup/rebuild"],
    ["Recovery ownership", "Rubrik-led + DBA", "Backup + DBA + VMware", "DBA/automation-led"],
    ["Primary uncertainty", "Release/support evidence", "Safe source and rejoin", "Supportability/human error"],
  ];
  const table = slide.tables.add({
    rows: values.length,
    columns: 4,
    left: 56,
    top: 205,
    width: 1168,
    height: 394,
    columnWidths: [250, 306, 306, 306],
    values,
  });
  table.borders.assign({ style: "solid", fill: C.rule, width: 1 });
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < 4; c++) {
      const cell = table.getCell(r, c);
      cell.fill = r === 0 ? C.ink : (r % 2 === 0 ? C.pale : C.white);
      cell.text.style = {
        fontSize: r === 0 ? 17 : 16,
        typeface: "Arial",
        bold: r === 0 || c === 0,
        color: r === 0 ? C.white : C.ink,
      };
    }
  }
  box(slide, "s7-caution", 56, 622, 8, 36, C.amber, "none");
  text(slide, "s7-caution-text", "No RPO/RTO commitment should be inferred from this table.", 80, 620, 1080, 38, 18, { bold: true });
  notes(slide, [repoRunbook, rubrikOverview, rubrikLimits]);
}

// Slide 8 — recovery scenarios.
{
  const slide = deck.slides.add();
  slide.background.fill = C.white;
  title(slide, "Recovery scenarios expose different control-plane risks", 8);
  const scenarios = [
    ["Single data-node loss", "HA reseeds a secondary; backup is not normally used"],
    ["Monitor loss", "Protect/rebuild separately; never revive stale monitor authority"],
    ["Logical corruption", "Fence writes; restore base + WAL to an isolated point in time"],
    ["Complete DB-tier loss", "Restore one authority, rebuild monitor, then seed a new secondary"],
  ];
  scenarios.forEach((s, i) => {
    const y = 168 + i * 105;
    text(slide, `s8-index-${i}`, `0${i + 1}`, 56, y, 62, 48, 26, { bold: true, color: C.accentStrong });
    text(slide, `s8-title-${i}`, s[0], 132, y, 292, 44, 23, { bold: true });
    box(slide, `s8-rule-${i}`, 442, y + 4, 2, 68, C.rule, "none");
    text(slide, `s8-body-${i}`, s[1], 470, y, 700, 70, 19, { color: C.muted });
  });
  box(slide, "s8-bottom", 56, 600, 1168, 55, "#EAF7FC", "none");
  text(slide, "s8-bottom-text", "Every option still needs fencing, authoritative-primary selection, and post-restore pg_auto_failover reconstruction.", 76, 611, 1128, 34, 19, { bold: true, align: "center" });
  notes(slide, [repoRunbook, repoArchitecture, pgPitr]);
}

// Slide 9 — proof timeline, based on Codex Grid slide 17.
{
  const slide = deck.slides.add();
  slide.background.fill = C.white;
  title(slide, "A common proof plan makes the options comparable", 9);
  const steps = [
    ["1", "Confirm", "Vendor support, ownership, retention and security"],
    ["2", "Protect", "Base backup plus WAL under normal workload"],
    ["3", "Fail over", "Switch primary and prove protection follows safely"],
    ["4", "Restore", "Isolated PITR, application validation and measurement"],
  ];
  // Timeline line and arrows first.
  box(slide, "s9-line", 100, 330, 960, 3, C.ink, "none");
  steps.forEach((s, i) => {
    const x = 100 + i * 300;
    const dot = slide.shapes.add({
      geometry: "ellipse",
      name: `s9-dot-${i}`,
      position: { left: x - 10, top: 320, width: 22, height: 22 },
      fill: i === 3 ? C.accentStrong : C.ink,
      line: { style: "solid", fill: "none", width: 0 },
    });
    void dot;
    text(slide, `s9-num-${i}`, s[0], x - 5, 242, 70, 34, 18, { bold: true, color: C.accentStrong });
    text(slide, `s9-title-${i}`, s[1], x - 5, 372, 225, 42, 25, { bold: true });
    text(slide, `s9-body-${i}`, s[2], x - 5, 426, 235, 100, 18, { color: C.muted });
  });
  box(slide, "s9-evidence", 56, 576, 1168, 68, C.ink, "none");
  text(slide, "s9-evidence-text", "Capture backup impact, achieved RPO, technical restore time, application validation time, effort and exceptions.", 82, 592, 1116, 40, 20, { bold: true, color: C.white, align: "center" });
  notes(slide, [repoRunbook, rubrikApi, pgPitr]);
}

// Slide 10 — close with decision gates.
{
  const slide = deck.slides.add();
  slide.background.fill = C.white;
  eyebrow(slide, "Decision gate");
  text(slide, "s10-title", "Choose after evidence closes six questions", 56, 126, 1040, 76, 44, { bold: true });
  const questions = [
    "Does the exact solution support PostgreSQL 18 and Ubuntu 24.04?",
    "Does protection follow pg_auto_failover role changes without ambiguity?",
    "Can the monitor be recovered without reviving stale authority?",
    "Are base backups and the complete WAL/timeline chain protected off-host?",
    "Can teams execute the recovery safely with named ownership and fencing?",
    "Has an isolated restore measured achievable RPO and RTO?",
  ];
  questions.forEach((q, i) => {
    const col = i < 3 ? 0 : 1;
    const row = i % 3;
    const x = col === 0 ? 56 : 650;
    const y = 252 + row * 92;
    slide.shapes.add({
      geometry: "ellipse",
      name: `s10-check-${i}`,
      position: { left: x, top: y + 2, width: 24, height: 24 },
      fill: C.white,
      line: { style: "solid", fill: C.accentStrong, width: 2 },
    });
    text(slide, `s10-q-${i}`, q, x + 42, y, 510, 64, 19, { bold: true });
  });
  box(slide, "s10-close", 56, 574, 1168, 68, C.accentStrong, "none");
  text(slide, "s10-close-text", "Next decision: authorize a common UAT proof and require written Rubrik support confirmation.", 82, 590, 1116, 40, 22, { bold: true, color: C.white, align: "center" });
  text(slide, "s10-page", "10", 1180, 666, 44, 22, 13, { color: C.muted, align: "right" });
  notes(slide, [rubrikCompat, repoRunbook, pgPitr]);
}

async function writeBlob(path, blob) {
  await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

await fs.mkdir(OUT_DIR, { recursive: true });

for (const [i, slide] of deck.slides.items.entries()) {
  const stem = `slide-${String(i + 1).padStart(2, "0")}`;
  await writeBlob(`${OUT_DIR}/${stem}.png`, await deck.export({ slide, format: "png", scale: 1 }));
  const layout = await slide.export({ format: "layout" });
  await fs.writeFile(`${OUT_DIR}/${stem}.layout.json`, await layout.text());
}

await writeBlob(`${OUT_DIR}/deck-montage.webp`, await deck.export({ format: "webp", montage: true, scale: 1 }));
const snapshot = await deck.inspect({ kind: "slide,textbox,shape,table,notes", maxChars: 40000 });
await fs.writeFile(`${OUT_DIR}/deck-inspect.ndjson`, snapshot.ndjson);

const pptx = await PresentationFile.exportPptx(deck);
await pptx.save(FINAL_PPTX);

console.log(`Created ${FINAL_PPTX}`);
