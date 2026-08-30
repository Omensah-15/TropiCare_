/*
 * TropiCare — Clinical PDF Report Generator
 */
import { jsPDF } from "jspdf";

const TEAL   = [12, 138, 126];
const TEAL_D = [10, 107, 98];
const INK    = [11, 23, 38];
const MUTED  = [91, 107, 124];
const BORDER = [225, 229, 232];
const PANEL  = [248, 250, 250];

const RISK_RGB = {
  High:   [226, 61, 61],
  Medium: [232, 147, 15],
  Low:    [31, 157, 85],
  None:   [31, 157, 85],
};

const LINE_COLORS = [
  [12, 138, 126],
  [47, 111, 237],
  [232, 147, 15],
  [124, 92, 240],
  [226, 61, 61],
];

const PAGE_W     = 210;
const PAGE_H     = 297;
const MARGIN     = 16;
const CONTENT_W  = PAGE_W - MARGIN * 2;
const FOOTER_LIMIT = PAGE_H - 24;

// ─────────────────────────────────────────────
// READ STORED SESSION
// Reads the logged-in user straight from localStorage so patient info is
// always available regardless of which screen triggers the PDF download.
// ─────────────────────────────────────────────
function getStoredUser() {
  try {
    const raw = localStorage.getItem("tc_user");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────
// QUESTION BANK
// Mirrors the assessment engine's question set so each confirmed ("Yes")
// answer can be rendered with its original question text and the symptom
// it maps to, without requiring an extra network round-trip at PDF time.
// ─────────────────────────────────────────────
const QUESTION_BANK = [
  {id:"back_pain",question:"Do you have back pain?",category:"General"},
  {id:"chills",question:"Do you have chills or shivering?",category:"General"},
  {id:"dehydration",question:"Do you feel severely dehydrated?",category:"General"},
  {id:"fatigue",question:"Do you feel unusually tired or weak?",category:"General"},
  {id:"headache",question:"Do you have headaches?",category:"General"},
  {id:"high_fever",question:"Do you have a high fever?",category:"General"},
  {id:"joint_pain",question:"Do you have joint pain?",category:"General"},
  {id:"lethargy",question:"Do you feel a lack of energy or sluggishness?",category:"General"},
  {id:"malaise",question:"Do you feel generally unwell or sick?",category:"General"},
  {id:"mild_fever",question:"Do you have a mild fever?",category:"General"},
  {id:"muscle_pain",question:"Do you have muscle pain or body aches?",category:"General"},
  {id:"shivering",question:"Are you shivering?",category:"General"},
  {id:"sweating",question:"Do you have episodes of sweating?",category:"General"},
  {id:"blood_in_sputum",question:"Are you coughing up blood?",category:"Respiratory"},
  {id:"breathlessness",question:"Do you have difficulty breathing or shortness of breath?",category:"Respiratory"},
  {id:"chest_pain",question:"Do you have chest pain?",category:"Respiratory"},
  {id:"congestion",question:"Do you have nasal or chest congestion?",category:"Respiratory"},
  {id:"continuous_sneezing",question:"Do you sneeze frequently?",category:"Respiratory"},
  {id:"cough",question:"Do you have a cough?",category:"Respiratory"},
  {id:"loss_of_smell",question:"Have you lost your sense of smell?",category:"Respiratory"},
  {id:"mucoid_sputum",question:"Are you coughing up thick, mucus-like sputum?",category:"Respiratory"},
  {id:"phlegm",question:"Are you coughing up phlegm or mucus?",category:"Respiratory"},
  {id:"runny_nose",question:"Do you have a runny nose?",category:"Respiratory"},
  {id:"rusty_sputum",question:"Are you coughing up rusty or brown-coloured sputum?",category:"Respiratory"},
  {id:"sinus_pressure",question:"Do you have sinus pressure or nasal congestion?",category:"Respiratory"},
  {id:"throat_irritation",question:"Do you have a sore or irritated throat?",category:"Respiratory"},
  {id:"watering_from_eyes",question:"Do you have watery eyes?",category:"Respiratory"},
  {id:"abdominal_pain",question:"Do you have abdominal or belly pain?",category:"Digestive"},
  {id:"acidity",question:"Do you have acidity or a burning sensation in your stomach?",category:"Digestive"},
  {id:"belly_pain",question:"Do you have persistent belly pain?",category:"Digestive"},
  {id:"bloody_stool",question:"Do you notice blood in your stool?",category:"Digestive"},
  {id:"constipation",question:"Do you have constipation?",category:"Digestive"},
  {id:"diarrhoea",question:"Do you have diarrhoea?",category:"Digestive"},
  {id:"distention_of_abdomen",question:"Do you feel bloated or have a distended abdomen?",category:"Digestive"},
  {id:"heartburn",question:"Do you have heartburn?",category:"Digestive"},
  {id:"indigestion",question:"Do you have indigestion?",category:"Digestive"},
  {id:"loss_of_appetite",question:"Have you lost your appetite?",category:"Digestive"},
  {id:"nausea",question:"Do you feel nauseous?",category:"Digestive"},
  {id:"passage_of_gases",question:"Do you have excessive gas?",category:"Digestive"},
  {id:"stomach_bleeding",question:"Do you have stomach bleeding?",category:"Digestive"},
  {id:"stomach_pain",question:"Do you have stomach pain?",category:"Digestive"},
  {id:"sunken_eyes",question:"Do your eyes look sunken?",category:"Digestive"},
  {id:"swelling_of_stomach",question:"Is your stomach area swollen?",category:"Digestive"},
  {id:"ulcers_on_tongue",question:"Do you have ulcers on your tongue?",category:"Digestive"},
  {id:"vomiting",question:"Have you been vomiting?",category:"Digestive"},
  {id:"acute_liver_failure",question:"Do you have confusion, severe swelling, or very dark urine along with yellowing of your skin or eyes?",category:"Liver"},
  {id:"dark_urine",question:"Is your urine dark or tea-coloured?",category:"Liver"},
  {id:"fluid_overload",question:"Do you have abnormal body swelling or fluid retention?",category:"Liver"},
  {id:"internal_itching",question:"Do you experience internal itching?",category:"Liver"},
  {id:"yellow_urine",question:"Is your urine unusually yellow?",category:"Liver"},
  {id:"yellowing_of_eyes",question:"Are the whites of your eyes turning yellow?",category:"Liver"},
  {id:"yellowish_skin",question:"Is your skin yellowish or jaundiced?",category:"Liver"},
  {id:"blackheads",question:"Do you have blackheads?",category:"Skin"},
  {id:"blister",question:"Do you have fluid-filled blisters?",category:"Skin"},
  {id:"bruising",question:"Do you bruise easily?",category:"Skin"},
  {id:"dischromic_patches",question:"Do you have discoloured patches on your skin?",category:"Skin"},
  {id:"itching",question:"Do you have itchy skin?",category:"Skin"},
  {id:"nodal_skin_eruptions",question:"Do you have nodules or skin eruptions?",category:"Skin"},
  {id:"pus_filled_pimples",question:"Do you have pus-filled pimples?",category:"Skin"},
  {id:"red_sore_around_nose",question:"Do you have red sores around your nose or mouth?",category:"Skin"},
  {id:"red_spots_over_body",question:"Do you have red spots on your body?",category:"Skin"},
  {id:"scurring",question:"Do you have scarring on your skin?",category:"Skin"},
  {id:"silver_like_dusting",question:"Do you have silvery, scale-like patches on your skin?",category:"Skin"},
  {id:"skin_peeling",question:"Is your skin peeling?",category:"Skin"},
  {id:"skin_rash",question:"Do you have a skin rash?",category:"Skin"},
  {id:"yellow_crust_ooze",question:"Do your skin sores ooze a yellow crust?",category:"Skin"},
  {id:"blurred_and_distorted_vision",question:"Do you have blurred or distorted vision?",category:"Eyes"},
  {id:"pain_behind_the_eyes",question:"Do you have pain behind your eyes?",category:"Eyes"},
  {id:"puffy_face_and_eyes",question:"Do you have puffiness around your face or eyes?",category:"Eyes"},
  {id:"redness_of_eyes",question:"Do you have red or irritated eyes?",category:"Eyes"},
  {id:"visual_disturbances",question:"Do you have visual disturbances, such as flashing lights or blind spots?",category:"Eyes"},
  {id:"abnormal_menstruation",question:"Have you noticed abnormal or irregular menstrual periods?",category:"Urinary"},
  {id:"bladder_discomfort",question:"Do you have bladder discomfort?",category:"Urinary"},
  {id:"burning_micturition",question:"Do you feel a burning sensation when urinating?",category:"Urinary"},
  {id:"continuous_feel_of_urine",question:"Do you feel like you need to urinate again right after you've just gone?",category:"Urinary"},
  {id:"foul_smell_of_urine",question:"Does your urine have an unusual smell?",category:"Urinary"},
  {id:"polyuria",question:"When you do urinate, are you passing much larger amounts than usual each time?",category:"Urinary"},
  {id:"spotting_urination",question:"Do you notice spotting during urination?",category:"Urinary"},
  {id:"urinating_a_lot",question:"Are you making more trips to the bathroom to urinate than usual?",category:"Urinary"},
  {id:"irritation_in_anus",question:"Do you have irritation around the anus?",category:"Rectal"},
  {id:"pain_during_bowel_movements",question:"Do you have pain during bowel movements?",category:"Rectal"},
  {id:"pain_in_anal_region",question:"Do you have pain in your anal region?",category:"Rectal"},
  {id:"altered_sensorium",question:"Do you feel confused or disoriented?",category:"Neurological"},
  {id:"anxiety",question:"Have you been feeling anxious?",category:"Neurological"},
  {id:"coma",question:"Have you experienced any loss of consciousness?",category:"Neurological"},
  {id:"depression",question:"Have you been feeling persistently low or depressed?",category:"Neurological"},
  {id:"dizziness",question:"Do you feel dizzy?",category:"Neurological"},
  {id:"irritability",question:"Have you been feeling unusually irritable?",category:"Neurological"},
  {id:"lack_of_concentration",question:"Do you have trouble concentrating?",category:"Neurological"},
  {id:"loss_of_balance",question:"Do you have trouble keeping your balance?",category:"Neurological"},
  {id:"mood_swings",question:"Have you been experiencing mood swings?",category:"Neurological"},
  {id:"muscle_weakness",question:"Do you have general muscle weakness?",category:"Neurological"},
  {id:"restlessness",question:"Do you feel restless or agitated?",category:"Neurological"},
  {id:"slurred_speech",question:"Have you had episodes of slurred speech?",category:"Neurological"},
  {id:"spinning_movements",question:"Do you feel a spinning sensation (vertigo)?",category:"Neurological"},
  {id:"toxic_look_typhos",question:"Do you look or feel severely, acutely ill?",category:"Neurological"},
  {id:"unsteadiness",question:"Do you feel unsteady on your feet?",category:"Neurological"},
  {id:"weakness_in_limbs",question:"Do you have weakness in your arms or legs?",category:"Neurological"},
  {id:"weakness_of_one_body_side",question:"Do you have sudden weakness on one side of your body?",category:"Neurological"},
  {id:"brittle_nails",question:"Do you have brittle nails?",category:"Metabolic"},
  {id:"cold_hands_and_feets",question:"Do your hands and feet often feel unusually cold?",category:"Metabolic"},
  {id:"drying_and_tingling_lips",question:"Do you have dry or tingling lips?",category:"Metabolic"},
  {id:"enlarged_thyroid",question:"Have you noticed swelling in the front of your neck (thyroid area)?",category:"Metabolic"},
  {id:"excessive_hunger",question:"Are you excessively hungry?",category:"Metabolic"},
  {id:"increased_appetite",question:"Has your appetite increased significantly?",category:"Metabolic"},
  {id:"irregular_sugar_level",question:"Do you have an irregular blood sugar level?",category:"Metabolic"},
  {id:"obesity",question:"Are you significantly overweight?",category:"Metabolic"},
  {id:"palpitations",question:"Do you have a racing or pounding heartbeat?",category:"Metabolic"},
  {id:"swollen_extremeties",question:"Do you have swelling in your arms or legs?",category:"Metabolic"},
  {id:"weight_gain",question:"Have you experienced unexplained weight gain?",category:"Metabolic"},
  {id:"weight_loss",question:"Have you experienced unexplained weight loss?",category:"Metabolic"},
  {id:"cramps",question:"Do you get muscle cramps?",category:"Cardiovascular"},
  {id:"fast_heart_rate",question:"Do you have a fast or irregular heartbeat?",category:"Cardiovascular"},
  {id:"prominent_veins_on_calf",question:"Do you have prominent, visible veins on your calves?",category:"Cardiovascular"},
  {id:"swollen_blood_vessels",question:"Do you have visibly swollen or bulging blood vessels?",category:"Cardiovascular"},
  {id:"swollen_legs",question:"Do you have swollen legs?",category:"Cardiovascular"},
  {id:"hip_joint_pain",question:"Do you have hip joint pain?",category:"Musculoskeletal"},
  {id:"inflammatory_nails",question:"Are your nails inflamed or discoloured?",category:"Musculoskeletal"},
  {id:"knee_pain",question:"Do you have knee pain?",category:"Musculoskeletal"},
  {id:"movement_stiffness",question:"Do you feel stiffness when moving?",category:"Musculoskeletal"},
  {id:"neck_pain",question:"Do you have neck pain?",category:"Musculoskeletal"},
  {id:"painful_walking",question:"Is walking painful for you?",category:"Musculoskeletal"},
  {id:"small_dents_in_nails",question:"Do you have small dents or pits in your nails?",category:"Musculoskeletal"},
  {id:"stiff_neck",question:"Do you have a stiff neck?",category:"Musculoskeletal"},
  {id:"swelling_joints",question:"Do you have swelling in your joints?",category:"Musculoskeletal"},
  {id:"swelled_lymph_nodes",question:"Do you have swollen lymph nodes?",category:"Infection"},
  {id:"family_history",question:"Does anyone in your close family have asthma?",category:"History"},
  {id:"history_of_alcohol_consumption",question:"Do you have a history of heavy alcohol use?",category:"History"},
  {id:"receiving_blood_transfusion",question:"Have you received a blood transfusion recently?",category:"History"},
  {id:"receiving_unsterile_injections",question:"Have you been injected with unsterile equipment?",category:"History"},
];

const QUESTION_INDEX = Object.fromEntries(QUESTION_BANK.map((q) => [q.id, q]));

// Human-readable symptom label, e.g. "high_fever" -> "High Fever"
function symptomLabel(symptomId) {
  return String(symptomId || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || "Unspecified";
}

// Resolves a symptom id to its original question text and category,
// falling back to a generated question when the id isn't in the bank
// (e.g. a legacy record referencing a retired question).
function resolveQuestion(symptomId) {
  const entry = QUESTION_INDEX[symptomId];
  if (entry) return { question: entry.question, category: entry.category };
  return {
    question: `Do you have ${symptomLabel(symptomId).toLowerCase()}?`,
    category: "General",
  };
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function fmtDate(d) {
  const date = d ? new Date(d) : new Date();
  if (isNaN(date.getTime())) return fmtDate();
  return (
    date.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }) +
    " at " +
    date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

function makeReportId() {
  const now   = new Date();
  const stamp = now.toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  return `TC-${stamp}`;
}

// Returns the first non-empty, non-null, non-"undefined" candidate value,
// or "Not provided" when none is available.
function field(...candidates) {
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const str = String(c).trim();
    if (
      str.length > 0 &&
      str.toLowerCase() !== "undefined" &&
      str.toLowerCase() !== "null"
    ) {
      return str;
    }
  }
  return "Not provided";
}

function ensureSpace(doc, cursorY, needed) {
  if (cursorY + needed > FOOTER_LIMIT) {
    doc.addPage();
    return 24;
  }
  return cursorY;
}

function drawPageFooter(doc) {
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.2);
    doc.line(MARGIN, PAGE_H - 17, PAGE_W - MARGIN, PAGE_H - 17);
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...MUTED);
    doc.text(
      "TropiCare — AI-Guided Tropical Disease Symptom Checker",
      MARGIN,
      PAGE_H - 12
    );
    doc.text(
      `Page ${i} of ${totalPages}`,
      PAGE_W - MARGIN,
      PAGE_H - 12,
      { align: "right" }
    );
    doc.text(
      "This report is generated by an automated screening tool and does not constitute a clinical diagnosis.",
      MARGIN,
      PAGE_H - 7.5
    );
  }
}

function sectionLabel(doc, text, y) {
  doc.setFontSize(9.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...TEAL_D);
  doc.text(text.toUpperCase(), MARGIN, y);
  doc.setDrawColor(...TEAL);
  doc.setLineWidth(0.4);
  doc.line(MARGIN, y + 2, PAGE_W - MARGIN, y + 2);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...INK);
  return y + 9;
}

// ─────────────────────────────────────────────
// HEADER
// ─────────────────────────────────────────────
function drawHeader(doc, reportId, dateStr) {
  doc.setFillColor(...TEAL);
  doc.rect(0, 0, PAGE_W, 30, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(19);
  doc.setFont("helvetica", "bold");
  doc.text("TropiCare", MARGIN, 14);

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text("Clinical Symptom Assessment Report", MARGIN, 21.5);

  doc.setFontSize(8);
  doc.text(`Report ID: ${reportId}`, PAGE_W - MARGIN, 12.5, { align: "right" });
  doc.text(`Generated: ${dateStr}`, PAGE_W - MARGIN, 18.5, { align: "right" });

  doc.setTextColor(...INK);
  return 41;
}

// ─────────────────────────────────────────────
// PATIENT INFO
// Merges the caller-supplied patient object with the stored session so
// email / age / gender are always available, regardless of which screen
// triggered the download -- but ONLY for a self-report (the assessment is
// about the logged-in user themself). When a `worker` is passed, this is a
// report for a worker-entered patient, and any field that patient object
// doesn't have must show "Not provided" -- it must never silently borrow
// the worker's own stored email/age/gender.
// ─────────────────────────────────────────────
function drawPatientInfo(doc, patient, worker, y) {
  const stored = getStoredUser();
  const isSelfReport = !worker;

  const name = isSelfReport
    ? field(patient?.name, patient?.full_name, patient?.patient_name, stored?.name)
    : field(patient?.name, patient?.full_name, patient?.patient_name);
  const email = isSelfReport
    ? field(patient?.email, patient?.patient_email, stored?.email)
    : field(patient?.email, patient?.patient_email);
  const ageRaw = isSelfReport
    ? field(patient?.age, patient?.patient_age, stored?.age)
    : field(patient?.age, patient?.patient_age);
  const age    = ageRaw !== "Not provided" ? `${ageRaw} years` : "Not provided";
  const gender = isSelfReport
    ? field(patient?.gender, patient?.patient_gender, stored?.gender)
    : field(patient?.gender, patient?.patient_gender);
  const community = field(patient?.community, patient?.patient_community);

  y = sectionLabel(doc, "Patient Information", y);

  const rows = [
    ["Name",          name  ],
    ["Email Address", email ],
    ["Age",           age   ],
    ["Gender",        gender],
  ];
  // Community and "Screened By" only apply to a worker-entered patient's
  // report -- a self-report (no separate patient, or the patient IS the
  // logged-in user) never has these rows, so its layout stays exactly as
  // it was before this change.
  if (!isSelfReport) {
    rows.push(["Community", community]);
    if (worker?.name) rows.push(["Screened By", field(worker.name)]);
  }

  const colW   = CONTENT_W / 2;
  const rowH   = 14;
  const nRows  = Math.ceil(rows.length / 2);
  const boxH   = rowH * nRows;

  doc.setFillColor(...PANEL);
  doc.setDrawColor(...BORDER);
  doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 2, 2, "FD");

  rows.forEach((row, i) => {
    const col    = i % 2;
    const rowIdx = Math.floor(i / 2);
    const x      = MARGIN + 6 + col * colW;
    const ry     = y + 7 + rowIdx * rowH;

    doc.setFontSize(7.2);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...MUTED);
    doc.text(row[0].toUpperCase(), x, ry);

    doc.setFontSize(10.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...INK);
    const valueLines = doc.splitTextToSize(row[1], colW - 12);
    doc.text(valueLines[0], x, ry + 5.5);
  });

  return y + boxH + 8;
}

// ─────────────────────────────────────────────
// CLINICAL SUMMARY
// ─────────────────────────────────────────────
function drawClinicalSummary(doc, diagnosis, y) {
  y = sectionLabel(doc, "Clinical Summary", y);

  const risk      = diagnosis.risk || "None";
  const rgb       = RISK_RGB[risk] || RISK_RGB.Medium;
  const confPct   = Math.round((diagnosis.confidence || 0) * 100);
  const hasExpl   = !!diagnosis.explanation;
  const explLines = hasExpl
    ? doc.splitTextToSize(diagnosis.explanation, CONTENT_W - 12)
    : [];
  const boxH = hasExpl ? 32 + explLines.length * 4.2 : 30;

  doc.setFillColor(...PANEL);
  doc.setDrawColor(...BORDER);
  doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 2, 2, "FD");

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...MUTED);
  doc.text("PREDICTED CONDITION", MARGIN + 6, y + 8);

  doc.setFontSize(15);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...INK);
  const diseaseText  = diagnosis.disease || "No condition identified";
  const diseaseLines = doc.splitTextToSize(diseaseText, CONTENT_W - 48);
  doc.text(diseaseLines[0], MARGIN + 6, y + 17);

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...MUTED);
  doc.text(`Model confidence: ${confPct}%`, MARGIN + 6, y + 24);

  const badgeW = 32;
  const badgeX = PAGE_W - MARGIN - badgeW - 6;
  doc.setFillColor(...rgb);
  doc.roundedRect(badgeX, y + 6, badgeW, 9.5, 4.75, 4.75, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.text(`${risk} Risk`, badgeX + badgeW / 2, y + 12.3, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setTextColor(...INK);

  if (hasExpl) {
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    doc.text(explLines, MARGIN + 6, y + 30);
  }

  return y + boxH + 8;
}

// ─────────────────────────────────────────────
// RED FLAGS
// High-visibility warning block for dangerous symptom patterns, rendered
// right after the clinical summary so a clinician skimming the report
// cannot miss it. Omitted entirely when there are no red flags, so a
// report with none is byte-for-byte unchanged from before this feature.
// ─────────────────────────────────────────────
function drawRedFlags(doc, redFlags, y) {
  if (!redFlags || redFlags.length === 0) return y;

  const rgb = RISK_RGB.High;
  const msgLines = redFlags.map((msg) => doc.splitTextToSize(String(msg), CONTENT_W - 20));
  const totalLines = msgLines.reduce((sum, lines) => sum + lines.length, 0);
  const boxH = 14 + totalLines * 4.6 + (redFlags.length - 1) * 2;

  doc.setFillColor(253, 236, 236);
  doc.setDrawColor(...rgb);
  doc.setLineWidth(0.6);
  doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 2, 2, "FD");

  doc.setFontSize(9.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...rgb);
  doc.text("URGENT — SEEK CARE NOW", MARGIN + 6, y + 8);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...INK);
  let ly = y + 15;
  msgLines.forEach((lines) => {
    doc.text(lines, MARGIN + 6, ly);
    ly += lines.length * 4.6 + 2;
  });

  doc.setTextColor(...INK);
  return y + boxH + 8;
}

// ─────────────────────────────────────────────
// DIFFERENTIAL DIAGNOSIS
// ─────────────────────────────────────────────
function drawDifferential(doc, diagnosis, y) {
  const scores = diagnosis.all_scores || {};
  const others = Object.entries(scores)
    .filter(([d]) => d !== diagnosis.disease)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (others.length === 0) return y;

  y = sectionLabel(doc, "Differential Diagnosis — Other Possibilities", y);

  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...MUTED);
  doc.text("CONDITION", MARGIN, y);
  doc.text("PROBABILITY", PAGE_W - MARGIN, y, { align: "right" });
  doc.setFont("helvetica", "normal");
  y += 3;
  doc.setDrawColor(...BORDER);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 6;

  const barW = 32;
  const barX = PAGE_W - MARGIN - barW - 14;

  others.forEach(([d, v]) => {
    const pct = Math.round(v * 100);
    doc.setFontSize(9.5);
    doc.setTextColor(...INK);
    const nameLines = doc.splitTextToSize(d, barX - MARGIN - 6);
    doc.text(nameLines[0], MARGIN, y + 3);

    doc.setFillColor(235, 238, 240);
    doc.roundedRect(barX, y, barW, 4, 1, 1, "F");
    doc.setFillColor(...MUTED);
    doc.roundedRect(barX, y, Math.max(barW * (pct / 100), 1.2), 4, 1, 1, "F");

    doc.setFontSize(8.5);
    doc.text(`${pct}%`, PAGE_W - MARGIN, y + 3.3, { align: "right" });
    y += 9;
  });

  return y + 2;
}

// ─────────────────────────────────────────────
// REPORTED SYMPTOMS
// ─────────────────────────────────────────────
function drawSymptoms(doc, symptoms, y) {
  if (!symptoms || symptoms.length === 0) return y;

  y = sectionLabel(doc, `Reported Symptoms (${symptoms.length})`, y);

  const labels = symptoms.map((s) => s.replace(/_/g, " "));
  doc.setFontSize(8.5);

  let x     = MARGIN;
  let lineY = y + 1;
  const chipH   = 6.5;
  const lineGap = 8.5;

  labels.forEach((label) => {
    const w = doc.getTextWidth(label) + 7;
    if (x + w > PAGE_W - MARGIN) {
      x = MARGIN;
      lineY += lineGap;
    }
    doc.setFillColor(238, 252, 250);
    doc.setDrawColor(189, 240, 234);
    doc.roundedRect(x, lineY - 4.6, w, chipH, 2, 2, "FD");
    doc.setTextColor(...TEAL_D);
    doc.text(label, x + 3.5, lineY);
    doc.setTextColor(...INK);
    x += w + 3;
  });

  return lineY + 9;
}

// ─────────────────────────────────────────────
// RECOMMENDATIONS
// ─────────────────────────────────────────────
function drawRecommendations(doc, rec, y) {
  if (!rec) return y;

  const items = [
    ["Home Care",            rec.home_care],
    ["Recommended Test",     rec.test     ],
    ["Doctor / Clinic Visit",rec.doctor   ],
    ["Safety Note",          rec.safety   ],
  ].filter((i) => i[1] && String(i[1]).trim().length > 0);

  if (items.length === 0) return y;

  y = sectionLabel(doc, "Clinical Recommendations", y);

  items.forEach(([label, text]) => {
    const lines = doc.splitTextToSize(String(text), CONTENT_W - 10);
    const boxH  = 9.5 + lines.length * 4.4;

    y = ensureSpace(doc, y, boxH + 4);

    doc.setFillColor(250, 250, 251);
    doc.setDrawColor(...BORDER);
    doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 1.5, 1.5, "FD");

    doc.setFontSize(7.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...TEAL_D);
    doc.text(label.toUpperCase(), MARGIN + 5, y + 6);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...INK);
    doc.text(lines, MARGIN + 5, y + 11.5);

    y += boxH + 4;
  });

  return y + 2;
}

// ─────────────────────────────────────────────
// ASSESSMENT QUESTIONS
// Lists every question that was answered "Yes" during the assessment,
// each tagged with the symptom it maps to. Prefers the confidence
// trajectory (preserves the exact order the questions were asked in);
// falls back to the active symptoms list when no trajectory is present.
// ─────────────────────────────────────────────
function drawAssessmentQuestions(doc, trajectory, activeSymptoms, y) {
  let confirmed = [];

  if (trajectory && trajectory.length > 0) {
    confirmed = trajectory
      .filter((step) => step.answer === true)
      .map((step) => {
        const { question, category } = resolveQuestion(step.symptom);
        return { symptom: step.symptom, question, category };
      });
  } else if (activeSymptoms && activeSymptoms.length > 0) {
    confirmed = activeSymptoms.map((symptom) => {
      const { question, category } = resolveQuestion(symptom);
      return { symptom, question, category };
    });
  }

  if (confirmed.length === 0) return y;

  y = sectionLabel(doc, `Assessment Questions — Answered Yes (${confirmed.length})`, y);

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...MUTED);
  doc.text(
    "Each item below was a question in the symptom assessment that the patient answered \"Yes\" to.",
    MARGIN,
    y
  );
  y += 7;

  confirmed.forEach((item, idx) => {
    const qLines   = doc.splitTextToSize(item.question, CONTENT_W - 16);
    const tag      = `Symptom: ${symptomLabel(item.symptom)}`;
    const tagW     = doc.getTextWidth(tag) + 7;
    const catTag   = item.category;
    const catW     = doc.getTextWidth(catTag) + 7;
    const textH    = qLines.length * 4.2;
    const boxH     = textH + 15;

    y = ensureSpace(doc, y, boxH + 3);

    doc.setFillColor(...PANEL);
    doc.setDrawColor(...BORDER);
    doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 1.5, 1.5, "FD");

    // Numbered marker
    doc.setFillColor(...TEAL);
    doc.circle(MARGIN + 7, y + 8, 3.4, "F");
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text(String(idx + 1), MARGIN + 7, y + 9.2, { align: "center" });

    // Question text
    doc.setFontSize(9.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...INK);
    doc.text(qLines, MARGIN + 15, y + 7.5);

    // Symptom + category tags
    const tagY = y + 7.5 + textH + 2.5;
    doc.setFillColor(238, 252, 250);
    doc.setDrawColor(189, 240, 234);
    doc.roundedRect(MARGIN + 15, tagY - 3.6, tagW, 5.4, 2, 2, "FD");
    doc.setFontSize(7);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...TEAL_D);
    doc.text(tag, MARGIN + 15 + 3.5, tagY);

    doc.setFillColor(245, 246, 247);
    doc.setDrawColor(...BORDER);
    doc.roundedRect(MARGIN + 15 + tagW + 3, tagY - 3.6, catW, 5.4, 2, 2, "FD");
    doc.setTextColor(...MUTED);
    doc.text(catTag, MARGIN + 15 + tagW + 3 + 3.5, tagY);
    doc.setTextColor(...INK);

    y += boxH + 3;
  });

  return y + 2;
}

// ─────────────────────────────────────────────
// CONFIDENCE EVOLUTION CHART
// Only plots steps where the patient answered Yes — these are the only
// points that actually moved the model's reasoning. Each x-axis label
// sits directly beneath its own node via equal-slot positioning.
// ─────────────────────────────────────────────
function drawConfidenceChart(doc, trajectory, y) {
  if (!trajectory || trajectory.length === 0) return y;

  // Keep only confirmed (Yes) steps
  const confirmedSteps = trajectory.filter((step) => step.answer === true);
  if (confirmedSteps.length === 0) return y;

  // Identify top diseases across confirmed steps
  const peak = {};
  confirmedSteps.forEach((step) => {
    Object.entries(step.scores || {}).forEach(([d, v]) => {
      peak[d] = Math.max(peak[d] || 0, v);
    });
  });
  const diseases = Object.entries(peak)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([d]) => d);
  if (diseases.length === 0) return y;

  const n           = confirmedSteps.length;
  const legendRows  = Math.ceil(diseases.length / 2);
  const legendH     = legendRows * 5 + 4;
  const chartH      = 56;
  const xLabelH     = 22;
  const introH      = 13;
  const totalBlock  = introH + legendH + chartH + xLabelH + 14;

  y = ensureSpace(doc, y, totalBlock);
  y = sectionLabel(doc, "Confidence Evolution", y);

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...MUTED);
  doc.text(
    "Model probability for the leading conditions after each confirmed (Yes) symptom.",
    MARGIN,
    y
  );
  y += 7;

  // Legend — wraps onto multiple rows so it never overlaps the chart lines
  let lx = MARGIN;
  let ly = y;
  doc.setFontSize(7.5);
  diseases.forEach((d, idx) => {
    const color  = LINE_COLORS[idx % LINE_COLORS.length];
    const labelW = doc.getTextWidth(d) + 9;
    if (lx + labelW > PAGE_W - MARGIN) { lx = MARGIN; ly += 5; }
    doc.setFillColor(...color);
    doc.rect(lx, ly - 2.4, 3, 3, "F");
    doc.setTextColor(...INK);
    doc.text(d, lx + 4.5, ly);
    lx += labelW;
  });
  y = ly + 7;

  const chartW = CONTENT_W - 14;
  const chartX = MARGIN + 12;
  const chartY = y;

  // Gridlines and y-axis labels
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.2);
  for (let p = 0; p <= 100; p += 20) {
    const gy = chartY + chartH - (p / 100) * chartH;
    doc.line(chartX, gy, chartX + chartW, gy);
    doc.setFontSize(6.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...MUTED);
    doc.text(`${p}%`, chartX - 3, gy + 1, { align: "right" });
  }

  // Chart border axes
  doc.setDrawColor(150);
  doc.setLineWidth(0.3);
  doc.line(chartX, chartY, chartX, chartY + chartH);
  doc.line(chartX, chartY + chartH, chartX + chartW, chartY + chartH);

  // Equal-slot x positioning — every node is centred in its own slot so
  // each x-axis label sits directly beneath its own data point with no
  // possibility of drifting toward a neighbouring point.
  const slotW = chartW / n;
  const xPos  = (i) => chartX + slotW * i + slotW / 2;

  // Plot one polyline per disease
  diseases.forEach((d, idx) => {
    const color = LINE_COLORS[idx % LINE_COLORS.length];
    doc.setDrawColor(...color);
    doc.setLineWidth(0.6);
    let prevX = null;
    let prevY = null;
    confirmedSteps.forEach((step, i) => {
      const v  = (step.scores && step.scores[d]) || 0;
      const x  = xPos(i);
      const yy = chartY + chartH - Math.min(v, 1) * chartH;
      if (prevX !== null) doc.line(prevX, prevY, x, yy);
      doc.setFillColor(...color);
      doc.circle(x, yy, 0.8, "F");
      prevX = x;
      prevY = yy;
    });
  });

  // Tick marks — short vertical lines from the baseline down to the label
  // area, one per confirmed step, aligned exactly under each node.
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.25);
  confirmedSteps.forEach((_, i) => {
    const x = xPos(i);
    doc.line(x, chartY + chartH, x, chartY + chartH + 2.5);
  });

  // x-axis labels — rotated 45 degrees, anchored at the tick mark so the
  // start of each label is visually attached to its own node. Labels are
  // abbreviated when there are many confirmed symptoms so they never
  // overlap; every plotted point still has a visible label.
  const maxFullLabels = 10;
  doc.setFontSize(6.2);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...INK);
  confirmedSteps.forEach((step, i) => {
    const x = xPos(i);
    let label = (step.symptom || "").replace(/_/g, " ");
    if (n > maxFullLabels && label.length > 12) {
      label = label.slice(0, 11) + "...";
    }
    doc.text(label, x + 1, chartY + chartH + 6, { angle: 45, maxWidth: 26 });
  });

  doc.setTextColor(...INK);
  return chartY + chartH + xLabelH + 8;
}

// ─────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────
export function generateTropiCareReport({ patient, diagnosis, worker }) {
  if (!diagnosis) {
    throw new Error("No diagnosis data available to generate a report.");
  }

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  doc.setFont("helvetica", "normal");

  const reportId = makeReportId();
  const dateStr  = fmtDate(diagnosis.created_at);

  let y = drawHeader(doc, reportId, dateStr);
  y = drawPatientInfo(doc, patient, worker, y);

  y = ensureSpace(doc, y, 40);
  y = drawClinicalSummary(doc, diagnosis, y);

  y = ensureSpace(doc, y, 20);
  y = drawRedFlags(doc, diagnosis.red_flags, y);

  y = ensureSpace(doc, y, 30);
  y = drawDifferential(doc, diagnosis, y);

  y = ensureSpace(doc, y, 20);
  y = drawSymptoms(doc, diagnosis.active_symptoms, y);

  y = ensureSpace(doc, y, 30);
  y = drawRecommendations(doc, diagnosis.recommendation, y);

  y = ensureSpace(doc, y, 20);
  y = drawAssessmentQuestions(doc, diagnosis.confidence_trajectory, diagnosis.active_symptoms, y);

  y = drawConfidenceChart(doc, diagnosis.confidence_trajectory, y);

  // Signature line on the final page
  y = ensureSpace(doc, y, 26);
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, y + 14, MARGIN + 70, y + 14);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...MUTED);
  doc.text("Clinician signature / date", MARGIN, y + 18);

  drawPageFooter(doc);

  const isSelfReport = !worker;
  const stored   = getStoredUser();
  const safeName = (
    isSelfReport
      ? field(patient?.name, patient?.patient_name, stored?.name)
      : field(patient?.name, patient?.patient_name, "Patient")
  ).replace(/[^a-z0-9]+/gi, "_");
  const fileDate = new Date().toISOString().slice(0, 10);
  doc.save(`TropiCare_Report_${safeName}_${fileDate}.pdf`);
}
