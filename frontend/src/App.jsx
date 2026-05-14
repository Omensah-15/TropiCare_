/*
 * TropiCare — App.jsx
 * Backend: FastAPI (tropicare.onrender.com)
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────
// BACKEND CONFIG
// ─────────────────────────────────────────────
const API_BASE = "https://tropicare.onrender.com/api/v1";

import { SYMPTOM_IMAGES, getCategoryImage } from "./symptomImages.js";

// ─────────────────────────────────────────────
// API CLIENT
// ─────────────────────────────────────────────
let _token = null;

const api = {
  setToken: (t) => { _token = t; },
  getToken: () => _token,

  headers: () => ({
    "Content-Type": "application/json",
    ...(_token ? { Authorization: `Bearer ${_token}` } : {}),
  }),

  async call(method, path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: api.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  },

  get:    (path)       => api.call("GET",    path),
  post:   (path, body) => api.call("POST",   path, body),
  put:    (path, body) => api.call("PUT",    path, body),
  delete: (path)       => api.call("DELETE", path),
};

// ─────────────────────────────────────────────
// LOCAL SESSION STORE
// ─────────────────────────────────────────────
const Store = {
  get:    (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set:    (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  remove: (k) => localStorage.removeItem(k),
};

// ─────────────────────────────────────────────
// RISK HELPERS
// ─────────────────────────────────────────────
const RISK_COLOR = {
  High:   "#ef4444",
  Medium: "#f59e0b",
  Low:    "#22c55e",
};
const RISK_BG = {
  High:   "#fef2f2",
  Medium: "#fffbeb",
  Low:    "#f0fdf4",
};

// ─────────────────────────────────────────────
// DISEASE / SYMPTOM DATA
// ─────────────────────────────────────────────
const DISEASE_SYMPTOM_MAP = {
  Malaria:                ["high_fever","chills","sweating","headache","muscle_pain","vomiting","fatigue","joint_pain","nausea","malaise","loss_of_appetite","fast_heart_rate","confusion","coma"],
  Typhoid:                ["high_fever","headache","fatigue","loss_of_appetite","vomiting","constipation","toxic_look","abdominal_pain","diarrhoea","loss_of_appetite_fever","fast_heart_rate","red_spots_over_body","confusion"],
  Dengue:                 ["high_fever","headache","pain_behind_eyes","muscle_pain","joint_pain","skin_rash","red_spots_over_body","vomiting","fatigue","malaise","fast_heart_rate","swelled_lymph_nodes"],
  Tuberculosis:           ["cough","blood_in_sputum","weight_loss","fatigue","sweating","chest_pain","breathlessness","phlegm","loss_of_appetite","high_fever","swollen_lymph_neck","family_history"],
  "Hepatitis B":          ["yellowing_of_eyes","yellowish_skin","dark_urine","fatigue","blood_transfusion","unsterile_injections","abdominal_pain","nausea","loss_of_appetite","internal_itching","acute_liver_failure"],
  "Hepatitis C":          ["yellowing_of_eyes","yellowish_skin","fatigue","nausea","loss_of_appetite","blood_transfusion","dark_urine","weight_loss","internal_itching","abdominal_pain"],
  "Hepatitis D":          ["yellowing_of_eyes","yellowish_skin","dark_urine","fatigue","acute_liver_failure","fluid_overload","blood_transfusion","unsterile_injections","swelling_stomach"],
  Pneumonia:              ["cough","breathlessness","chest_pain","high_fever","rusty_sputum","chills","fatigue","phlegm","loss_of_appetite","malaise"],
  "Hepatitis A":          ["yellowing_of_eyes","yellowish_skin","dark_urine","fatigue","loss_of_appetite","nausea","abdominal_pain","vomiting","mild_fever","malaise","distension_of_abdomen"],
  "Hepatitis E":          ["yellowing_of_eyes","yellowish_skin","fatigue","loss_of_appetite","nausea","mild_fever","yellow_urine","abdominal_pain","malaise"],
  "Alcoholic Hepatitis":  ["yellowing_of_eyes","vomiting","abdominal_pain","alcohol_history","swelling_stomach","fluid_overload","yellowish_skin","acute_liver_failure","distension_of_abdomen"],
  Jaundice:               ["yellowing_of_eyes","yellowish_skin","dark_urine","yellow_urine","itching","fatigue","abdominal_pain","internal_itching","fluid_overload","distension_of_abdomen"],
  "Chicken Pox":          ["skin_rash","itching","red_spots_over_body","mild_fever","fatigue","headache","loss_of_appetite","nodal_skin_eruptions"],
  "Bronchial Asthma":     ["breathlessness","cough","phlegm","chest_pain","fatigue"],
  "Urinary Tract Infection": ["burning_micturition","urinating_frequently","continuous_feel_of_urine","bladder_discomfort","foul_smell_of_urine","spotting_urination","back_pain"],
  "Dimorphic Haemorrhoids": ["bloody_stool","pain_anal_region","pain_bowel_movements","constipation","passage_of_gases","irritation_anus"],
  "Peptic Ulcer Disease": ["stomach_pain","indigestion","vomiting","loss_of_appetite","nausea","stomach_bleeding","abdominal_pain","passage_of_gases"],
  Diabetes:               ["polyuria","excessive_hunger","irregular_sugar_level","weight_loss","fatigue","blurred_vision","urinating_frequently","increased_appetite","family_history","obesity"],
  "Fungal Infection":     ["itching","skin_rash","dischromic_patches","nodal_skin_eruptions","irritation_anus"],
  Allergy:                ["continuous_sneezing","runny_nose","itching","watering_from_eyes","skin_rash","redness_of_eyes","throat_irritation","mild_fever","joint_pain"],
  "Common Cold":          ["runny_nose","continuous_sneezing","throat_irritation","mild_fever","cough","headache","sinus_pressure","watering_from_eyes","loss_of_smell"],
  "Drug Reaction":        ["itching","skin_rash","red_spots_over_body","fatigue","nausea","diarrhoea"],
};

const RISK_MAP = {
  Malaria:"High", Typhoid:"High", Dengue:"High", Tuberculosis:"High",
  "Hepatitis B":"High", "Hepatitis C":"High", "Hepatitis D":"High", Pneumonia:"High",
  "Hepatitis A":"Medium", "Hepatitis E":"Medium", "Alcoholic Hepatitis":"Medium",
  Jaundice:"Medium", "Chicken Pox":"Medium", "Bronchial Asthma":"Medium",
  "Urinary Tract Infection":"Medium", "Dimorphic Haemorrhoids":"Medium",
  "Peptic Ulcer Disease":"Medium", Diabetes:"Medium",
  "Fungal Infection":"Low", Allergy:"Low", "Common Cold":"Low", "Drug Reaction":"Low",
};

const ALL_QUESTIONS = [
  {id:"high_fever",question:"Do you have a high fever?",category:"General"},
  {id:"mild_fever",question:"Do you have a mild fever?",category:"General"},
  {id:"fatigue",question:"Do you feel unusually tired or weak?",category:"General"},
  {id:"malaise",question:"Do you feel generally unwell?",category:"General"},
  {id:"chills",question:"Do you have chills or shivering?",category:"General"},
  {id:"sweating",question:"Do you have episodes of sweating?",category:"General"},
  {id:"headache",question:"Do you have headaches?",category:"General"},
  {id:"muscle_pain",question:"Do you have muscle pain or body aches?",category:"General"},
  {id:"joint_pain",question:"Do you have joint pain?",category:"General"},
  {id:"back_pain",question:"Do you have back pain?",category:"General"},
  {id:"cough",question:"Do you have a cough?",category:"Respiratory"},
  {id:"phlegm",question:"Are you coughing up phlegm or mucus?",category:"Respiratory"},
  {id:"rusty_sputum",question:"Are you coughing up rusty or brown-coloured sputum?",category:"Respiratory"},
  {id:"blood_in_sputum",question:"Are you coughing up blood?",category:"Respiratory"},
  {id:"breathlessness",question:"Do you have difficulty breathing?",category:"Respiratory"},
  {id:"chest_pain",question:"Do you have chest pain?",category:"Respiratory"},
  {id:"runny_nose",question:"Do you have a runny nose?",category:"Respiratory"},
  {id:"continuous_sneezing",question:"Do you sneeze frequently?",category:"Respiratory"},
  {id:"throat_irritation",question:"Do you have a sore or irritated throat?",category:"Respiratory"},
  {id:"sinus_pressure",question:"Do you have sinus pressure or nasal congestion?",category:"Respiratory"},
  {id:"watering_from_eyes",question:"Do you have watery eyes?",category:"Respiratory"},
  {id:"loss_of_smell",question:"Have you lost your sense of smell?",category:"Respiratory"},
  {id:"nausea",question:"Do you feel nauseous?",category:"Digestive"},
  {id:"vomiting",question:"Have you been vomiting?",category:"Digestive"},
  {id:"diarrhoea",question:"Do you have diarrhoea?",category:"Digestive"},
  {id:"stomach_pain",question:"Do you have stomach pain?",category:"Digestive"},
  {id:"abdominal_pain",question:"Do you have abdominal or belly pain?",category:"Digestive"},
  {id:"indigestion",question:"Do you have indigestion or acidity?",category:"Digestive"},
  {id:"distension_of_abdomen",question:"Do you feel bloated or have a distended abdomen?",category:"Digestive"},
  {id:"constipation",question:"Do you have constipation?",category:"Digestive"},
  {id:"passage_of_gases",question:"Do you have excessive gas?",category:"Digestive"},
  {id:"bloody_stool",question:"Do you notice blood in your stool?",category:"Digestive"},
  {id:"loss_of_appetite",question:"Have you lost your appetite?",category:"Digestive"},
  {id:"stomach_bleeding",question:"Do you have stomach bleeding?",category:"Digestive"},
  {id:"yellowish_skin",question:"Is your skin yellowish or jaundiced?",category:"Liver"},
  {id:"yellowing_of_eyes",question:"Are the whites of your eyes turning yellow?",category:"Liver"},
  {id:"dark_urine",question:"Is your urine dark or tea-coloured?",category:"Liver"},
  {id:"yellow_urine",question:"Is your urine unusually yellow?",category:"Liver"},
  {id:"internal_itching",question:"Do you experience internal itching?",category:"Liver"},
  {id:"acute_liver_failure",question:"Do you have signs of acute liver failure?",category:"Liver"},
  {id:"fluid_overload",question:"Do you have abnormal body swelling or fluid retention?",category:"Liver"},
  {id:"itching",question:"Do you have itchy skin?",category:"Skin"},
  {id:"skin_rash",question:"Do you have a skin rash?",category:"Skin"},
  {id:"red_spots_over_body",question:"Do you have red spots on your body?",category:"Skin"},
  {id:"nodal_skin_eruptions",question:"Do you have nodules or skin eruptions?",category:"Skin"},
  {id:"dischromic_patches",question:"Do you have discoloured patches on your skin?",category:"Skin"},
  {id:"redness_of_eyes",question:"Do you have red or irritated eyes?",category:"Eyes"},
  {id:"blurred_vision",question:"Do you have blurred or distorted vision?",category:"Eyes"},
  {id:"pain_behind_eyes",question:"Do you have pain behind your eyes?",category:"Eyes"},
  {id:"burning_micturition",question:"Do you feel a burning sensation when urinating?",category:"Urinary"},
  {id:"urinating_frequently",question:"Do you urinate much more than usual?",category:"Urinary"},
  {id:"continuous_feel_of_urine",question:"Do you have a persistent urge to urinate?",category:"Urinary"},
  {id:"bladder_discomfort",question:"Do you have bladder discomfort?",category:"Urinary"},
  {id:"foul_smell_of_urine",question:"Does your urine have an unusual smell?",category:"Urinary"},
  {id:"spotting_urination",question:"Do you notice spotting during urination?",category:"Urinary"},
  {id:"pain_anal_region",question:"Do you have pain in your anal region?",category:"Rectal"},
  {id:"pain_bowel_movements",question:"Do you have pain during bowel movements?",category:"Rectal"},
  {id:"irritation_anus",question:"Do you have irritation around the anus?",category:"Rectal"},
  {id:"restlessness",question:"Do you feel restless or agitated?",category:"Neurological"},
  {id:"mood_swings",question:"Have you been experiencing mood swings?",category:"Neurological"},
  {id:"confusion",question:"Do you feel confused or disoriented?",category:"Neurological"},
  {id:"coma",question:"Have you experienced any loss of consciousness?",category:"Neurological"},
  {id:"excessive_hunger",question:"Are you excessively hungry?",category:"Metabolic"},
  {id:"increased_appetite",question:"Has your appetite increased significantly?",category:"Metabolic"},
  {id:"irregular_sugar_level",question:"Do you have an irregular blood sugar level?",category:"Metabolic"},
  {id:"polyuria",question:"Do you urinate in unusually large amounts?",category:"Metabolic"},
  {id:"dehydration",question:"Do you feel severely dehydrated?",category:"Metabolic"},
  {id:"weight_loss",question:"Have you experienced unexplained weight loss?",category:"Metabolic"},
  {id:"obesity",question:"Are you significantly overweight?",category:"Metabolic"},
  {id:"swelled_lymph_nodes",question:"Do you have swollen lymph nodes?",category:"Infection"},
  {id:"swelling_stomach",question:"Is your stomach area swollen?",category:"Infection"},
  {id:"fast_heart_rate",question:"Do you have a fast or irregular heartbeat?",category:"Infection"},
  {id:"toxic_look",question:"Do you look or feel severely ill?",category:"Infection"},
  {id:"swollen_lymph_neck",question:"Do you have swollen lymph nodes in the neck or armpit?",category:"Infection"},
  {id:"loss_of_appetite_fever",question:"Have you lost your appetite alongside a fever?",category:"Infection"},
  {id:"family_history",question:"Do you have a family history of this condition?",category:"History"},
  {id:"blood_transfusion",question:"Have you received a blood transfusion recently?",category:"History"},
  {id:"unsterile_injections",question:"Have you been injected with unsterile equipment?",category:"History"},
  {id:"alcohol_history",question:"Do you have a history of heavy alcohol use?",category:"History"},
];

const Q_INDEX = Object.fromEntries(ALL_QUESTIONS.map((q) => [q.id, q]));

function scoreDisease(disease, answers) {
  let score = 0;
  for (const s of DISEASE_SYMPTOM_MAP[disease] || []) {
    if (answers[s] === true)  score += 3;
    if (answers[s] === false) score -= 1;
  }
  return score;
}

function getNextQuestionOffline(answers, asked) {
  const ranked = Object.keys(DISEASE_SYMPTOM_MAP)
    .map((d) => ({ d, sc: scoreDisease(d, answers) }))
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 6)
    .map((x) => x.d);

  for (const disease of ranked) {
    for (const sym of DISEASE_SYMPTOM_MAP[disease] || []) {
      if (!asked.includes(sym)) {
        const q = Q_INDEX[sym];
        if (q) return q;
      }
    }
  }
  return ALL_QUESTIONS.find((q) => !asked.includes(q.id)) || null;
}

function predictOffline(answers) {
  const sorted = Object.keys(DISEASE_SYMPTOM_MAP)
    .map((d) => {
      const syms = DISEASE_SYMPTOM_MAP[d] || [];
      const yes  = syms.filter((s) => answers[s] === true).length;
      return {
        d,
        sc:   scoreDisease(d, answers),
        conf: Math.min(0.95, Math.max(0.35, yes / Math.max(syms.length, 1))),
      };
    })
    .sort((a, b) => b.sc - a.sc);

  const top  = sorted[0];
  const risk = RISK_MAP[top.d] || "Medium";

  return {
    disease:    top.d,
    confidence: top.conf,
    risk,
    explanation: `The reported symptoms are consistent with ${top.d}.`,
    recommendation: {
      home_care: "Rest, stay hydrated, and monitor your symptoms closely.",
      test:      "Consult a healthcare provider to arrange appropriate diagnostic tests.",
      doctor:    risk === "High" ? "Visit a hospital or clinic without delay." : "See a doctor if symptoms persist or worsen.",
      safety:    risk === "High" ? "Do not wait — seek medical attention today." : "",
    },
    all_scores: Object.fromEntries(
      sorted.slice(0, 6).map((x) => [x.d, parseFloat(x.conf.toFixed(4))])
    ),
    method: "offline-scoring",
  };
}

// ─────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────
const injectStyles = () => {
  if (document.getElementById("tc-styles")) return;
  const el = document.createElement("style");
  el.id = "tc-styles";
  el.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&family=Playfair+Display:ital,wght@0,600;0,700;1,600&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --teal:      #0d9488;
      --teal-d:    #0f766e;
      --teal-l:    #ccfbf1;
      --teal-xl:   #f0fdfa;
      --red:       #ef4444;
      --red-l:     #fef2f2;
      --amber:     #f59e0b;
      --amber-l:   #fffbeb;
      --green:     #22c55e;
      --green-l:   #f0fdf4;
      --blue:      #3b82f6;
      --blue-l:    #eff6ff;
      --ink:       #0f172a;
      --ink-2:     #1e293b;
      --ink-3:     #334155;
      --muted:     #64748b;
      --muted-l:   #94a3b8;
      --border:    #e2e8f0;
      --border-l:  #f1f5f9;
      --surface:   #ffffff;
      --bg:        #f8fafc;
      --font:      'Sora', sans-serif;
      --display:   'Playfair Display', serif;
      --radius-s:  10px;
      --radius:    16px;
      --radius-l:  24px;
      --shadow-s:  0 1px 4px rgba(0,0,0,0.06);
      --shadow:    0 4px 20px rgba(0,0,0,0.08);
      --shadow-l:  0 8px 40px rgba(0,0,0,0.12);
    }

    html, body { height: 100%; font-family: var(--font); background: var(--bg); color: var(--ink); -webkit-font-smoothing: antialiased; }
    #root { height: 100%; }

    .shell    { display: flex; height: 100vh; overflow: hidden; }
    .sidebar  { width: 240px; min-height: 100vh; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; padding: 28px 0; }
    .main     { flex: 1; overflow-y: auto; scroll-behavior: smooth; }
    @media (max-width: 767px) { .sidebar { display: none; } .main { padding-bottom: 72px; } }

    .sidebar-brand { display: flex; align-items: center; gap: 10px; padding: 0 20px 28px; }
    .brand-mark    { width: 36px; height: 36px; background: var(--teal); border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .brand-name    { font-family: var(--display); font-size: 18px; font-weight: 700; color: var(--ink); }
    .brand-sub     { font-size: 10px; color: var(--muted); font-weight: 500; letter-spacing: 0.03em; }
    .sidebar-nav   { flex: 1; padding: 0 10px; }
    .nav-item      { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 14px; border-radius: var(--radius-s); border: none; background: none; font-family: var(--font); font-size: 14px; font-weight: 500; color: var(--muted); cursor: pointer; transition: all 0.18s; margin-bottom: 2px; text-align: left; }
    .nav-item:hover  { background: var(--teal-xl); color: var(--teal); }
    .nav-item.active { background: var(--teal-xl); color: var(--teal); font-weight: 600; }
    .nav-icon        { width: 18px; height: 18px; flex-shrink: 0; }
    .sidebar-foot    { padding: 16px 10px 0; border-top: 1px solid var(--border); margin: 0 10px; }

    .bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; background: var(--surface); border-top: 1px solid var(--border); display: none; z-index: 100; padding: 8px 0 calc(8px + env(safe-area-inset-bottom)); }
    @media (max-width: 767px) { .bottom-nav { display: flex; } }
    .bnav-item { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 4px; border: none; background: none; font-family: var(--font); font-size: 10px; font-weight: 600; color: var(--muted-l); cursor: pointer; transition: color 0.15s; }
    .bnav-item.active { color: var(--teal); }
    .bnav-item svg { width: 20px; height: 20px; }

    .page       { animation: pageIn 0.25s ease; }
    @keyframes pageIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
    .page-head  { padding: 24px 24px 0; }
    .page-body  { padding: 20px 24px 40px; }
    @media (max-width: 767px) { .page-head { padding: 20px 16px 0; } .page-body { padding: 16px 16px 32px; } }

    .t-display   { font-family: var(--display); font-size: 26px; font-weight: 700; color: var(--ink); line-height: 1.2; }
    .t-title     { font-size: 18px; font-weight: 700; color: var(--ink); line-height: 1.3; }
    .t-subtitle  { font-size: 14px; color: var(--muted); font-weight: 400; line-height: 1.55; }
    .t-label     { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); }
    .t-mono      { font-feature-settings: 'tnum'; }

    .card   { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow-s); border: 1px solid var(--border); }
    .card-p { padding: 20px; }

    .btn        { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 13px 22px; border-radius: var(--radius-s); font-family: var(--font); font-size: 14px; font-weight: 600; cursor: pointer; border: none; transition: all 0.18s; line-height: 1; }
    .btn:active { transform: scale(0.97); }
    .btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .btn-primary  { background: var(--teal); color: #fff; box-shadow: 0 4px 14px rgba(13,148,136,0.28); }
    .btn-primary:hover:not(:disabled)  { background: var(--teal-d); box-shadow: 0 6px 18px rgba(13,148,136,0.36); }
    .btn-secondary { background: var(--border-l); color: var(--ink-2); }
    .btn-secondary:hover:not(:disabled) { background: var(--border); }
    .btn-danger   { background: var(--red); color: #fff; }
    .btn-danger:hover:not(:disabled)   { background: #dc2626; }
    .btn-outline  { background: transparent; color: var(--teal); border: 2px solid var(--teal); }
    .btn-outline:hover:not(:disabled) { background: var(--teal-xl); }
    .btn-full  { width: 100%; }
    .btn-lg    { padding: 16px 28px; font-size: 15px; border-radius: var(--radius); }
    .btn-sm    { padding: 9px 16px; font-size: 12px; }

    .field       { margin-bottom: 14px; }
    .field-label { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin-bottom: 6px; }
    .field-input { width: 100%; padding: 12px 14px; border: 2px solid var(--border); border-radius: var(--radius-s); font-family: var(--font); font-size: 14px; color: var(--ink); background: var(--surface); outline: none; transition: border-color 0.18s; }
    .field-input:focus { border-color: var(--teal); }
    .field-input::placeholder { color: var(--muted-l); }
    .field-select { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; background-size: 16px; cursor: pointer; }

    .badge      { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 99px; font-size: 11px; font-weight: 700; }
    .badge-High   { background: var(--red-l);   color: var(--red); }
    .badge-Medium { background: var(--amber-l); color: #92400e; }
    .badge-Low    { background: var(--green-l); color: #15803d; }
    .badge-teal   { background: var(--teal-xl); color: var(--teal); }

    .prog-track { height: 5px; background: var(--border-l); border-radius: 99px; overflow: hidden; }
    .prog-fill  { height: 100%; background: linear-gradient(90deg, #2dd4bf, var(--teal)); border-radius: 99px; transition: width 0.4s cubic-bezier(0.4,0,0.2,1); }

    .divider { height: 1px; background: var(--border); }

    .avatar    { width: 38px; height: 38px; border-radius: 99px; background: var(--teal-xl); display: flex; align-items: center; justify-content: center; color: var(--teal); font-weight: 700; font-size: 14px; flex-shrink: 0; }
    .avatar-lg { width: 64px; height: 64px; font-size: 22px; background: linear-gradient(135deg, var(--teal-l), var(--teal-xl)); }
    .mx-auto   { margin-left: auto; margin-right: auto; }

    .splash { position: fixed; inset: 0; background: linear-gradient(145deg, var(--teal-d) 0%, #0a4f4a 100%); display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 9999; transition: opacity 0.45s ease; }
    .splash.fading { opacity: 0; pointer-events: none; }
    .splash-logo { width: 76px; height: 76px; background: rgba(255,255,255,0.12); border-radius: 22px; display: flex; align-items: center; justify-content: center; margin-bottom: 20px; border: 1px solid rgba(255,255,255,0.18); animation: breathe 2.4s ease-in-out infinite; }
    @keyframes breathe { 0%,100%{transform:scale(1);} 50%{transform:scale(1.04);} }
    .splash-title { font-family: var(--display); font-size: 38px; color: #fff; font-weight: 700; letter-spacing: -0.5px; }
    .splash-sub   { color: rgba(255,255,255,0.6); font-size: 13px; margin-top: 6px; letter-spacing: 0.04em; }
    .splash-dots  { display: flex; gap: 6px; margin-top: 52px; }
    .splash-dot   { width: 6px; height: 6px; border-radius: 99px; background: rgba(255,255,255,0.4); animation: dot-bounce 1.3s ease-in-out infinite; }
    .splash-dot:nth-child(2) { animation-delay: 0.18s; }
    .splash-dot:nth-child(3) { animation-delay: 0.36s; }
    @keyframes dot-bounce { 0%,80%,100%{transform:scale(0.7);opacity:0.4;} 40%{transform:scale(1.1);opacity:1;} }

    .auth-wrap  { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; background: linear-gradient(160deg, var(--teal-xl) 0%, var(--bg) 55%); }
    .auth-box   { width: 100%; max-width: 420px; }
    .auth-logo  { text-align: center; margin-bottom: 36px; }
    .auth-icon  { width: 60px; height: 60px; background: var(--teal); border-radius: 18px; display: flex; align-items: center; justify-content: center; margin: 0 auto 14px; }
    .auth-title { font-family: var(--display); font-size: 28px; color: var(--ink); font-weight: 700; }
    .auth-hint  { font-size: 13px; color: var(--muted); margin-top: 5px; }
    .auth-foot  { text-align: center; margin-top: 18px; font-size: 11px; color: var(--muted-l); line-height: 1.7; }
    .tabs       { display: flex; background: var(--border-l); border-radius: var(--radius-s); padding: 4px; margin-bottom: 22px; }
    .tab        { flex: 1; padding: 9px; text-align: center; border-radius: 8px; font-family: var(--font); font-size: 13px; font-weight: 600; cursor: pointer; border: none; background: none; color: var(--muted); transition: all 0.18s; }
    .tab.active { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-s); }
    .grid-2     { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .pw-wrap    { position: relative; }
    .pw-toggle  { position: absolute; right: 13px; top: 50%; transform: translateY(-50%); border: none; background: none; cursor: pointer; color: var(--muted-l); display: flex; }

    .home-header  { display: flex; align-items: center; justify-content: space-between; padding: 24px 24px 16px; }
    @media (max-width: 767px) { .home-header { padding: 20px 16px 14px; } }
    .greeting     { font-size: 12px; color: var(--muted); margin-bottom: 3px; }
    .hero-card    { margin: 0 24px 20px; padding: 28px; border-radius: var(--radius-l); background: linear-gradient(135deg, var(--teal) 0%, var(--teal-d) 100%); position: relative; overflow: hidden; }
    @media (max-width: 767px) { .hero-card { margin: 0 16px 16px; padding: 22px 20px; } }
    .hero-bg-icon { position: absolute; top: -16px; right: -16px; opacity: 0.08; }
    .hero-eyebrow { font-size: 11px; color: rgba(255,255,255,0.65); font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
    .hero-headline{ font-family: var(--display); font-size: 22px; color: #fff; line-height: 1.3; margin-bottom: 18px; }
    .hero-btn     { display: inline-flex; align-items: center; gap: 6px; background: #fff; color: var(--teal-d); font-family: var(--font); font-size: 13px; font-weight: 700; padding: 11px 20px; border-radius: 10px; border: none; cursor: pointer; transition: box-shadow 0.18s; }
    .hero-btn:hover { box-shadow: 0 6px 20px rgba(0,0,0,0.15); }

    .stats-row  { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 0 24px 20px; }
    @media (max-width: 767px) { .stats-row { padding: 0 16px 16px; gap: 8px; } }
    .stat-card  { background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border); padding: 16px 12px; text-align: center; }
    .stat-icon  { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; margin: 0 auto 8px; }
    .stat-val   { font-size: 20px; font-weight: 800; color: var(--ink); line-height: 1; }
    .stat-lbl   { font-size: 10px; color: var(--muted); font-weight: 600; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.05em; }

    .section     { padding: 0 24px 20px; }
    @media (max-width: 767px) { .section { padding: 0 16px 16px; } }
    .section-ttl { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 10px; }

    .rec-list    { display: flex; flex-direction: column; gap: 8px; }
    .rec-card    { background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border); padding: 14px 16px; display: flex; align-items: center; gap: 12px; cursor: pointer; transition: box-shadow 0.18s; }
    .rec-card:hover { box-shadow: var(--shadow); }
    .rec-icon-wrap { width: 42px; height: 42px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .rec-info    { flex: 1; min-width: 0; }
    .rec-name    { font-size: 14px; font-weight: 600; color: var(--ink); }
    .rec-meta    { font-size: 12px; color: var(--muted); margin-top: 2px; }

    .disease-grid { display: flex; flex-wrap: wrap; gap: 6px; }

    .landing-illus { text-align: center; padding: 12px 0 24px; }
    .landing-illus svg { animation: float 3s ease-in-out infinite; }
    @keyframes float { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-9px);} }
    .feat-list { display: flex; flex-direction: column; gap: 0; }
    .feat-row  { display: flex; align-items: flex-start; gap: 14px; padding: 14px 0; }
    .feat-row + .feat-row { border-top: 1px solid var(--border); }
    .feat-icon { width: 36px; height: 36px; background: var(--teal-xl); border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .feat-title { font-size: 13px; font-weight: 700; color: var(--ink); margin-bottom: 2px; }
    .feat-desc  { font-size: 12px; color: var(--muted); line-height: 1.55; }

    .q-screen   { height: 100vh; display: flex; flex-direction: column; background: var(--bg); }
    .q-topbar   { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
    .q-close    { width: 34px; height: 34px; background: var(--border-l); border-radius: 8px; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
    .q-counter  { font-size: 12px; font-weight: 700; color: var(--muted); width: 38px; text-align: right; flex-shrink: 0; }
    .q-body     { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 20px; }
    .q-cat-pill { display: inline-flex; padding: 4px 12px; background: var(--teal-xl); color: var(--teal); border-radius: 99px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 20px; }
    .q-illus    { width: 160px; height: 160px; margin-bottom: 24px; }
    .q-illus img { width: 100%; height: 100%; object-fit: contain; border-radius: var(--radius); }
    .q-illus-svg { width: 100%; height: 100%; }
    .q-text     { font-family: var(--display); font-size: 22px; font-weight: 700; color: var(--ink); text-align: center; line-height: 1.35; margin-bottom: 32px; max-width: 320px; }
    .q-answers  { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 340px; }
    .ans-btn    { display: flex; align-items: center; gap: 12px; padding: 16px 18px; border-radius: var(--radius); border: 2px solid var(--border); background: var(--surface); font-family: var(--font); font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.18s; }
    .ans-btn:active { transform: scale(0.97); }
    .ans-btn.yes { border-color: #2dd4bf; background: var(--teal-xl); color: var(--teal-d); }
    .ans-btn.yes:hover { background: #ccfbf1; }
    .ans-btn.no  { border-color: var(--border); background: var(--border-l); color: var(--ink-3); }
    .ans-btn.no:hover  { background: var(--border); }
    .ans-btn-icon { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .ans-yes-icon { background: #ccfbf1; }
    .ans-no-icon  { background: var(--border); }
    .q-anim     { animation: qSlide 0.28s cubic-bezier(0.4,0,0.2,1); }
    @keyframes qSlide { from{opacity:0;transform:translateY(14px);} to{opacity:1;transform:none;} }

    .analyzing  { height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; background: var(--bg); gap: 0; }
    .spin-ring  { width: 140px; height: 140px; margin-bottom: 28px; animation: spin-slow 3s linear infinite; }
    @keyframes spin-slow { to { transform: rotate(360deg); } }
    .loading-dots { display: flex; gap: 7px; margin-top: 24px; }
    .ldot       { width: 9px; height: 9px; border-radius: 99px; background: var(--teal); animation: dot-bounce 1.2s ease-in-out infinite; }
    .ldot:nth-child(2) { animation-delay: 0.18s; }
    .ldot:nth-child(3) { animation-delay: 0.36s; }

    .result-ring     { width: 110px; height: 110px; border-radius: 99px; display: flex; align-items: center; justify-content: center; margin: 0 auto 14px; animation: ring-in 0.45s cubic-bezier(0.34,1.56,0.64,1); }
    @keyframes ring-in { from{transform:scale(0.6);opacity:0;} to{transform:scale(1);opacity:1;} }
    .result-ring-High   { background: linear-gradient(135deg, #fee2e2, #fecaca); box-shadow: 0 0 0 10px rgba(239,68,68,0.08); }
    .result-ring-Medium { background: linear-gradient(135deg, #fef3c7, #fde68a); box-shadow: 0 0 0 10px rgba(245,158,11,0.08); }
    .result-ring-Low    { background: linear-gradient(135deg, #dcfce7, #bbf7d0); box-shadow: 0 0 0 10px rgba(34,197,94,0.08); }

    .rec-bubbles    { display: flex; flex-direction: column; gap: 10px; }
    .rec-bubble     { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-radius: var(--radius); border-left: 4px solid transparent; background: var(--surface); box-shadow: var(--shadow-s); animation: bubble-in 0.35s ease both; }
    .rec-bubble:nth-child(1){ animation-delay: 0.05s; }
    .rec-bubble:nth-child(2){ animation-delay: 0.12s; }
    .rec-bubble:nth-child(3){ animation-delay: 0.19s; }
    .rec-bubble:nth-child(4){ animation-delay: 0.26s; }
    @keyframes bubble-in { from{opacity:0;transform:translateX(-8px);} to{opacity:1;transform:none;} }
    .rec-bubble-icon { width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .rec-bubble-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 3px; }
    .rec-bubble-text  { font-size: 13px; color: var(--ink-2); line-height: 1.5; font-weight: 500; }

    .score-bar-row  { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; }
    .score-bar-name { font-size: 12px; color: var(--muted); width: 150px; flex-shrink: 0; }
    .score-bar-track { flex: 1; height: 4px; background: var(--border-l); border-radius: 99px; overflow: hidden; }
    .score-bar-fill { height: 100%; background: var(--border); border-radius: 99px; }
    .score-bar-pct  { font-size: 12px; color: var(--muted); width: 30px; text-align: right; }

    .disclaimer { display: flex; gap: 10px; align-items: flex-start; background: var(--amber-l); border: 1px solid #fde68a; border-radius: var(--radius-s); padding: 12px 14px; }
    .disclaimer p { font-size: 12px; color: #78350f; line-height: 1.55; }

    .search-wrap { position: relative; margin-bottom: 12px; }
    .search-icon { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--muted-l); }
    .search-input { width: 100%; padding: 11px 14px 11px 40px; border: 1.5px solid var(--border); border-radius: var(--radius-s); font-family: var(--font); font-size: 14px; color: var(--ink); background: var(--surface); outline: none; transition: border-color 0.18s; }
    .search-input:focus { border-color: var(--teal); }
    .chip-row   { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 14px; }
    .chip       { padding: 6px 14px; border-radius: 99px; border: 1.5px solid var(--border); font-family: var(--font); font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; background: var(--surface); color: var(--muted); }
    .chip.on    { border-color: var(--teal); background: var(--teal-xl); color: var(--teal); }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 56px 24px; gap: 10px; text-align: center; }

    .profile-head { text-align: center; padding: 24px 0 20px; }
    .menu-list  { display: flex; flex-direction: column; }
    .menu-item  { display: flex; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--border); cursor: pointer; transition: opacity 0.15s; }
    .menu-item:last-child { border-bottom: none; }
    .menu-item:hover { opacity: 0.75; }
    .menu-ico   { width: 34px; height: 34px; background: var(--border-l); border-radius: 9px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }

    .toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; }
    .toggle     { position: relative; width: 42px; height: 23px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle-slider { position: absolute; inset: 0; background: var(--border); border-radius: 99px; cursor: pointer; transition: 0.28s; }
    .toggle input:checked + .toggle-slider { background: var(--teal); }
    .toggle-slider::before { content: ''; position: absolute; height: 17px; width: 17px; left: 3px; bottom: 3px; background: #fff; border-radius: 50%; transition: 0.28s; box-shadow: var(--shadow-s); }
    .toggle input:checked + .toggle-slider::before { transform: translateX(19px); }

    .danger-zone { border: 1.5px solid var(--red); border-radius: var(--radius); padding: 18px; margin-bottom: 20px; }

    .flex       { display: flex; }
    .items-c    { align-items: center; }
    .justify-b  { justify-content: space-between; }
    .gap-2      { gap: 8px; }
    .gap-3      { gap: 12px; }
    .mt-1       { margin-top: 4px; }
    .mt-2       { margin-top: 8px; }
    .mt-3       { margin-top: 12px; }
    .mt-4       { margin-top: 16px; }
    .mb-2       { margin-bottom: 8px; }
    .mb-3       { margin-bottom: 12px; }
    .mb-4       { margin-bottom: 16px; }
    .w-full     { width: 100%; }
    .text-c     { text-align: center; }
    .italic     { font-style: italic; }
    .cursor-p   { cursor: pointer; }
    .notif      { position: fixed; top: 22px; left: 50%; transform: translateX(-50%); background: var(--ink-2); color: #fff; padding: 10px 22px; border-radius: var(--radius-s); font-size: 13px; font-weight: 500; z-index: 9999; animation: notif-in 0.3s ease; white-space: nowrap; }
    @keyframes notif-in { from{opacity:0;transform:translateX(-50%) translateY(-12px);} to{opacity:1;transform:translateX(-50%) translateY(0);} }
  `;
  document.head.appendChild(el);
};

// ─────────────────────────────────────────────
// MEDICAL HEART LOGO SVG
// Minimal, clean ECG-heart hybrid mark
// ─────────────────────────────────────────────
function MedicalHeartMark({ size = 22, color = "#fff" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Heart path */}
      <path
        d="M12 21C12 21 3 14.5 3 8.5C3 5.42 5.42 3 8.5 3C10.24 3 11.91 3.81 13 5.08C14.09 3.81 15.76 3 17.5 3C20.58 3 23 5.42 23 8.5C23 14.5 12 21 12 21Z"
        fill={color}
        opacity="0.92"
      />
      {/* ECG pulse line across heart */}
      <polyline
        points="6,12 8.5,12 9.5,9 10.5,15 11.5,10.5 12.5,13 13.2,12 15.5,12 17.5,12"
        stroke="#0d9488"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

// Larger version for auth screen
function MedicalHeartLarge({ size = 32, color = "#fff" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M16 28C16 28 4 19.5 4 11.5C4 7.36 7.36 4 11.5 4C13.72 4 15.78 5.01 17.2 6.66C18.62 5.01 20.68 4 22.9 4C27.04 4 30.4 7.36 30.4 11.5C30.4 19.5 16 28 16 28Z"
        fill={color}
        opacity="0.9"
      />
      <polyline
        points="8,16 11,16 12.5,12 14,20 15.5,14 16.5,17 17.5,16 20,16 23,16"
        stroke="#0d9488"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

// Splash screen version
function MedicalHeartSplash() {
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M22 38C22 38 6 27 6 16C6 10.48 10.48 6 16 6C18.9 6 21.56 7.38 23.2 9.6C24.84 7.38 27.5 6 30.4 6C35.92 6 40 10.48 40 16C40 27 22 38 22 38Z"
        fill="white"
        opacity="0.9"
      />
      <polyline
        points="10,22 15,22 17,16 19,28 21,19 23,24 25,22 29,22 34,22"
        stroke="#0d9488"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

// ─────────────────────────────────────────────
// CATEGORY ILLUSTRATIONS
// ─────────────────────────────────────────────
const IllusGeneral = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#fef2f2"/>
    <rect x="91" y="38" width="18" height="82" rx="9" fill="#cbd5e1"/>
    <rect x="93" y="78" width="14" height="38" rx="7" fill="#ef4444"/>
    <circle cx="100" cy="128" r="17" fill="#ef4444"/>
    <line x1="72" y1="62" x2="80" y2="62" stroke="#f87171" strokeWidth="2.5" strokeLinecap="round"/>
    <line x1="72" y1="76" x2="78" y2="76" stroke="#f87171" strokeWidth="2.5" strokeLinecap="round"/>
    <line x1="72" y1="90" x2="80" y2="90" stroke="#f87171" strokeWidth="2.5" strokeLinecap="round"/>
    <circle cx="141" cy="68" r="20" fill="#fbbf24" opacity="0.25"/>
    <circle cx="141" cy="68" r="13" fill="#fbbf24" opacity="0.55"/>
    <circle cx="141" cy="68" r="8" fill="#f59e0b"/>
  </svg>
);

const IllusRespiratory = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#eff6ff"/>
    <line x1="100" y1="58" x2="100" y2="108" stroke="#94a3b8" strokeWidth="5" strokeLinecap="round"/>
    <path d="M100 88 Q76 88 66 108 Q56 130 70 146 Q84 160 90 150 Q93 140 100 134" stroke="#3b82f6" strokeWidth="7" fill="none" strokeLinecap="round"/>
    <path d="M100 88 Q124 88 134 108 Q144 130 130 146 Q116 160 110 150 Q107 140 100 134" stroke="#3b82f6" strokeWidth="7" fill="none" strokeLinecap="round"/>
    <ellipse cx="72" cy="146" rx="15" ry="13" fill="#60a5fa"/>
    <ellipse cx="128" cy="146" rx="15" ry="13" fill="#60a5fa"/>
  </svg>
);

const IllusDigestive = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#f0fdf4"/>
    <path d="M85 58 Q65 70 70 92 Q75 112 92 117 Q96 152 100 162 Q104 152 108 117 Q125 112 130 92 Q135 70 115 58 Q108 53 100 52 Q92 53 85 58Z" fill="#4ade80" opacity="0.55"/>
    <circle cx="80" cy="100" r="7" fill="#4ade80"/>
    <circle cx="120" cy="100" r="7" fill="#4ade80"/>
    <path d="M90 86 Q100 95 110 86" stroke="#16a34a" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
  </svg>
);

const IllusLiver = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#fffbeb"/>
    <path d="M55 80 Q50 112 65 136 Q80 159 112 156 Q147 151 151 121 Q155 91 136 76 Q116 60 90 65 Q64 68 55 80Z" fill="#fbbf24" opacity="0.35"/>
    <path d="M55 80 Q50 112 65 136 Q80 159 112 156 Q147 151 151 121 Q155 91 136 76 Q116 60 90 65 Q64 68 55 80Z" stroke="#f59e0b" strokeWidth="2.5" fill="none"/>
    <path d="M90 92 Q110 97 120 112" stroke="#d97706" strokeWidth="2" strokeLinecap="round"/>
    <path d="M80 102 Q90 116 105 119" stroke="#d97706" strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

const IllusSkin = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#fef9f0"/>
    <ellipse cx="100" cy="112" rx="54" ry="63" fill="#fde8d8"/>
    <circle cx="79" cy="89" r="6" fill="#f87171" opacity="0.68"/>
    <circle cx="116" cy="83" r="5" fill="#f87171" opacity="0.68"/>
    <circle cx="91" cy="120" r="4" fill="#f87171" opacity="0.55"/>
    <circle cx="119" cy="117" r="7" fill="#f87171" opacity="0.68"/>
    <circle cx="81" cy="137" r="4" fill="#fca5a5" opacity="0.5"/>
  </svg>
);

const IllusUrinary = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#eff6ff"/>
    <path d="M80 68 Q60 80 62 106 Q64 132 80 142 L80 162 L120 162 L120 142 Q136 132 138 106 Q140 80 120 68 Z" fill="#93c5fd" opacity="0.7"/>
    <path d="M80 68 Q100 58 120 68" stroke="#3b82f6" strokeWidth="2.5" fill="none"/>
    <ellipse cx="100" cy="151" rx="20" ry="10" fill="#60a5fa" opacity="0.4"/>
  </svg>
);

const IllusEyes = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#eff6ff"/>
    <path d="M30 100 Q100 50 170 100 Q100 150 30 100Z" fill="#bfdbfe" stroke="#3b82f6" strokeWidth="2"/>
    <circle cx="100" cy="100" r="24" fill="#1d4ed8"/>
    <circle cx="100" cy="100" r="14" fill="#0f172a"/>
    <circle cx="108" cy="94" r="5" fill="#fff" opacity="0.8"/>
  </svg>
);

const IllusAnalysis = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#f0fdfa"/>
    <circle cx="100" cy="100" r="52" stroke="#99f6e4" strokeWidth="2.5" fill="none" strokeDasharray="8 4"/>
    <circle cx="100" cy="100" r="36" stroke="#2dd4bf" strokeWidth="2.5" fill="none" strokeDasharray="5 3"/>
    <circle cx="100" cy="100" r="20" fill="#0d9488"/>
    <path d="M92 100 L98 106 L110 93" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="100" cy="48" r="7" fill="#0d9488"/>
    <circle cx="100" cy="152" r="7" fill="#0d9488"/>
    <circle cx="48" cy="100" r="7" fill="#0d9488"/>
    <circle cx="152" cy="100" r="7" fill="#0d9488"/>
  </svg>
);

const IllusDoctor = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#f0fdfa"/>
    <ellipse cx="100" cy="158" rx="42" ry="28" fill="#0d9488"/>
    <circle cx="100" cy="72" r="28" fill="#fde8d8"/>
    <rect x="72" y="96" width="56" height="62" rx="20" fill="#0d9488"/>
    <circle cx="88" cy="68" r="4" fill="#5b3a29"/>
    <circle cx="112" cy="68" r="4" fill="#5b3a29"/>
    <path d="M90 83 Q100 91 110 83" stroke="#5b3a29" strokeWidth="2" fill="none" strokeLinecap="round"/>
    <rect x="91" y="116" width="18" height="4" rx="2" fill="#fff"/>
    <rect x="98" y="109" width="4" height="18" rx="2" fill="#fff"/>
    <path d="M72 106 Q56 116 59 136" stroke="#0d9488" strokeWidth="7" strokeLinecap="round"/>
    <path d="M128 106 Q144 116 141 136" stroke="#0d9488" strokeWidth="7" strokeLinecap="round"/>
    <ellipse cx="100" cy="44" rx="30" ry="20" fill="#1e293b"/>
  </svg>
);

const CATEGORY_ILLUS = {
  General:      IllusGeneral,
  Respiratory:  IllusRespiratory,
  Digestive:    IllusDigestive,
  Liver:        IllusLiver,
  Skin:         IllusSkin,
  Eyes:         IllusEyes,
  Urinary:      IllusUrinary,
  Rectal:       IllusDigestive,
  Neurological: IllusGeneral,
  Metabolic:    IllusGeneral,
  Infection:    IllusDoctor,
  History:      IllusDoctor,
};

// ─────────────────────────────────────────────
// QUESTION ILLUSTRATION
// ─────────────────────────────────────────────
function QuestionIllus({ question }) {
  const imgPath = question ? SYMPTOM_IMAGES[question.id] : null;
  const catPath = question ? getCategoryImage(question.category) : null;
  const src = imgPath || catPath;

  if (src) {
    return (
      <div className="q-illus">
        <img src={src} alt={question?.category || "symptom"} />
      </div>
    );
  }

  const Comp = question ? (CATEGORY_ILLUS[question.category] || IllusDoctor) : IllusDoctor;
  return (
    <div className="q-illus">
      <Comp />
    </div>
  );
}

// ─────────────────────────────────────────────
// ICONS — proper Lucide-style SVG icons, no emojis
// ─────────────────────────────────────────────
function Icon({ name, size = 18, color = "currentColor", className = "" }) {
  const s = { width: size, height: size, flexShrink: 0 };
  const props = { viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", style: s, className };

  switch (name) {
    // Home — solid house with chimney feel
    case "home": return (
      <svg {...props}>
        <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" />
        <path d="M9 21V12h6v9" />
      </svg>
    );
    // Stethoscope for Check/Assessment
    case "activity": return (
      <svg {...props}>
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    );
    // Stethoscope icon
    case "stethoscope": return (
      <svg {...props}>
        <path d="M4.8 2.3A.3.3 0 105 2H4a2 2 0 00-2 2v5a6 6 0 006 6 6 6 0 006-6V4a2 2 0 00-2-2h-1a.2.2 0 10.3.3" />
        <path d="M8 15v1a6 6 0 006 6v0a6 6 0 006-6v-4" />
        <circle cx="20" cy="10" r="2" />
      </svg>
    );
    // Clipboard with lines — Records
    case "clipboard": return (
      <svg {...props}>
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
        <path d="M12 11h4M12 16h4M8 11h.01M8 16h.01" />
      </svg>
    );
    // User with circle head
    case "user": return (
      <svg {...props}>
        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    );
    // Settings gear with spokes
    case "settings": return (
      <svg {...props}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    );
    // Heart
    case "heart": return (
      <svg {...props}>
        <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
      </svg>
    );
    // Alert triangle
    case "alert": return (
      <svg {...props}>
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
    // Info circle
    case "info": return (
      <svg {...props}>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    );
    // Check mark
    case "check": return (
      <svg {...props}>
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
    // X / close
    case "x": return (
      <svg {...props}>
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    );
    // Log out
    case "logout": return (
      <svg {...props}>
        <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
    );
    // Chevron right
    case "chevR": return (
      <svg {...props}>
        <polyline points="9 18 15 12 9 6" />
      </svg>
    );
    // Chevron left
    case "chevL": return (
      <svg {...props}>
        <polyline points="15 18 9 12 15 6" />
      </svg>
    );
    // Edit / pencil
    case "edit": return (
      <svg {...props}>
        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    );
    // Trash
    case "trash": return (
      <svg {...props}>
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
        <path d="M9 6V4h6v2" />
      </svg>
    );
    // Search
    case "search": return (
      <svg {...props}>
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    );
    // Shield
    case "shield": return (
      <svg {...props}>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    );
    // Database
    case "database": return (
      <svg {...props}>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      </svg>
    );
    // Bell
    case "bell": return (
      <svg {...props}>
        <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 01-3.46 0" />
      </svg>
    );
    // Eye
    case "eye": return (
      <svg {...props}>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
    // Eye off
    case "eyeOff": return (
      <svg {...props}>
        <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
        <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
    );
    // Calendar
    case "calendar": return (
      <svg {...props}>
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    );
    // Pulse / waveform for Check tab
    case "pulse": return (
      <svg {...props}>
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    );
    // File text for Records
    case "file-text": return (
      <svg {...props}>
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    );
    // Sliders for settings
    case "sliders": return (
      <svg {...props}>
        <line x1="4" y1="21" x2="4" y2="14" />
        <line x1="4" y1="10" x2="4" y2="3" />
        <line x1="12" y1="21" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12" y2="3" />
        <line x1="20" y1="21" x2="20" y2="16" />
        <line x1="20" y1="12" x2="20" y2="3" />
        <line x1="1" y1="14" x2="7" y2="14" />
        <line x1="9" y1="8" x2="15" y2="8" />
        <line x1="17" y1="16" x2="23" y2="16" />
      </svg>
    );
    // plus
    case "plus": return (
      <svg {...props}>
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    );
    default: return (
      <svg {...props}>
        <circle cx="12" cy="12" r="4" />
      </svg>
    );
  }
}

// ─────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────
let _notifTimer;
function Notif({ msg }) {
  if (!msg) return null;
  return <div className="notif">{msg}</div>;
}

// ─────────────────────────────────────────────
// RECOMMENDATION BUBBLE
// ─────────────────────────────────────────────
function RecBubble({ icon, label, text, accent, bg }) {
  if (!text) return null;
  return (
    <div className="rec-bubble" style={{ borderLeftColor: accent, background: bg || "#fff" }}>
      <div className="rec-bubble-icon" style={{ background: `${accent}18` }}>
        <Icon name={icon} size={16} color={accent} />
      </div>
      <div>
        <div className="rec-bubble-label" style={{ color: accent }}>{label}</div>
        <div className="rec-bubble-text">{text}</div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────
export default function App() {
  useEffect(() => { injectStyles(); }, []);

  const [splash,     setSplash]     = useState(true);
  const [splashFade, setSplashFade] = useState(false);
  const [user,       setUser]       = useState(null);
  const [page,       setPage]       = useState("home");
  const [notif,      setNotif]      = useState("");
  const [detailRec,  setDetailRec]  = useState(null);

  // Assessment state
  const [assActive,  setAssActive]  = useState(false);
  const [answers,    setAnswers]    = useState({});
  const [asked,      setAsked]      = useState([]);
  const [currentQ,   setCurrentQ]   = useState(null);
  const [qIdx,       setQIdx]       = useState(0);
  const [sessionId,  setSessionId]  = useState(null);
  const [analyzing,  setAnalyzing]  = useState(false);
  const [result,     setResult]     = useState(null);

  const MAX_Q = 15;

  const toast = useCallback((msg) => {
    setNotif(msg);
    clearTimeout(_notifTimer);
    _notifTimer = setTimeout(() => setNotif(""), 2600);
  }, []);

  // Restore session on mount
  useEffect(() => {
    const t1 = setTimeout(() => setSplashFade(true), 1900);
    const t2 = setTimeout(() => {
      setSplash(false);
      const saved = Store.get("tc_user");
      if (saved) {
        api.setToken(saved.token || null);
        setUser(saved);
      }
    }, 2300);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const login = (u) => {
    Store.set("tc_user", u);
    api.setToken(u.token || null);
    setUser(u);
    setPage("home");
  };

  const logout = () => {
    Store.remove("tc_user");
    api.setToken(null);
    setUser(null);
    resetAssessment();
    setPage("home");
    toast("Signed out successfully.");
  };

  // ── Assessment ──
  const startAssessment = async () => {
    setAnswers({}); setAsked([]); setQIdx(0);
    setResult(null); setAnalyzing(false); setSessionId(null);

    let firstQ = ALL_QUESTIONS[0];
    let sid    = null;

    try {
      const data = await api.post("/symptoms/start", {});
      sid    = data.session_id;
      firstQ = data.first_question || ALL_QUESTIONS[0];
      setSessionId(sid);
    } catch {
      // offline fallback
    }

    setCurrentQ(firstQ);
    setAssActive(true);
    setPage("assessment");
  };

  const handleAnswer = async (val) => {
    const newAnswers = { ...answers, [currentQ.id]: val };
    const newAsked   = [...asked, currentQ.id];
    setAnswers(newAnswers);
    setAsked(newAsked);

    if (newAsked.length >= MAX_Q) { finishAssessment(newAnswers); return; }

    let next = null;
    if (sessionId) {
      try {
        const res = await api.post(`/symptoms/next?session_id=${sessionId}`, {
          question_id: currentQ.id,
          answer:      val,
        });
        if (res.completed) { finishAssessment(newAnswers); return; }
        next = res.next_question;
      } catch {
        next = getNextQuestionOffline(newAnswers, newAsked);
      }
    } else {
      next = getNextQuestionOffline(newAnswers, newAsked);
    }

    if (!next) { finishAssessment(newAnswers); return; }
    setCurrentQ(next);
    setQIdx(qIdx + 1);
  };

  const finishAssessment = async (finalAnswers) => {
    setAssActive(false);
    setAnalyzing(true);

    await new Promise((r) => setTimeout(r, 2400));

    let pred = null;
    if (sessionId) {
      try {
        pred = await api.post(`/diagnosis/analyze?session_id=${sessionId}`, {});
      } catch {}
    }
    if (!pred) pred = predictOffline(finalAnswers);

    setResult(pred);
    setAnalyzing(false);
    setPage("result");
  };

  const resetAssessment = () => {
    setAssActive(false); setResult(null); setAnalyzing(false);
    setAnswers({}); setAsked([]); setCurrentQ(null); setQIdx(0); setSessionId(null);
    setPage("home");
  };

  // ── Render ──
  if (splash) {
    return (
      <div className={`splash${splashFade ? " fading" : ""}`}>
        <div className="splash-logo">
          <MedicalHeartSplash />
        </div>
        <div className="splash-title">TropiCare</div>
        <div className="splash-sub">AI-Powered Symptom Assessment</div>
        <div className="splash-dots">
          <div className="splash-dot" />
          <div className="splash-dot" />
          <div className="splash-dot" />
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen onLogin={login} toast={toast} />;
  }

  if (analyzing) return <AnalyzingScreen />;
  if (page === "result" && result) return (
    <ResultScreen result={result} onReset={resetAssessment} onNewCheck={startAssessment} />
  );
  if (assActive && currentQ) return (
    <QuestionScreen
      question={currentQ} qIdx={qIdx} total={MAX_Q}
      onAnswer={handleAnswer} onQuit={resetAssessment}
    />
  );

  const navItems = [
    { id: "home",       label: "Home",    icon: "home" },
    { id: "assessment", label: "Check",   icon: "activity" },
    { id: "records",    label: "Records", icon: "clipboard" },
    { id: "profile",    label: "Profile", icon: "user" },
  ];

  const allNavItems = [
    ...navItems,
    { id: "settings", label: "Settings", icon: "settings" },
  ];

  const renderPage = () => {
    switch (page) {
      case "home":       return <HomeScreen user={user} onStart={startAssessment} onNav={setPage} />;
      case "assessment": return <AssessmentLanding onStart={startAssessment} />;
      case "records":    return <RecordsScreen toast={toast} onDetail={setDetailRec} detail={detailRec} onClearDetail={() => setDetailRec(null)} />;
      case "profile":    return <ProfileScreen user={user} onLogout={logout} onNav={setPage} toast={toast} />;
      case "settings":   return <SettingsScreen onBack={() => setPage("profile")} toast={toast} />;
      case "admin":      return <AdminScreen onBack={() => setPage("profile")} toast={toast} />;
      default:           return <HomeScreen user={user} onStart={startAssessment} onNav={setPage} />;
    }
  };

  return (
    <div className="shell">
      <Notif msg={notif} />

      {/* Sidebar — desktop */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">
            <MedicalHeartMark size={20} color="#fff" />
          </div>
          <div>
            <div className="brand-name">TropiCare</div>
            <div className="brand-sub">Symptom Checker</div>
          </div>
        </div>
        <nav className="sidebar-nav">
          {allNavItems.map((n) => (
            <button
              key={n.id}
              className={`nav-item${page === n.id ? " active" : ""}`}
              onClick={() => setPage(n.id)}
            >
              <Icon name={n.icon} size={17} className="nav-icon" />
              {n.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot" style={{ marginTop: "auto" }}>
          <button
            className="nav-item"
            style={{ color: "#ef4444", width: "100%" }}
            onClick={logout}
          >
            <Icon name="logout" size={16} color="#ef4444" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="main">
        <div className="page">{renderPage()}</div>
      </main>

      {/* Bottom nav — mobile */}
      <nav className="bottom-nav">
        {navItems.map((n) => (
          <button
            key={n.id}
            className={`bnav-item${page === n.id ? " active" : ""}`}
            onClick={() => {
              setPage(n.id);
              if (n.id !== "assessment") setAssActive(false);
            }}
          >
            <Icon name={n.icon} size={20} />
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ─────────────────────────────────────────────
// AUTH SCREEN
// ─────────────────────────────────────────────
function AuthScreen({ onLogin, toast }) {
  const [mode,    setMode]    = useState("login");
  const [name,    setName]    = useState("");
  const [email,   setEmail]   = useState("");
  const [pw,      setPw]      = useState("");
  const [age,     setAge]     = useState("");
  const [gender,  setGender]  = useState("");
  const [showPw,  setShowPw]  = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email.trim() || !pw.trim()) { toast("Please fill in all required fields."); return; }
    if (mode === "register" && !name.trim()) { toast("Please enter your full name."); return; }
    setLoading(true);
    try {
      let data;
      if (mode === "register") {
        data = await api.post("/auth/register", { email: email.trim(), password: pw, name: name.trim(), age, gender });
      } else {
        data = await api.post("/auth/login", { email: email.trim(), password: pw });
      }
      onLogin({ ...data.user, token: data.access_token });
    } catch (e) {
      toast(e.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-box">
        <div className="auth-logo">
          <div className="auth-icon">
            <MedicalHeartLarge size={34} color="#fff" />
          </div>
          <div className="auth-title">TropiCare</div>
          <div className="auth-hint">AI-guided symptom assessment for tropical diseases</div>
        </div>

        <div className="card card-p" style={{ boxShadow: "0 8px 40px rgba(0,0,0,0.1)" }}>
          <div className="tabs mb-3">
            {["login", "register"].map((m) => (
              <button key={m} className={`tab${mode === m ? " active" : ""}`} onClick={() => setMode(m)}>
                {m === "login" ? "Sign In" : "Create Account"}
              </button>
            ))}
          </div>

          {mode === "register" && (
            <div className="field">
              <label className="field-label">Full Name</label>
              <input
                className="field-input"
                placeholder="e.g. Kofi Mensah"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label className="field-label">Email Address</label>
            <input
              className="field-input"
              type="email"
              placeholder="you@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          {mode === "register" && (
            <div className="grid-2">
              <div className="field">
                <label className="field-label">Age</label>
                <input
                  className="field-input"
                  type="number"
                  placeholder="25"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">Gender</label>
                <select
                  className="field-input field-select"
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                >
                  <option value="">Select</option>
                  <option>Male</option>
                  <option>Female</option>
                  <option>Other</option>
                </select>
              </div>
            </div>
          )}

          <div className="field">
            <label className="field-label">Password</label>
            <div className="pw-wrap">
              <input
                className="field-input"
                type={showPw ? "text" : "password"}
                placeholder="Enter password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                style={{ paddingRight: 46 }}
              />
              <button className="pw-toggle" onClick={() => setShowPw(!showPw)} type="button">
                <Icon name={showPw ? "eyeOff" : "eye"} size={17} />
              </button>
            </div>
          </div>

          <button
            className="btn btn-primary btn-full btn-lg mt-2"
            onClick={submit}
            disabled={loading}
          >
            {loading ? "Please wait..." : mode === "login" ? "Sign In" : "Create Account"}
          </button>
        </div>

        <div className="auth-foot">
          TropiCare · Symptom Checker for Tropical Diseases<br />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// HOME SCREEN
// ─────────────────────────────────────────────
function HomeScreen({ user, onStart, onNav }) {
  const [records, setRecords] = useState([]);

  useEffect(() => {
    api.get("/patient/history")
      .then((d) => setRecords(d.slice(0, 3)))
      .catch(() => {});
  }, []);

  const stats = [
    { label: "Assessments", val: records.length,                                        icon: "activity", color: "#0d9488" },
    { label: "High Risk",   val: records.filter((r) => r.risk === "High").length,       icon: "alert",    color: "#ef4444" },
    { label: "Last Check",  val: records[0] ? fmtDate(records[0].created_at) : "None", icon: "calendar", color: "#3b82f6" },
  ];

  return (
    <div>
      <div className="home-header">
        <div>
          <div className="greeting">Good day,</div>
          <div style={{ fontFamily: "var(--display)", fontSize: 22, fontWeight: 700 }}>
            {(user?.name || "Patient").split(" ")[0]}
          </div>
        </div>
        <div className="avatar">{(user?.name || "P")[0].toUpperCase()}</div>
      </div>

      {/* Hero */}
      <div className="hero-card">
        <div className="hero-bg-icon">
          <Icon name="heart" size={110} color="#fff" />
        </div>
        <div className="hero-eyebrow">AI-Powered Assessment</div>
        <div className="hero-headline">Check your symptoms in under 2 minutes</div>
        <button className="hero-btn" onClick={onStart}>
          Start Assessment
          <Icon name="chevR" size={14} color="var(--teal-d)" />
        </button>
      </div>

      {/* Stats */}
      <div className="stats-row">
        {stats.map((s) => (
          <div key={s.label} className="stat-card">
            <div className="stat-icon" style={{ background: `${s.color}18` }}>
              <Icon name={s.icon} size={16} color={s.color} />
            </div>
            <div className="stat-val t-mono">{s.val}</div>
            <div className="stat-lbl">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Recent assessments */}
      {records.length > 0 && (
        <div className="section">
          <div className="section-ttl">Recent Assessments</div>
          <div className="rec-list">
            {records.map((r) => (
              <div key={r.id} className="rec-card">
                <div className="rec-icon-wrap" style={{ background: `${RISK_COLOR[r.risk]}18` }}>
                  <Icon name="heart" size={18} color={RISK_COLOR[r.risk]} />
                </div>
                <div className="rec-info">
                  <div className="rec-name">{r.disease}</div>
                  <div className="rec-meta">{fmtDate(r.created_at)}</div>
                </div>
                <span className={`badge badge-${r.risk}`}>{r.risk}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Disease coverage */}
      <div className="section">
        <div className="section-ttl">Disease Coverage</div>
        <div className="card card-p">
          <div className="disease-grid">
            {Object.entries(RISK_MAP).map(([d, r]) => (
              <span key={d} className={`badge badge-${r}`}>{d}</span>
            ))}
          </div>
          <div className="t-subtitle mt-3" style={{ fontSize: 12 }}>22 diseases · 3 risk levels</div>
        </div>
      </div>

      <div style={{ height: 24 }} />
    </div>
  );
}

// ─────────────────────────────────────────────
// ASSESSMENT LANDING — animated, beautiful
// ─────────────────────────────────────────────
function AssessmentLanding({ onStart }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { const t = setTimeout(() => setVisible(true), 60); return () => clearTimeout(t); }, []);

  const features = [
    { icon: "activity", title: "Adaptive Questions",    desc: "Up to 15 questions tailored to your answers — no irrelevant ones.", color: "#0d9488", bg: "#f0fdfa" },
    { icon: "shield",   title: "22 Diseases Covered",   desc: "Covers tropical and common diseases prevalent across West Africa.", color: "#3b82f6", bg: "#eff6ff" },
    { icon: "info",     title: "Clear Recommendations", desc: "Home care, tests to consider, and when to see a doctor.", color: "#8b5cf6", bg: "#f5f3ff" },
  ];

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Animated hero */}
      <div className="check-hero">
        <div className="check-hero-bg" />
        <div className={`check-hero-content${visible ? " visible" : ""}`}>
          <div className="check-doctor-wrap">
            <div className="check-pulse-ring check-pulse-1" />
            <div className="check-pulse-ring check-pulse-2" />
            <div className="check-pulse-ring check-pulse-3" />
            <div className="check-doctor-circle">
              <IllusDoctor />
            </div>
          </div>
          <div className="check-hero-text">
            <div className="t-display" style={{ color: "#000", fontSize: 28 }}>Symptom Assessment</div>
            <div style={{ color: "rgba(0,0,0,0.72)", fontSize: 14, marginTop: 6, lineHeight: 1.5 }}>
              Answer a short set of questions to receive a result
            </div>
          </div>
        </div>
        {/* ECG line decoration */}
        <div className="check-ecg-wrap">
          <svg viewBox="0 0 400 50" className="check-ecg-svg" fill="none">
            <polyline
              points="0,30 60,30 80,30 90,10 100,45 110,18 120,35 140,30 200,30 210,30 220,8 230,42 240,20 250,35 260,30 320,30 340,30 350,12 360,44 370,20 380,33 400,30"
              stroke="#2E8B57"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>

      {/* Features */}
      <div className="page-body" style={{ flex: 1 }}>
        <div className="card card-p mb-4">
          <div className="feat-list">
            {features.map((f, i) => (
              <div
                key={f.title}
                className={`feat-row check-feat${visible ? " feat-visible" : ""}`}
                style={{ animationDelay: `${0.15 + i * 0.1}s` }}
              >
                <div className="feat-icon" style={{ background: f.bg }}>
                  <Icon name={f.icon} size={16} color={f.color} />
                </div>
                <div>
                  <div className="feat-title">{f.title}</div>
                  <div className="feat-desc">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="t-subtitle mt-3 italic" style={{ fontSize: 12 }}>
            This tool provides informational guidance only and does not replace a clinical diagnosis.
          </div>
        </div>

        <button className="btn btn-primary btn-full btn-lg check-start-btn" onClick={onStart}>
          <Icon name="activity" size={18} color="#fff" />
          Begin Assessment
          <Icon name="chevR" size={16} color="rgba(255,255,255,0.7)" />
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// QUESTION SCREEN
// ─────────────────────────────────────────────
function QuestionScreen({ question, qIdx, total, onAnswer, onQuit }) {
  const [animKey, setAnimKey] = useState(0);
  const progress = (qIdx / total) * 100;

  const answer = (val) => {
    setAnimKey((k) => k + 1);
    onAnswer(val);
  };

  return (
    <div className="q-screen">
      <div className="q-topbar">
        <button className="q-close" onClick={onQuit}>
          <Icon name="x" size={16} color="var(--muted)" />
        </button>
        <div style={{ flex: 1 }}>
          <div className="prog-track">
            <div className="prog-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="q-counter">{qIdx + 1}/{total}</div>
      </div>

      <div key={animKey} className="q-body q-anim">
        <div className="q-cat-pill">{question.category}</div>
        <QuestionIllus question={question} />
        <div className="q-text">{question.question}</div>
        <div className="q-answers">
          <button className="ans-btn yes" onClick={() => answer(true)}>
            <div className="ans-btn-icon ans-yes-icon">
              <Icon name="check" size={14} color="var(--teal-d)" />
            </div>
            Yes
          </button>
          <button className="ans-btn no" onClick={() => answer(false)}>
            <div className="ans-btn-icon ans-no-icon">
              <Icon name="x" size={14} color="var(--muted)" />
            </div>
            No
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ANALYZING SCREEN
// ─────────────────────────────────────────────
function AnalyzingScreen() {
  const [step, setStep] = useState(0);
  const steps = [
    "Processing your responses...",
    "Running diagnostic models...",
    "Calculating risk level...",
    "Preparing your recommendations...",
  ];

  useEffect(() => {
    const t = setInterval(() => setStep((s) => Math.min(s + 1, steps.length - 1)), 680);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="analyzing">
      <div className="spin-ring"><IllusAnalysis /></div>
      <div style={{ fontFamily: "var(--display)", fontSize: 24, fontWeight: 700, textAlign: "center" }}>
        Analysing Results
      </div>
      <div className="t-subtitle mt-2 text-c" style={{ minHeight: 22 }}>{steps[step]}</div>
      <div className="loading-dots">
        <div className="ldot" />
        <div className="ldot" />
        <div className="ldot" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// RESULT SCREEN
// ─────────────────────────────────────────────
function ResultScreen({ result, onReset, onNewCheck }) {
  const risk  = result.risk || "Medium";
  const color = RISK_COLOR[risk];
  const bg    = RISK_BG[risk];
  const rec   = result.recommendation || {};
  const scores = result.all_scores
    ? Object.entries(result.all_scores).filter(([d]) => d !== result.disease).slice(0, 4)
    : [];

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      {/* Header */}
      <div style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)", padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 700 }}>Your Result</div>
        <button
          onClick={onReset}
          style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: "8px", cursor: "pointer", display: "flex" }}
        >
          <Icon name="x" size={16} color="var(--muted)" />
        </button>
      </div>

      <div style={{ maxWidth: 600, margin: "0 auto", padding: "24px 16px 64px" }}>
        {/* Risk ring */}
        <div className="text-c mb-4">
          <div className={`result-ring result-ring-${risk}`}>
            <Icon
              name={risk === "High" ? "alert" : risk === "Medium" ? "info" : "check"}
              size={44}
              color={color}
            />
          </div>
          <span className={`badge badge-${risk}`} style={{ fontSize: 12, padding: "4px 14px" }}>
            {risk} Risk
          </span>
        </div>

        {/* Disease + confidence */}
        <div className="card card-p mb-3 text-c">
          <div className="t-label mb-2">Predicted Condition</div>
          <div style={{ fontFamily: "var(--display)", fontSize: 26, fontWeight: 700, marginBottom: 12 }}>
            {result.disease}
          </div>
          <div style={{ height: 6, background: "var(--border-l)", borderRadius: 99, overflow: "hidden", marginBottom: 6 }}>
            <div
              style={{
                height: "100%",
                width: `${Math.round(result.confidence * 100)}%`,
                background: `linear-gradient(90deg, ${color}80, ${color})`,
                borderRadius: 99,
                transition: "width 0.8s cubic-bezier(0.4,0,0.2,1)",
              }}
            />
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color }}>
            {Math.round(result.confidence * 100)}% match
          </div>
          {result.explanation && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)", fontSize: 13, color: "var(--muted)", fontStyle: "italic", lineHeight: 1.6 }}>
              {result.explanation}
            </div>
          )}
        </div>

        {/* Recommendations */}
        <div className="section-ttl mb-2">What to Do</div>
        <div className="rec-bubbles mb-4">
          <RecBubble
            icon="heart"     label="Home Care"         text={rec.home_care}
            accent="#16a34a" bg="#f0fdf4"
          />
          <RecBubble
            icon="clipboard" label="Recommended Test"  text={rec.test}
            accent="#2563eb" bg="#eff6ff"
          />
          <RecBubble
            icon="user"      label="Doctor Visit"      text={rec.doctor}
            accent={color}   bg={bg}
          />
          {rec.safety && (
            <RecBubble
              icon="alert"     label="Important"         text={rec.safety}
              accent="#dc2626" bg="#fef2f2"
            />
          )}
        </div>

        {/* Other possibilities */}
        {scores.length > 0 && (
          <div className="card card-p mb-4">
            <div className="section-ttl mb-3">Other Possibilities</div>
            {scores.map(([d, conf]) => (
              <div key={d} className="score-bar-row">
                <span className="score-bar-name">{d}</span>
                <div className="score-bar-track">
                  <div className="score-bar-fill" style={{ width: `${Math.round(conf * 100)}%` }} />
                </div>
                <span className="score-bar-pct">{Math.round(conf * 100)}%</span>
              </div>
            ))}
          </div>
        )}

        {/* Disclaimer */}
        <div className="disclaimer mb-4">
          <Icon name="alert" size={14} color="var(--amber)" />
          <p>This result is for informational purposes only. It does not replace a clinical diagnosis. Consult a qualified healthcare professional before making any medical decisions.</p>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button className="btn btn-primary btn-full btn-lg" onClick={onNewCheck}>
            Start New Assessment
          </button>
          <button className="btn btn-secondary btn-full" onClick={onReset}>
            Return to Home
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// RECORDS SCREEN
// ─────────────────────────────────────────────
function RecordsScreen({ toast, onDetail, detail, onClearDetail }) {
  const [records, setRecords] = useState([]);
  const [search,  setSearch]  = useState("");
  const [filter,  setFilter]  = useState("All");
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try { setRecords(await api.get("/patient/history")); }
    catch { setRecords([]); }
    finally { setLoading(false); }
  };

  if (detail) {
    return <RecordDetail record={detail} onBack={onClearDetail} />;
  }

  const filtered = records.filter((r) => {
    const ms = (r.disease || "").toLowerCase().includes(search.toLowerCase())
            || (r.patient_name || "").toLowerCase().includes(search.toLowerCase());
    const mf = filter === "All" || r.risk === filter;
    return ms && mf;
  });

  return (
    <div>
      <div className="page-head">
        <div className="t-display">Patient Records</div>
        <div className="t-subtitle mt-1">{records.length} total assessment{records.length !== 1 ? "s" : ""}</div>
      </div>
      <div className="page-body">
        <div className="search-wrap">
          <span className="search-icon"><Icon name="search" size={15} /></span>
          <input
            className="search-input"
            placeholder="Search records..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="chip-row">
          {["All", "High", "Medium", "Low"].map((f) => (
            <button key={f} className={`chip${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="empty-state"><div className="t-subtitle">Loading records...</div></div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div style={{ width: 80, height: 80 }}><IllusDoctor /></div>
            <div className="t-title">No records found</div>
            <div className="t-subtitle">Complete an assessment to see your results here.</div>
          </div>
        ) : (
          <div className="rec-list">
            {filtered.map((r) => (
              <div key={r.id} className="rec-card" onClick={() => onDetail(r)}>
                <div className="rec-icon-wrap" style={{ background: `${RISK_COLOR[r.risk]}18` }}>
                  <Icon name="heart" size={18} color={RISK_COLOR[r.risk]} />
                </div>
                <div className="rec-info">
                  <div className="rec-name">{r.disease}</div>
                  <div className="rec-meta">{r.patient_name} · {fmtDate(r.created_at)} · {Math.round((r.confidence || 0) * 100)}%</div>
                </div>
                <span className={`badge badge-${r.risk}`}>{r.risk}</span>
                <Icon name="chevR" size={14} color="var(--muted-l)" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RecordDetail({ record, onBack }) {
  const color = RISK_COLOR[record.risk] || "#0d9488";
  const bg    = RISK_BG[record.risk]   || "#f0fdfa";
  const rec   = record.recommendation  || {};
  const syms  = (record.active_symptoms || []).map((s) => s.replace(/_/g, " "));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <button
          onClick={onBack}
          style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}
        >
          <Icon name="chevL" size={16} color="var(--ink)" />
        </button>
        <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 700 }}>Assessment Detail</div>
      </div>

      <div style={{ maxWidth: 600, margin: "0 auto", padding: "20px 16px 64px" }}>
        <div className="card card-p text-c mb-3">
          <div className={`result-ring result-ring-${record.risk}`} style={{ width: 90, height: 90 }}>
            <Icon
              name={record.risk === "High" ? "alert" : record.risk === "Medium" ? "info" : "check"}
              size={36}
              color={color}
            />
          </div>
          <div style={{ fontFamily: "var(--display)", fontSize: 22, fontWeight: 700, margin: "12px 0 6px" }}>{record.disease}</div>
          <span className={`badge badge-${record.risk}`}>{record.risk} Risk</span>
          <div className="t-subtitle mt-2" style={{ fontSize: 12 }}>
            {record.patient_name} · {new Date(record.created_at).toLocaleString("en-GB")}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color, marginTop: 6 }}>
            {Math.round((record.confidence || 0) * 100)}% match
          </div>
          {record.explanation && (
            <div className="t-subtitle mt-3 italic" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              {record.explanation}
            </div>
          )}
        </div>

        <div className="section-ttl mb-2">Recommendations</div>
        <div className="rec-bubbles mb-4">
          <RecBubble icon="heart"     label="Home Care"        text={rec.home_care} accent="#16a34a" bg="#f0fdf4" />
          <RecBubble icon="clipboard" label="Recommended Test" text={rec.test}      accent="#2563eb" bg="#eff6ff" />
          <RecBubble icon="user"      label="Doctor Visit"     text={rec.doctor}    accent={color}   bg={bg}     />
          {rec.safety && <RecBubble icon="alert" label="Important" text={rec.safety} accent="#dc2626" bg="#fef2f2" />}
        </div>

        {syms.length > 0 && (
          <div className="card card-p mb-4">
            <div className="section-ttl mb-2">Reported Symptoms ({syms.length})</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {syms.map((s) => (
                <span
                  key={s}
                  style={{ padding: "5px 12px", background: "var(--teal-xl)", borderRadius: 99, fontSize: 12, fontWeight: 600, color: "var(--teal)" }}
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// PROFILE SCREEN
// ─────────────────────────────────────────────
function ProfileScreen({ user, onLogout, onNav, toast }) {
  const [editing, setEditing] = useState(false);
  const [name,    setName]    = useState(user?.name   || "");
  const [age,     setAge]     = useState(user?.age    || "");
  const [gender,  setGender]  = useState(user?.gender || "");
  const [profile, setProfile] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get("/user/profile").then(setProfile).catch(() => setProfile(user || {}));
  }, []);

  const saveProfile = async () => {
    setLoading(true);
    try {
      const data = await api.put("/user/profile", { name, age, gender });
      setProfile((p) => ({ ...p, ...data }));
      const updated = { ...user, name, age, gender };
      Store.set("tc_user", updated);
      toast("Profile updated.");
      setEditing(false);
    } catch {
      toast("Could not save. Check your connection.");
    } finally {
      setLoading(false);
    }
  };

  const p = { ...user, ...profile };

  return (
    <div>
      <div className="page-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="t-display">Profile</div>
        <button className="btn btn-secondary btn-sm" onClick={() => setEditing(!editing)}>
          <Icon name="edit" size={13} />
          {editing ? "Cancel" : "Edit"}
        </button>
      </div>

      <div className="page-body">
        <div className="card card-p text-c mb-3">
          <div className="avatar avatar-lg mx-auto mb-3">
            {(p.name || "P")[0].toUpperCase()}
          </div>
          {editing ? (
            <div style={{ textAlign: "left" }}>
              <div className="field">
                <label className="field-label">Full Name</label>
                <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="grid-2">
                <div className="field">
                  <label className="field-label">Age</label>
                  <input className="field-input" type="number" value={age} onChange={(e) => setAge(e.target.value)} />
                </div>
                <div className="field">
                  <label className="field-label">Gender</label>
                  <select className="field-input field-select" value={gender} onChange={(e) => setGender(e.target.value)}>
                    <option value="">Select</option>
                    <option>Male</option>
                    <option>Female</option>
                    <option>Other</option>
                  </select>
                </div>
              </div>
              <button className="btn btn-primary btn-full" onClick={saveProfile} disabled={loading}>
                {loading ? "Saving..." : "Save Changes"}
              </button>
            </div>
          ) : (
            <>
              <div className="t-title">{p.name}</div>
              <div className="t-subtitle mt-1">{p.email}</div>
              {p.age && <div className="t-subtitle">{p.age} years · {p.gender}</div>}
              <div className="mt-2">
                <span className="badge badge-teal">
                  Member since {new Date(p.joined_at || Date.now()).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          <div className="stat-card">
            <div className="stat-val" style={{ color: "var(--teal)" }}>{p.assessment_count || 0}</div>
            <div className="stat-lbl">Assessments</div>
          </div>
          <div className="stat-card">
            <div className="stat-val" style={{ color: "#ef4444" }}>{p.high_risk_count || 0}</div>
            <div className="stat-lbl">High Risk</div>
          </div>
        </div>

        {/* Menu */}
        <div className="card card-p mb-3">
          <div className="menu-list">
            {[
              { label: "Settings",             icon: "settings", action: () => onNav("settings") },
              { label: "Database Management",  icon: "database", action: () => onNav("admin") },
              { label: "Privacy and Security", icon: "shield",   action: () => {} },
              { label: "About TropiCare",      icon: "info",     action: () => {} },
            ].map((item) => (
              <div key={item.label} className="menu-item" onClick={item.action}>
                <div className="menu-ico"><Icon name={item.icon} size={16} color="var(--muted)" /></div>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{item.label}</span>
                <Icon name="chevR" size={14} color="var(--muted-l)" />
              </div>
            ))}
          </div>
        </div>

        <button className="btn btn-danger btn-full" onClick={onLogout}>
          <Icon name="logout" size={15} color="#fff" />
          Sign Out
        </button>

        <div className="text-c mt-4" style={{ fontSize: 11, color: "var(--muted-l)", lineHeight: 1.7 }}>
          TropiCare v1.0 · Symptom Checker for Tropical Diseases
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// SETTINGS SCREEN
// ─────────────────────────────────────────────
function SettingsScreen({ onBack, toast }) {
  const [theme,    setTheme]    = useState("light");
  const [notifs,   setNotifs]   = useState(true);
  const [lang,     setLang]     = useState("en");
  const [fontSize, setFontSize] = useState("medium");

  useEffect(() => {
    const s = Store.get("tc_settings");
    if (s) {
      setTheme(s.theme || "light");
      setNotifs(s.notifications !== false);
      setLang(s.language || "en");
      setFontSize(s.fontSize || "medium");
    }
  }, []);

  const save = () => {
    Store.set("tc_settings", { theme, notifications: notifs, language: lang, fontSize });
    toast("Settings saved.");
  };

  const ChipGroup = ({ options, value, onChange }) => (
    <div className="chip-row">
      {options.map((o) => (
        <button key={o.val} className={`chip${value === o.val ? " on" : ""}`} onClick={() => onChange(o.val)}>
          {o.label}
        </button>
      ))}
    </div>
  );

  const Toggle = ({ checked, onChange }) => (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-slider" />
    </label>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 20px 0" }}>
        <button
          onClick={onBack}
          style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}
        >
          <Icon name="chevL" size={16} color="var(--ink)" />
        </button>
        <div className="t-display">Settings</div>
      </div>
      <div className="page-body">
        {[
          {
            title: "Appearance",
            content: (
              <>
                <div className="t-label mb-2">Theme</div>
                <ChipGroup
                  options={[{val:"light",label:"Light"},{val:"dark",label:"Dark"},{val:"system",label:"System"}]}
                  value={theme} onChange={setTheme}
                />
                <div className="t-label mt-3 mb-2">Text Size</div>
                <ChipGroup
                  options={[{val:"small",label:"Small"},{val:"medium",label:"Medium"},{val:"large",label:"Large"}]}
                  value={fontSize} onChange={setFontSize}
                />
              </>
            ),
          },
          {
            title: "Notifications",
            content: (
              <div className="toggle-row">
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Push Notifications</div>
                  <div className="t-subtitle" style={{ fontSize: 12 }}>Health reminders and updates</div>
                </div>
                <Toggle checked={notifs} onChange={setNotifs} />
              </div>
            ),
          },
          {
            title: "Language",
            content: (
              <ChipGroup
                options={[
                  {val:"en",label:"English"},
                  {val:"tw",label:"Twi"},
                  {val:"fr",label:"French"},
                  {val:"ha",label:"Hausa"},
                ]}
                value={lang} onChange={setLang}
              />
            ),
          },
          {
            title: "Privacy",
            content: (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 10, borderBottom: "1px solid var(--border)" }}>
                  <Icon name="shield" size={16} color="#22c55e" />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Local Storage Only</div>
                    <div className="t-subtitle" style={{ fontSize: 12 }}>All data stays on this device</div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 10 }}>
                  <Icon name="check" size={16} color="#22c55e" />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>No Third-Party Sharing</div>
                    <div className="t-subtitle" style={{ fontSize: 12 }}>Your health data is never shared</div>
                  </div>
                </div>
              </>
            ),
          },
        ].map((s) => (
          <div key={s.title} style={{ marginBottom: 16 }}>
            <div className="section-ttl mb-2">{s.title}</div>
            <div className="card card-p">{s.content}</div>
          </div>
        ))}

        <button className="btn btn-primary btn-full" onClick={save}>Save Settings</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ADMIN SCREEN
// ─────────────────────────────────────────────
function AdminScreen({ onBack, toast }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [search,  setSearch]  = useState("");

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try { setRecords(await api.get("/admin/all-records")); }
    catch { setRecords([]); }
    finally { setLoading(false); }
  };

  const clearAll = async () => {
    if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 5000); return; }
    try {
      await api.delete("/admin/clear-database");
      setRecords([]); setConfirm(false); toast("All records cleared.");
    } catch { toast("Failed to clear records."); }
  };

  const del = async (id) => {
    try { await api.delete(`/admin/record/${id}`); } catch {}
    setRecords((r) => r.filter((x) => x.id !== id));
    toast("Record deleted.");
  };

  const counts = { High: 0, Medium: 0, Low: 0 };
  records.forEach((r) => { if (counts[r.risk] !== undefined) counts[r.risk]++; });

  const shown = records.filter((r) =>
    (r.disease || "").toLowerCase().includes(search.toLowerCase()) ||
    (r.patient_name || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 20px 0" }}>
        <button
          onClick={onBack}
          style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}
        >
          <Icon name="chevL" size={16} color="var(--ink)" />
        </button>
        <div className="t-display">Database</div>
      </div>
      <div className="page-body">
        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 16 }}>
          {[["High", "#ef4444"], ["Medium", "#f59e0b"], ["Low", "#22c55e"]].map(([r, c]) => (
            <div key={r} className="stat-card">
              <div className="stat-val" style={{ color: c }}>{counts[r]}</div>
              <div className="stat-lbl">{r}</div>
            </div>
          ))}
        </div>

        {/* Danger zone */}
        <div className="danger-zone mb-4">
          <div style={{ fontWeight: 700, color: "#ef4444", marginBottom: 4 }}>Clear All Records</div>
          <div className="t-subtitle mb-3">Permanently deletes all assessment data. This cannot be undone.</div>
          {confirm && (
            <div className="disclaimer mb-3">
              <Icon name="alert" size={14} color="var(--amber)" />
              <p>Click again to confirm deletion of {records.length} record{records.length !== 1 ? "s" : ""}.</p>
            </div>
          )}
          <button className="btn btn-danger btn-full" onClick={clearAll} disabled={records.length === 0}>
            <Icon name="trash" size={14} color="#fff" />
            {confirm ? "Confirm Delete All" : "Clear All Records"}
          </button>
          {confirm && (
            <button className="btn btn-secondary btn-full mt-2" onClick={() => setConfirm(false)}>Cancel</button>
          )}
        </div>

        {/* Records list */}
        <div className="section-ttl mb-2">All Records ({records.length})</div>
        <div className="search-wrap mb-3">
          <span className="search-icon"><Icon name="search" size={15} /></span>
          <input
            className="search-input"
            placeholder="Search records..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="empty-state"><div className="t-subtitle">Loading...</div></div>
        ) : shown.length === 0 ? (
          <div className="empty-state">
            <Icon name="database" size={36} color="var(--muted-l)" />
            <div className="t-subtitle">No records found</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {shown.map((r) => (
              <div key={r.id} className="card" style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{r.disease}</div>
                  <div className="t-subtitle" style={{ fontSize: 11 }}>{r.patient_name} · {fmtDate(r.created_at)}</div>
                </div>
                <span className={`badge badge-${r.risk}`}>{r.risk}</span>
                <button
                  onClick={() => del(r.id)}
                  style={{ border: "none", background: "#fef2f2", borderRadius: 8, padding: "7px", cursor: "pointer", display: "flex" }}
                >
                  <Icon name="trash" size={13} color="#ef4444" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
