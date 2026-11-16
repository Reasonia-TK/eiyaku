// 見本PDF(2段組みの英語論文風)を生成する
// 実行: node tools/make_demo.mjs
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const W = 612, H = 792;
const M = 54;           // 余白
const COLW = (W - M * 2 - 18) / 2; // 段幅
const INK = rgb(0.08, 0.1, 0.14);

const title = "Adaptive Grip Force Control for Delicate Object Manipulation";
const authors = "Taro Yamada, Hanako Suzuki, and John Smith";
const affil = "Department of Robotics, Example Institute of Technology";

const abstract =
  "Robotic grippers must apply forces that are large enough to prevent slip yet small enough to avoid damaging fragile objects. We present an adaptive grip force controller that estimates the friction coefficient online from tactile signals and adjusts the normal force within milliseconds. Experiments on 24 household objects show that the proposed method reduces slip events by 71 percent and peak contact force by 38 percent compared with a fixed-force baseline, while preserving grasp stability under external disturbances.";

const sec1Head = "1. Introduction";
const sec1 = [
  "Grasping fragile objects is a fundamental skill for service robots that operate in human environments. A gripper that applies excessive force may crush a paper cup or bruise a fruit, whereas insufficient force leads to slip and dropping. Humans solve this problem effortlessly by combining tactile feedback with prior knowledge about object materials.",
  "Most industrial grippers rely on a fixed grip force chosen conservatively for the heaviest expected payload. This strategy is robust but wastes energy and damages delicate items. Recent work has explored slip detection with tactile sensors, yet the delay between slip onset and force correction often exceeds 100 ms, which is too slow for lightweight objects.",
  "In this paper we propose an adaptive controller that (i) estimates the friction coefficient from micro-vibration features, (ii) predicts the minimum safe force with a learned model, and (iii) tracks the target force with a low-latency impedance loop. Our contributions are summarized as follows.",
];

const sec2Head = "2. Method";
const sec2 = [
  "The controller runs at 1 kHz on a microcontroller attached to the gripper. Tactile images from a vision-based sensor are summarized into 16 spectral features every 5 ms. A recursive least-squares estimator updates the friction coefficient mu from the ratio of tangential to normal force at the onset of micro-slip.",
  "The target normal force is computed as F = m * g / (mu * s), where m is the estimated object mass, g is gravity, and s = 1.4 is a safety factor. The impedance loop renders the target force with a stiffness of 800 N/m and damping of 12 Ns/m, which keeps the settling time below 20 ms.",
];

const sec3Head = "3. Experiments";
const sec3 = [
  "We evaluated the method on 24 objects ranging from 8 g (a plastic spoon) to 620 g (a ceramic mug). Each object was grasped 30 times while the arm followed a pick-and-place trajectory with accelerations up to 3 m/s^2. We compared against a fixed-force baseline tuned per object by an expert operator.",
  "The adaptive controller reduced slip events from 41 to 12 across all trials and lowered the mean peak force from 9.8 N to 6.1 N. No object was damaged in any trial. Table 1 summarizes the results per material category.",
];

const sec4Head = "4. Discussion";
const sec4 = [
  "The friction estimator converges within 40 ms of initial contact for most materials, which is fast enough to prevent macroscopic slip. However, highly compliant surfaces such as silicone rubber produce weak micro-vibration signals, and the estimator occasionally underestimates mu by up to 15 percent. In those cases the safety factor s absorbs the error, at the cost of a slightly higher contact force.",
  "An interesting failure mode appeared with thin-walled plastic cups: the vision-based tactile sensor saturates when the contact area exceeds 60 percent of the fingertip, and the spectral features become unreliable. We mitigated this by capping the target force at 8 N for objects classified as thin-walled, using a simple shape heuristic from the depth camera.",
  "Compared with learning-based approaches that require thousands of grasp trials, our method needs no training data for new objects because the friction estimate is physical rather than statistical. This makes it attractive for small laboratories and for field robots that encounter unfamiliar objects.",
];

const sec5Head = "5. Conclusion";
const sec5 = [
  "We presented a low-latency adaptive grip force controller that combines online friction estimation with impedance control. The method is computationally light enough to run on embedded hardware and generalizes across materials without per-object tuning. Future work will integrate slip prediction from visual cues before contact.",
];

const refsHead = "References";
const refs = [
  "[1] A. Bicchi and V. Kumar, Robotic grasping and contact: A review, Proc. ICRA, 2000.",
  "[2] R. S. Johansson and J. R. Flanagan, Coding and use of tactile signals from the fingertips in object manipulation tasks, Nature Reviews Neuroscience, 2009.",
  "[3] K. Hang et al., Hierarchical fingertip space: A unified framework for grasp planning and in-hand grasp adaptation, IEEE Trans. Robotics, 2016.",
];

function wrapText(text, font, size, maxW) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(t, size) > maxW && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

// ---- 1ページ目: タイトル+要旨(1段) → 本文(2段) ----
let page = doc.addPage([W, H]);
let y = H - 64;
for (const line of wrapText(title, bold, 16, W - M * 2)) {
  page.drawText(line, { x: M, y, size: 16, font: bold, color: INK });
  y -= 20;
}
y -= 4;
page.drawText(authors, { x: M, y, size: 10.5, font, color: INK });
y -= 14;
page.drawText(affil, { x: M, y, size: 9, font: italic, color: INK });
y -= 24;
page.drawText("Abstract", { x: M, y, size: 10.5, font: bold, color: INK });
y -= 14;
for (const line of wrapText(abstract, font, 9.5, W - M * 2)) {
  page.drawText(line, { x: M, y, size: 9.5, font, color: INK });
  y -= 12.5;
}
y -= 14;

// 2段組み本文
const colX = [M, M + COLW + 18];
let col = 0;
let cy = y;
const LH = 12.2;
const SIZE = 9.8;

function flow(head, paras) {
  const newPageIfNeeded = () => {
    if (cy < M + 12) {
      col = 1 - col;
      if (col === 0) { page = doc.addPage([W, H]); cy = H - M; y = H - M; }
      else cy = y;
    }
  };
  const drawHead = (h) => {
    if (cy < M + 30) { col = 1 - col; cy = y; if (col === 0) { page = doc.addPage([W, H]); cy = H - M; y = H - M; } }
    page.drawText(h, { x: colX[col], y: cy, size: 11, font: bold, color: INK });
    cy -= 16;
  };
  drawHead(head);
  for (const p of paras) {
    const lines = wrapText(p, font, SIZE, COLW);
    for (const line of lines) {
      newPageIfNeeded();
      page.drawText(line, { x: colX[col], y: cy, size: SIZE, font, color: INK });
      cy -= LH;
    }
    cy -= 5;
  }
}

flow(sec1Head, sec1);
flow(sec2Head, sec2);
flow(sec3Head, sec3);
flow(sec4Head, sec4);
flow(sec5Head, sec5);
flow(refsHead, refs);

doc.setTitle(title);
doc.setAuthor("eiyaku demo");
const bytes = await doc.save();
mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(join(root, "data", "demo.pdf"), bytes);
console.log(`demo.pdf written: ${bytes.length} bytes, ${doc.getPageCount()} pages`);
