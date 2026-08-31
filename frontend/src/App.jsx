/*
 * TropiCare — App.jsx
 * Backend: FastAPI (tropicare.onrender.com)
 */

import { useState, useEffect, useCallback } from "react";
import { SYMPTOM_IMAGES, getCategoryImage } from "./symptomImages.js";
import { generateTropiCareReport } from "./pdfReport.js";
import ClinicFinder from "./ClinicFinder.jsx";

// ─────────────────────────────────────────────
// BACKEND CONFIG
// ─────────────────────────────────────────────
const API_BASE = "https://tropicare.onrender.com/api/v1";

// ─────────────────────────────────────────────
// SOCIAL SIGN-IN CONFIG
// -----------------------------------------------------------------
// These three IDs are PUBLIC client identifiers
// -----------------------------------------------------------------
const GOOGLE_CLIENT_ID   = "459505831088-27tcpt1j6s57k3mn4hdsjli8lf774gaf.apps.googleusercontent.com";
const FACEBOOK_APP_ID    = "FACEBOOK_APP_ID";
const APPLE_CLIENT_ID    = "APPLE_SERVICES_ID";
const APPLE_REDIRECT_URI = "https://tropi-care.vercel.app";

// A provider is only considered "live" once its placeholder has been
// replaced with a real ID. Apple additionally requires a paid Apple
// Developer account, so it is deliberately shown as "coming soon" in the
// UI until APPLE_CLIENT_ID is set — see the Apple button below.
const GOOGLE_ENABLED   = !GOOGLE_CLIENT_ID.startsWith("YOUR_");
const FACEBOOK_ENABLED = !FACEBOOK_APP_ID.startsWith("YOUR_");
const APPLE_ENABLED    = !APPLE_CLIENT_ID.startsWith("YOUR_");

const _loadedScripts = {};
function loadScript(src) {
  if (_loadedScripts[src]) return _loadedScripts[src];
  _loadedScripts[src] = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
      if (existing.dataset.loaded === "true") resolve();
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.defer = true;
    el.onload = () => { el.dataset.loaded = "true"; resolve(); };
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
  return _loadedScripts[src];
}

// Preloading these SDKs the moment the auth screen mounts (rather than on
// click) matters for popup reliability: Google's and Facebook's sign-in
// popups must open as a direct result of a user gesture, and a network
// fetch for the SDK script sitting between the click and the popup call
// can be enough for some browsers to block it as a "background" popup.
function preloadSocialSdks() {
  if (GOOGLE_ENABLED) {
    loadScript("https://accounts.google.com/gsi/client").catch(() => {});
  }
  if (FACEBOOK_ENABLED) {
    loadScript("https://connect.facebook.net/en_US/sdk.js").then(() => {
      if (window.FB && !window.FB._tcInitialized) {
        window.FB.init({ appId: FACEBOOK_APP_ID, cookie: true, xfbml: false, version: "v23.0" });
        window.FB._tcInitialized = true;
      }
    }).catch(() => {});
  }
}

// ─────────────────────────────────────────────
// API CLIENT
// ─────────────────────────────────────────────
const TOKEN_KEY = "tc_token";
const USER_KEY  = "tc_user";

/*
 * Module-level logout flag. Any in-flight .then() callbacks check this before
 * calling setState so we never update state on an unmounted / logged-out tree.
 */
let _loggingOut = false;

const api = {
  setToken: (t) => {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else   localStorage.removeItem(TOKEN_KEY);
  },
  getToken: () => localStorage.getItem(TOKEN_KEY) || null,

  headers: () => {
    const token = api.getToken();
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  },

  onUnauthorized: null,

  async call(method, path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: api.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      if (res.status === 401 && api.onUnauthorized) {
        api.onUnauthorized();
      }
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
// LOCAL STORE
// ─────────────────────────────────────────────
const Store = {
  get:    (k)    => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set:    (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  remove: (k)    => localStorage.removeItem(k),
};

// ─────────────────────────────────────────────
// RISK HELPERS
// ─────────────────────────────────────────────
const RISK_COLOR = { High: "#e23d3d", Medium: "#e8930f", Low: "#1f9d55" };
const RISK_BG    = { High: "#fdecec", Medium: "#fef3e0", Low: "#e9f9ee" };

// ─────────────────────────────────────────────
// DISEASE / SYMPTOM DATA
// ─────────────────────────────────────────────
const DISEASE_SYMPTOM_MAP = {
  Malaria: ["high_fever","chills","sweating","headache","muscle_pain","vomiting","nausea","diarrhoea"],
  Typhoid: ["high_fever","chills","fatigue","vomiting","headache","nausea","constipation","abdominal_pain","diarrhoea","toxic_look_typhos","belly_pain"],
  Dengue: ["high_fever","headache","pain_behind_the_eyes","loss_of_appetite","back_pain","skin_rash","vomiting","fatigue","chills","joint_pain","malaise","muscle_pain","red_spots_over_body"],
  Chikungunya: ["skin_rash","joint_pain","fatigue","nausea","redness_of_eyes"],
  Tuberculosis: ["blood_in_sputum","chest_pain","phlegm","malaise","swelled_lymph_nodes","yellowing_of_eyes","mild_fever","loss_of_appetite","sweating","breathlessness","high_fever","cough","weight_loss","fatigue","vomiting","chills"],
  "Hepatitis B": ["yellowing_of_eyes","malaise","receiving_blood_transfusion","receiving_unsterile_injections","yellowish_skin","lethargy","fatigue","itching","yellow_urine","abdominal_pain","loss_of_appetite","dark_urine"],
  "Hepatitis C": ["fatigue","yellowish_skin","nausea","loss_of_appetite","receiving_blood_transfusion","receiving_unsterile_injections","yellowing_of_eyes"],
  "Hepatitis D": ["joint_pain","vomiting","fatigue","yellowish_skin","dark_urine","nausea","loss_of_appetite","abdominal_pain","yellowing_of_eyes"],
  Pneumonia: ["chest_pain","rusty_sputum","fast_heart_rate","cough","fatigue","chills","high_fever","malaise","sweating","breathlessness","phlegm"],
  "Heart attack": ["heartburn","chest_pain","vomiting","sweating","breathlessness"],
  "Paralysis (Brain Hemorrhage)": ["altered_sensorium","vomiting","headache","weakness_of_one_body_side"],
  Hypoglycemia: ["slurred_speech","irritability","palpitations","excessive_hunger","sweating","anxiety","fatigue","vomiting","blurred_and_distorted_vision","nausea","headache","drying_and_tingling_lips"],
  "Hepatitis A": ["mild_fever","muscle_pain","yellowing_of_eyes","yellowish_skin","vomiting","joint_pain","dark_urine","abdominal_pain","loss_of_appetite","nausea","diarrhoea"],
  "Hepatitis E": ["stomach_bleeding","yellowing_of_eyes","coma","loss_of_appetite","abdominal_pain","yellowish_skin","high_fever","fatigue","vomiting","joint_pain","nausea","dark_urine","acute_liver_failure"],
  "Alcoholic Hepatitis": ["vomiting","yellowish_skin","abdominal_pain","fluid_overload","swelling_of_stomach","distention_of_abdomen","history_of_alcohol_consumption"],
  "Chronic cholestasis": ["itching","vomiting","yellowish_skin","nausea","loss_of_appetite","abdominal_pain","yellowing_of_eyes"],
  Jaundice: ["itching","vomiting","fatigue","weight_loss","high_fever","yellowish_skin","dark_urine","abdominal_pain"],
  "Chicken Pox": ["malaise","red_spots_over_body","itching","fatigue","skin_rash","lethargy","high_fever","loss_of_appetite","headache","swelled_lymph_nodes","mild_fever"],
  "Bronchial Asthma": ["breathlessness","high_fever","family_history","mucoid_sputum","cough","fatigue"],
  "Urinary Tract Infection": ["bladder_discomfort","continuous_feel_of_urine","burning_micturition","foul_smell_of_urine"],
  "Dimorphic Haemorrhoids": ["constipation","pain_during_bowel_movements","pain_in_anal_region","bloody_stool","irritation_in_anus"],
  "Peptic Ulcer Disease": ["vomiting","abdominal_pain","internal_itching","passage_of_gases","indigestion","loss_of_appetite"],
  Diabetes: ["polyuria","increased_appetite","weight_loss","restlessness","fatigue","excessive_hunger","lethargy","irregular_sugar_level","blurred_and_distorted_vision","obesity","mood_swings","dehydration","urinating_a_lot"],
  Hypertension: ["lack_of_concentration","loss_of_balance","headache","dizziness","chest_pain"],
  Gastroenteritis: ["diarrhoea","vomiting","sunken_eyes","dehydration"],
  Hypothyroidism: ["irritability","swollen_extremeties","depression","enlarged_thyroid","brittle_nails","abnormal_menstruation","weight_gain","cold_hands_and_feets","mood_swings","dizziness","lethargy","puffy_face_and_eyes","fatigue"],
  Hyperthyroidism: ["muscle_weakness","abnormal_menstruation","irritability","weight_loss","mood_swings","fatigue","restlessness","fast_heart_rate","diarrhoea","sweating","excessive_hunger"],
  "Fungal Infection": ["itching","skin_rash","nodal_skin_eruptions","dischromic_patches"],
  Allergy: ["continuous_sneezing","shivering","chills","watering_from_eyes"],
  "Common Cold": ["phlegm","muscle_pain","loss_of_smell","chest_pain","congestion","runny_nose","sinus_pressure","redness_of_eyes","throat_irritation","continuous_sneezing","malaise","headache","swelled_lymph_nodes","fatigue","cough","chills","high_fever"],
  "Drug Reaction": ["itching","skin_rash","stomach_pain","burning_micturition","spotting_urination"],
  GERD: ["stomach_pain","chest_pain","cough","acidity","vomiting","ulcers_on_tongue"],
  Migraine: ["acidity","indigestion","headache","blurred_and_distorted_vision","excessive_hunger","stiff_neck","depression","irritability","visual_disturbances"],
  "Cervical spondylosis": ["neck_pain","loss_of_balance","dizziness","back_pain","weakness_in_limbs"],
  "Varicose veins": ["fatigue","cramps","bruising","obesity","swollen_legs","prominent_veins_on_calf","swollen_blood_vessels"],
  Osteoarthritis: ["joint_pain","neck_pain","knee_pain","hip_joint_pain","swelling_joints","painful_walking"],
  Arthritis: ["muscle_weakness","stiff_neck","swelling_joints","movement_stiffness","painful_walking"],
  "Paroxysmal Positional Vertigo": ["vomiting","headache","nausea","loss_of_balance","unsteadiness","spinning_movements"],
  Acne: ["skin_rash","pus_filled_pimples","blackheads","scurring"],
  Psoriasis: ["skin_rash","joint_pain","skin_peeling","silver_like_dusting","small_dents_in_nails","inflammatory_nails"],
  Impetigo: ["skin_rash","blister","red_sore_around_nose","yellow_crust_ooze","high_fever"],
  Meningitis: ["high_fever","headache","stiff_neck","vomiting","altered_sensorium","coma"],
};

const RISK_MAP = {
  Malaria:"High", Typhoid:"High", Dengue:"High", Chikungunya:"High", Tuberculosis:"High", "Hepatitis B":"High", "Hepatitis C":"High", "Hepatitis D":"High", Pneumonia:"High", "Heart attack":"High", "Paralysis (Brain Hemorrhage)":"High", Hypoglycemia:"High", Meningitis:"High",
  "Hepatitis A":"Medium", "Hepatitis E":"Medium", "Alcoholic Hepatitis":"Medium", "Chronic cholestasis":"Medium", Jaundice:"Medium", "Chicken Pox":"Medium", "Bronchial Asthma":"Medium", "Urinary Tract Infection":"Medium", "Dimorphic Haemorrhoids":"Medium", "Peptic Ulcer Disease":"Medium", Diabetes:"Medium", Hypertension:"Medium", Gastroenteritis:"Medium", Hypothyroidism:"Medium", Hyperthyroidism:"Medium",
  "Fungal Infection":"Low", Allergy:"Low", "Common Cold":"Low", "Drug Reaction":"Low", GERD:"Low", Migraine:"Low", "Cervical spondylosis":"Low", "Varicose veins":"Low", Osteoarthritis:"Low", Arthritis:"Low", "Paroxysmal Positional Vertigo":"Low", Acne:"Low", Psoriasis:"Low", Impetigo:"Low",
};

// ─────────────────────────────────────────────
// SYMPTOM SPECIFICITY WEIGHTS
// Mirrors the backend's SYMPTOM_WEIGHT (main.py): an inverse-frequency
// weight per symptom, based on how many diseases in DISEASE_SYMPTOM_MAP
// list it -- 1.0 for a symptom unique to one disease, dropping toward
// ~0.05-0.15 for symptoms shared across a dozen or more (fever, fatigue,
// etc.). Applied to confirmed-symptom scoring only, in scoreDisease and
// diseaseConfidence below, so confirming a highly distinguishing symptom
// counts far more than confirming a generic one -- offline results now
// actually match what the server computes instead of silently drifting
// from it.
// ─────────────────────────────────────────────
const _SYMPTOM_DISEASE_COUNT = {};
Object.values(DISEASE_SYMPTOM_MAP).forEach((syms) => {
  new Set(syms).forEach((s) => {
    _SYMPTOM_DISEASE_COUNT[s] = (_SYMPTOM_DISEASE_COUNT[s] || 0) + 1;
  });
});
const SYMPTOM_WEIGHT = Object.fromEntries(
  Object.entries(_SYMPTOM_DISEASE_COUNT).map(([s, c]) => [s, Math.round((1 / c) * 10000) / 10000])
);

// A single disease may not consume more than this many of the 15-question
// budget in getNextQuestionOffline(), even while it's the top-scoring
// candidate -- mirrors the backend's QUESTION_MONOPOLY_CAP (main.py).
const QUESTION_MONOPOLY_CAP = 8;

const ALL_QUESTIONS = [
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

const Q_INDEX = Object.fromEntries(ALL_QUESTIONS.map((q) => [q.id, q]));

function scoreDisease(disease, answers) {
  let score = 0;
  for (const s of DISEASE_SYMPTOM_MAP[disease] || []) {
    if (answers[s] === true)  score += 3 * (SYMPTOM_WEIGHT[s] ?? 1);
    if (answers[s] === false) score -= 1;
  }
  return score;
}

// ─────────────────────────────────────────────
// DISEASE CONFIDENCE (mirrors the backend's _disease_confidence exactly,
// so offline results never disagree with what the server would compute)
// ─────────────────────────────────────────────
//
// Two things previously drifted out of sync with the backend:
//
// 1. Coverage floor -- this used "0.65 + 0.35 * coverage", understating
//    how much a strong but partial match should count once the backend
//    moved to "0.25 + 0.75 * coverage" (a disease that had barely been
//    probed could still show ~70% confidence purely from a tiny,
//    low-coverage sample matching). Now identical to the server.
//
// 2. Match ratio -- this used a flat yes/relevant count, treating a
//    generic symptom like "fatigue" (shared by many of the 41 diseases) as
//    equally diagnostic as a specific one like "polyuria" (unique to
//    Diabetes). The backend weights each symptom by SYMPTOM_WEIGHT
//    (inverse disease-frequency) when computing the match ratio; this
//    now does the same, so confirming a highly distinguishing symptom
//    moves the ratio far more than confirming a generic one -- exactly
//    the mismatch that let common-symptom diseases (e.g. Malaria, whose
//    list overlaps heavily with several other febrile illnesses) look
//    artificially under- or over-confident relative to narrower ones.
function diseaseConfidence(disease, answers, asked = null) {
  const symptoms = DISEASE_SYMPTOM_MAP[disease] || [];
  if (symptoms.length === 0) return 0;

  const relevant = asked
    ? symptoms.filter((s) => asked.includes(s))
    : symptoms.filter((s) => s in answers);

  if (relevant.length === 0) return 0;

  const weightTotal = relevant.reduce((sum, s) => sum + (SYMPTOM_WEIGHT[s] ?? 1), 0);
  if (weightTotal <= 0) return 0;

  const matchedWeight = relevant
    .filter((s) => answers[s] === true)
    .reduce((sum, s) => sum + (SYMPTOM_WEIGHT[s] ?? 1), 0);
  if (matchedWeight === 0) return 0;

  const matchRatio = matchedWeight / weightTotal;
  const coverage    = Math.min(relevant.length / symptoms.length, 1);

  // Coverage factor scales from a low floor near zero coverage up toward
  // 1.0 as more of the disease's own symptom list is actually covered,
  // so confidence tracks how much real evidence was gathered rather than
  // just the ratio within whatever small sample happened to be asked.
  const coverageFactor = Math.min(1, 0.25 + 0.75 * coverage);
  const confidence = matchRatio * coverageFactor;
  return Math.round(Math.min(0.95, Math.max(0.10, confidence)) * 10000) / 10000;
}

// ─────────────────────────────────────────────
// NEXT QUESTION (offline) -- mirrors the backend's get_next_question fix.
//
// Pool width is a FRACTION of the active disease list (the original
// 22-disease design's 6/22, 3/22, 2/22 ratios), not a fixed headcount, so
// this scales automatically if the disease list ever grows or shrinks
// instead of silently starving the tail the way a fixed poolSize=6 did
// once this list grew past 22 diseases.
//
// It also fixes a reachability gap: when several candidates are fully
// tied (identical score AND identical askedCount -- normally the
// untouched, zero-scored bulk early in a session), the previous version
// broke the tie by picking whichever candidate happened to sit first in
// DISEASE_SYMPTOM_MAP's definition order and asking ITS next symptom.
// That's an arbitrary, non-clinical tie-break: with a large disease list
// a disease could go an entire session without ever being probed --
// still possibly ranked #1 by elimination, but showing 0% confidence,
// since confidence only reflects symptoms actually asked. This version
// breaks a genuine tie by asking about whichever unasked symptom is
// shared by the MOST currently-tied candidates, so one question narrows
// the largest possible slice of the tied group at once, and reachability
// depends on how distinctive a disease's symptoms are, not on where it
// sits in the object literal. A single leading candidate is unaffected --
// its own next unasked symptom is still asked directly.
// ─────────────────────────────────────────────
function getNextQuestionOffline(answers, asked) {
  const nDiseases = Object.keys(DISEASE_SYMPTOM_MAP).length;
  const scores = {};
  Object.keys(DISEASE_SYMPTOM_MAP).forEach((d) => { scores[d] = scoreDisease(d, answers); });
  const ranked = Object.keys(DISEASE_SYMPTOM_MAP).sort((a, b) => scores[b] - scores[a]);

  const nAsked   = asked.length;
  const poolSize = nAsked < 6
    ? Math.max(6, Math.round(nDiseases * 6 / 22))
    : nAsked < 11
      ? Math.max(3, Math.round(nDiseases * 3 / 22))
      : Math.max(2, Math.round(nDiseases * 2 / 22));
  const top = ranked.slice(0, poolSize);

  const askedCount = (d) => (DISEASE_SYMPTOM_MAP[d] || []).filter((s) => asked.includes(s)).length;
  const hasUnasked = (d) => (DISEASE_SYMPTOM_MAP[d] || []).some((s) => !asked.includes(s));

  const underCap   = top.filter((d) => hasUnasked(d) && askedCount(d) < QUESTION_MONOPOLY_CAP);
  const candidates = underCap.length > 0 ? underCap : top.filter(hasUnasked);

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      const scoreDiff = scores[b] - scores[a];
      return scoreDiff !== 0 ? scoreDiff : askedCount(a) - askedCount(b);
    });
    const bestScore = scores[candidates[0]];
    const bestAsked = askedCount(candidates[0]);
    const tied = candidates.filter((d) => scores[d] === bestScore && askedCount(d) === bestAsked);

    if (tied.length === 1) {
      const chosen = tied[0];
      for (const sym of DISEASE_SYMPTOM_MAP[chosen] || []) {
        if (!asked.includes(sym)) {
          const q = Q_INDEX[sym];
          if (q) return q;
        }
      }
    } else {
      const coverage = {};
      tied.forEach((d) => {
        (DISEASE_SYMPTOM_MAP[d] || []).forEach((sym) => {
          if (!asked.includes(sym)) coverage[sym] = (coverage[sym] || 0) + 1;
        });
      });
      const symptomOrder = {};
      ALL_QUESTIONS.forEach((q, i) => { symptomOrder[q.id] = i; });
      const coverageKeys = Object.keys(coverage);
      if (coverageKeys.length > 0) {
        coverageKeys.sort((a, b) => {
          const diff = coverage[b] - coverage[a];
          return diff !== 0 ? diff : (symptomOrder[a] ?? 0) - (symptomOrder[b] ?? 0);
        });
        const q = Q_INDEX[coverageKeys[0]];
        if (q) return q;
      }
    }
  }

  return ALL_QUESTIONS.find((q) => !asked.includes(q.id)) || null;
}

// ─────────────────────────────────────────────
// OFFLINE CONFIDENCE SNAPSHOT
// ─────────────────────────────────────────────
function computeOfflineSnapshot(answers, asked = null) {
  const snapshot = {};
  Object.keys(DISEASE_SYMPTOM_MAP).forEach((d) => {
    snapshot[d] = diseaseConfidence(d, answers, asked);
  });
  return snapshot;
}

// ─────────────────────────────────────────────
// OFFLINE PREDICTION
// ─────────────────────────────────────────────
function predictOffline(answers, asked = null) {
  const yesCount = Object.values(answers).filter((v) => v === true).length;

  if (yesCount < 2) {
    return {
      disease:     null, confidence: 0.0, risk: "None",
      explanation: "No significant symptoms were reported.",
      recommendation: {
        home_care: "You appear to be in good health based on your responses.",
        test:      "No tests are indicated at this time.",
        doctor:    "See a doctor if you develop any symptoms or feel unwell.",
        safety:    "",
      },
      all_scores: {}, method: "insufficient_evidence",
    };
  }

  const sorted = Object.keys(DISEASE_SYMPTOM_MAP)
    .map((d) => {
      const sc   = scoreDisease(d, answers);
      const conf = diseaseConfidence(d, answers, asked);
      return { d, sc, conf };
    })
    .sort((a, b) => b.sc - a.sc);

  if (sorted[0].sc <= 0) {
    return {
      disease: null, confidence: 0.0, risk: "None",
      explanation: "No significant symptoms were reported.",
      recommendation: {
        home_care: "You appear to be in good health based on your responses.",
        test:      "No tests are indicated at this time.",
        doctor:    "See a doctor if you develop any symptoms or feel unwell.",
        safety:    "",
      },
      all_scores: {}, method: "insufficient_evidence",
    };
  }

  // sorted is ranked by raw weighted-match score (sc), which is only
  // used above to decide whether there's enough signal to proceed at
  // all. The headline result and the differential list must both be
  // ranked by the same calibrated confidence (conf), or the primary
  // diagnosis shown can end up lower-confidence than something listed
  // underneath it as an "other possibility" — mirrors the same fix
  // applied server-side in predict_with_ml / the scoring fallback.
  const byConfidence = [...sorted].sort((a, b) => b.conf - a.conf);
  const top  = byConfidence[0];
  const risk = RISK_MAP[top.d] || "Medium";

  return {
    disease:     top.d,
    confidence:  top.conf,
    risk,
    explanation: `The reported symptoms are consistent with ${top.d}.`,
    recommendation: {
      home_care: "Rest, stay hydrated, and monitor your symptoms closely.",
      test:      "Consult a healthcare provider to arrange appropriate diagnostic tests.",
      doctor:    risk === "High" ? "Visit a hospital or clinic without delay." : "See a doctor if symptoms persist or worsen.",
      safety:    risk === "High" ? "Do not wait — seek medical attention today." : "",
    },
    all_scores: Object.fromEntries(
      byConfidence.slice(0, 6).map((x) => [x.d, parseFloat(x.conf.toFixed(4))])
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
      --teal:#0c8a7e;--teal-d:#0a6b62;--teal-dd:#074d47;--teal-l:#bdf0ea;--teal-xl:#eefcfa;
      --teal-rgb:12,138,126;
      --red:#e23d3d;--red-d:#c22f2f;--red-l:#fdecec;
      --amber:#e8930f;--amber-d:#b9740a;--amber-l:#fef3e0;
      --green:#1f9d55;--green-d:#16793f;--green-l:#e9f9ee;
      --blue:#2f6fed;--blue-d:#1d54c4;--blue-l:#eaf1ff;
      --purple:#7c5cf0;--purple-d:#5f3fd0;--purple-l:#f1ecfe;
      --ink:#0b1726;--ink-2:#1a2a3c;--ink-3:#324154;
      --muted:#5b6b7c;--muted-l:#90a0ae;
      --border:#dde4ea;--border-l:#eef2f5;
      --surface:#ffffff;--bg:#f4f7f9;
      --font:'Sora',sans-serif;--display:'Playfair Display',serif;
      --radius-s:10px;--radius:16px;--radius-l:24px;
      --shadow-xs:0 1px 2px rgba(11,23,38,0.05);
      --shadow-s:0 1px 4px rgba(11,23,38,0.07),0 1px 2px rgba(11,23,38,0.04);
      --shadow:0 6px 24px rgba(11,23,38,0.09),0 2px 6px rgba(11,23,38,0.05);
      --shadow-l:0 14px 48px rgba(11,23,38,0.14),0 4px 12px rgba(11,23,38,0.06);
      --ease:cubic-bezier(0.4,0,0.2,1);
      --ease-spring:cubic-bezier(0.34,1.56,0.64,1);
      --t-fast:150ms var(--ease);
      --t-med:220ms var(--ease);
      --t-slow:300ms var(--ease);
      --focus-ring:0 0 0 3px rgba(12,138,126,0.28);
    }

    /* ── Dark theme ───────────────────────── */
    :root[data-theme="dark"] {
      --ink:#e8eef3;--ink-2:#c3ced9;--ink-3:#94a3b3;
      --muted:#7c8a99;--muted-l:#4f5d6c;
      --border:#263241;--border-l:#1c2733;
      --surface:#161f29;--bg:#0f161e;
      --teal:#14b8a6;--teal-d:#2dd4bf;--teal-dd:#0e8f80;
      --teal-l:#1b3d35;--teal-xl:#102621;--teal-rgb:20,184,166;
      --red:#f25656;--red-d:#f87171;--red-l:#2c1618;
      --amber:#e8a838;--amber-d:#fbbf24;--amber-l:#2a2013;
      --green:#34c77f;--green-d:#4ade80;--green-l:#102420;
      --blue:#5b8def;--blue-d:#7ea8f5;--blue-l:#142233;
      --purple:#9b86f3;--purple-d:#b3a2f7;--purple-l:#1d1a33;
      --shadow-xs:0 1px 2px rgba(0,0,0,0.30);
      --shadow-s:0 1px 4px rgba(0,0,0,0.35),0 1px 2px rgba(0,0,0,0.24);
      --shadow:0 6px 24px rgba(0,0,0,0.42),0 2px 6px rgba(0,0,0,0.26);
      --shadow-l:0 14px 48px rgba(0,0,0,0.52),0 4px 12px rgba(0,0,0,0.30);
      --focus-ring:0 0 0 3px rgba(20,184,166,0.30);
    }
    :root[data-theme="dark"] .badge-High   { background:var(--red-l); color:var(--red-d); }
    :root[data-theme="dark"] .badge-Medium { background:var(--amber-l); color:var(--amber-d); }
    :root[data-theme="dark"] .badge-Low    { background:var(--green-l); color:var(--green-d); }
    :root[data-theme="dark"] .badge-teal   { background:var(--teal-xl); color:var(--teal-d); }
    :root[data-theme="dark"] .shell        { background:var(--bg); }
    :root[data-theme="dark"] .sidebar      { background:var(--surface); border-color:var(--border); }
    :root[data-theme="dark"] .bottom-nav   { background:var(--surface); border-color:var(--border); box-shadow:0 -6px 24px rgba(0,0,0,0.3); }
    :root[data-theme="dark"] .nav-item:hover,
    :root[data-theme="dark"] .nav-item.active { background:var(--teal-xl); color:var(--teal-d); }
    :root[data-theme="dark"] .card { box-shadow:var(--shadow-s); }
    :root[data-theme="dark"] .auth-wrap { background:radial-gradient(circle at 20% 15%,#123833 0%,#0f161e 45%),linear-gradient(165deg,#102621 0%,#0f161e 60%); }
    :root[data-theme="dark"] .auth-blob-a { background:radial-gradient(circle,rgba(20,184,166,0.16) 0%,transparent 70%); }
    :root[data-theme="dark"] .auth-blob-b { background:radial-gradient(circle,rgba(91,141,239,0.14) 0%,transparent 70%); }
    :root[data-theme="dark"] .auth-box .card { box-shadow:0 12px 40px rgba(0,0,0,0.45); }
    :root[data-theme="dark"] .auth-input-icon { color:var(--muted-l); }
    :root[data-theme="dark"] .field-input.has-icon { background:#0c1218; }
    :root[data-theme="dark"] .auth-divider::before,
    :root[data-theme="dark"] .auth-divider::after { background:var(--border); }
    :root[data-theme="dark"] .social-btn { background:#0c1218; border-color:var(--border); color:var(--ink-2); }
    :root[data-theme="dark"] .social-btn:hover { border-color:var(--muted-l); background:var(--border-l); }
    :root[data-theme="dark"] .auth-forgot { color:var(--teal-d); }
    :root[data-theme="dark"] .field-input { background:#0c1218; color:var(--ink); border-color:var(--border); }
    :root[data-theme="dark"] .field-input:hover { border-color:var(--muted-l); }
    :root[data-theme="dark"] .field-input:focus { border-color:var(--teal-d); }
    :root[data-theme="dark"] .field-input::placeholder { color:var(--muted-l); }
    :root[data-theme="dark"] .field-select { background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237c8a99' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); }
    :root[data-theme="dark"] .search-input { background:var(--surface); color:var(--ink); border-color:var(--border); }
    :root[data-theme="dark"] .search-input:focus { border-color:var(--teal-d); }
    :root[data-theme="dark"] .chip { background:var(--surface); border-color:var(--border); color:var(--muted); }
    :root[data-theme="dark"] .chip:hover { border-color:var(--muted-l); }
    :root[data-theme="dark"] .chip.on { background:var(--teal-xl); border-color:var(--teal-d); color:var(--teal-d); }
    :root[data-theme="dark"] .tabs { background:var(--border-l); }
    :root[data-theme="dark"] .tab { color:var(--muted); }
    :root[data-theme="dark"] .tab.active { background:var(--surface); color:var(--ink); }
    :root[data-theme="dark"] .disclaimer { background:var(--amber-l); border-color:#4a3a1a; }
    :root[data-theme="dark"] .disclaimer p { color:var(--amber-d); }
    :root[data-theme="dark"] .rec-bubble { background:var(--surface); }
    :root[data-theme="dark"] .rec-bubble-text { color:var(--ink-2); }
    :root[data-theme="dark"] .score-bar-fill { background:linear-gradient(90deg,var(--muted-l),var(--muted)); }
    :root[data-theme="dark"] .score-bar-track { background:var(--border-l); }
    :root[data-theme="dark"] .result-ring-High   { background:linear-gradient(155deg,#241417,#33181c); box-shadow:0 0 0 10px rgba(242,86,86,0.08); }
    :root[data-theme="dark"] .result-ring-Medium { background:linear-gradient(155deg,#241c10,#332514); box-shadow:0 0 0 10px rgba(232,168,56,0.08); }
    :root[data-theme="dark"] .result-ring-Low    { background:linear-gradient(155deg,#0e2018,#152d22); box-shadow:0 0 0 10px rgba(52,199,127,0.08); }
    :root[data-theme="dark"] .result-ring-None   { background:linear-gradient(155deg,#0e2018,#152d22); box-shadow:0 0 0 10px rgba(52,199,127,0.08); }
    :root[data-theme="dark"] .no-symptoms-ring   { background:linear-gradient(155deg,#0e2018,#152d22); box-shadow:0 0 0 10px rgba(52,199,127,0.08); }
    :root[data-theme="dark"] .al-hero { background:linear-gradient(150deg,var(--teal-xl) 0%,var(--blue-l) 100%); border-color:var(--teal-l); }
    :root[data-theme="dark"] .about-mission { background:var(--teal-xl); border-color:var(--teal-l); }
    :root[data-theme="dark"] .about-mission-label { color:var(--teal-d); }
    :root[data-theme="dark"] .about-mission-text { color:var(--ink-2); }
    :root[data-theme="dark"] .about-fact { background:var(--surface); border-color:var(--border); }
    :root[data-theme="dark"] .about-team-card { background:var(--surface); border-color:var(--border); }
    :root[data-theme="dark"] .edit-panel { background:var(--border-l); border-color:var(--border); }
    :root[data-theme="dark"] .sec-field-wrap { background:var(--border-l); border-color:var(--border); }
    :root[data-theme="dark"] .q-screen { background:var(--bg); }
    :root[data-theme="dark"] .q-topbar { background:var(--surface); border-color:var(--border); }
    :root[data-theme="dark"] .q-close { background:var(--border-l); }
    :root[data-theme="dark"] .q-close:hover { background:var(--border); }
    :root[data-theme="dark"] .q-cat-pill { background:var(--teal-xl); color:var(--teal-d); border-color:var(--teal-l); }
    :root[data-theme="dark"] .prog-track { background:var(--border-l); }
    :root[data-theme="dark"] .ans-btn { background:var(--surface); border-color:var(--border); color:var(--ink); }
    :root[data-theme="dark"] .ans-btn.yes { background:var(--teal-xl); border-color:var(--teal-l); color:var(--teal-d); }
    :root[data-theme="dark"] .ans-btn.no { background:var(--border-l); border-color:var(--border); color:var(--ink-3); }
    :root[data-theme="dark"] .ans-yes-icon { background:var(--teal-l); }
    :root[data-theme="dark"] .ans-no-icon { background:var(--border); }
    :root[data-theme="dark"] .analyzing { background:var(--bg); }
    :root[data-theme="dark"] .toggle-slider { background:var(--border); }
    :root[data-theme="dark"] .menu-ico { background:var(--border-l); }
    :root[data-theme="dark"] .feat-icon { background:var(--border-l); }
    :root[data-theme="dark"] .icon-btn { background:var(--border-l) !important; }
    :root[data-theme="dark"] .icon-btn:hover { background:var(--border) !important; }
    :root[data-theme="dark"] .pw-toggle { color:var(--muted-l); }
    :root[data-theme="dark"] .pw-toggle:hover { color:var(--teal-d); background:var(--teal-xl); }
    :root[data-theme="dark"] .notif { background:#e8eef3; color:#0f161e; box-shadow:var(--shadow-l); }
    :root[data-theme="dark"] .bnav-item.active { color:var(--teal-d); }
    :root[data-theme="dark"] .hero-card { box-shadow:0 12px 32px rgba(0,0,0,0.4); }
    :root[data-theme="dark"] .about-hero { box-shadow:0 12px 32px rgba(0,0,0,0.4); }
    :root[data-theme="dark"] .theme-preview-swatch { border-color:var(--border); }
    :root[data-theme="dark"] .theme-preview-swatch.selected { border-color:var(--teal-d); box-shadow:0 0 0 2px rgba(20,184,166,0.2); }
    :root[data-theme="dark"] .stat-card { background:var(--surface); border-color:var(--border); }
    :root[data-theme="dark"] .empty-state-card { background:var(--surface); border-color:var(--border); }

    /* ── Base styles ─────────────────────── */
    html,body{height:100%;font-family:var(--font);background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent;}
    body{font-size:15px;}
    #root{height:100%;}
    ::selection{background:var(--teal-l);color:var(--teal-dd);}
    a{color:var(--teal-d);}
    button,input,select,textarea{font-family:var(--font);}
    button{cursor:pointer;}
    button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{outline:none;box-shadow:var(--focus-ring);}
    .shell{display:flex;height:100vh;overflow:hidden;background:var(--bg);}
    .sidebar{width:240px;min-height:100vh;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0;padding:28px 0;transition:width var(--t-med);}
    .main{flex:1;overflow-y:auto;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;}
    @media(max-width:1024px){.sidebar{width:208px;}}
    @media(max-width:767px){.sidebar{display:none;}.main{padding-bottom:76px;}}
    .sidebar-brand{display:flex;align-items:center;gap:10px;padding:0 20px 28px;}
    .brand-mark{width:36px;height:36px;background:linear-gradient(155deg,var(--teal) 0%,var(--teal-dd) 100%);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 3px 10px rgba(var(--teal-rgb),0.32);}
    .brand-name{font-family:var(--display);font-size:18px;font-weight:700;color:var(--ink);letter-spacing:-0.2px;}
    .brand-sub{font-size:10px;color:var(--muted);font-weight:600;letter-spacing:0.04em;text-transform:uppercase;}
    .sidebar-nav{flex:1;padding:0 10px;}
    .nav-item{display:flex;align-items:center;gap:10px;width:100%;padding:11px 14px;border-radius:var(--radius-s);border:none;background:none;font-family:var(--font);font-size:14px;font-weight:600;color:var(--muted);cursor:pointer;transition:background var(--t-fast),color var(--t-fast),transform var(--t-fast);margin-bottom:2px;text-align:left;position:relative;}
    .nav-item:hover{background:var(--teal-xl);color:var(--teal-d);}
    .nav-item:active{transform:scale(0.98);}
    .nav-item.active{background:var(--teal-xl);color:var(--teal-d);font-weight:700;}
    .nav-item.active::before{content:'';position:absolute;left:-10px;top:8px;bottom:8px;width:3px;background:var(--teal);border-radius:0 4px 4px 0;}
    .sidebar-foot{padding:16px 10px 0;border-top:1px solid var(--border);margin:0 10px;}
    .bottom-nav{position:fixed;bottom:0;left:0;right:0;background:var(--surface);border-top:1px solid var(--border);display:none;z-index:100;padding:6px 0 calc(6px + env(safe-area-inset-bottom));box-shadow:0 -6px 24px rgba(11,23,38,0.06);}
    @media(max-width:767px){.bottom-nav{display:flex;}}
    .bnav-item{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 4px;border:none;background:none;font-family:var(--font);font-size:10px;font-weight:700;color:var(--muted-l);cursor:pointer;transition:color var(--t-fast),transform var(--t-fast);min-height:48px;justify-content:center;}
    .bnav-item:active{transform:scale(0.94);}
    .bnav-item.active{color:var(--teal-d);}
    .bnav-item svg{width:20px;height:20px;}
    .page{animation:pageIn var(--t-slow) var(--ease);}
    @keyframes pageIn{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:none;}}
    .page-head{padding:24px 24px 0;}
    .page-body{padding:20px 24px 40px;}
    @media(max-width:767px){.page-head{padding:18px 16px 0;}.page-body{padding:16px 16px 32px;}}
    @media(max-width:380px){.page-head{padding:16px 12px 0;}.page-body{padding:14px 12px 28px;}}
    .t-display{font-family:var(--display);font-size:26px;font-weight:700;color:var(--ink);line-height:1.2;letter-spacing:-0.3px;}
    @media(max-width:480px){.t-display{font-size:22px;}}
    .t-title{font-size:18px;font-weight:700;color:var(--ink);line-height:1.3;}
    .t-subtitle{font-size:14px;color:var(--muted);font-weight:400;line-height:1.55;}
    .t-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);}
    .t-mono{font-feature-settings:'tnum';}
    .card{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow-s);border:1px solid var(--border);transition:box-shadow var(--t-med),transform var(--t-med);}
    .card-p{padding:20px;}
    @media(max-width:480px){.card-p{padding:16px;}}
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:13px 22px;border-radius:var(--radius-s);font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;border:none;transition:background var(--t-fast),box-shadow var(--t-fast),transform var(--t-fast),opacity var(--t-fast);line-height:1;min-height:44px;}
    .btn:active:not(:disabled){transform:scale(0.97);}
    .btn:disabled{opacity:0.5;cursor:not-allowed;}
    .btn-primary{background:linear-gradient(160deg,var(--teal) 0%,var(--teal-d) 100%);color:#fff;box-shadow:0 4px 14px rgba(var(--teal-rgb),0.3);}
    .btn-primary:hover:not(:disabled){background:linear-gradient(160deg,var(--teal-d) 0%,var(--teal-dd) 100%);box-shadow:0 8px 22px rgba(var(--teal-rgb),0.38);transform:translateY(-1px);}
    .btn-primary:active:not(:disabled){transform:translateY(0) scale(0.97);}
    .btn-secondary{background:var(--border-l);color:var(--ink-2);}
    .btn-secondary:hover:not(:disabled){background:var(--border);}
    .btn-danger{background:linear-gradient(160deg,var(--red) 0%,var(--red-d) 100%);color:#fff;box-shadow:0 4px 14px rgba(226,61,61,0.28);}
    .btn-danger:hover:not(:disabled){background:linear-gradient(160deg,var(--red-d) 0%,#9e2424 100%);box-shadow:0 8px 22px rgba(226,61,61,0.34);transform:translateY(-1px);}
    .btn-danger:active:not(:disabled){transform:translateY(0) scale(0.97);}
    .btn-outline{background:transparent;color:var(--teal-d);border:2px solid var(--teal);}
    .btn-outline:hover:not(:disabled){background:var(--teal-xl);}
    .btn-full{width:100%;}
    .btn-lg{padding:16px 28px;font-size:15px;border-radius:var(--radius);min-height:52px;}
    .btn-sm{padding:9px 16px;font-size:12px;min-height:36px;}
    .field{margin-bottom:14px;}
    .field-label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);margin-bottom:6px;}
    .field-input{width:100%;padding:12px 14px;border:1.5px solid var(--border);border-radius:var(--radius-s);font-family:var(--font);font-size:15px;color:var(--ink);background:var(--surface);outline:none;transition:border-color var(--t-fast),box-shadow var(--t-fast);min-height:46px;}
    .field-input:hover{border-color:var(--muted-l);}
    .field-input:focus{border-color:var(--teal);box-shadow:var(--focus-ring);}
    .field-input::placeholder{color:var(--muted-l);}
    .field-select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2390a0ae' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:16px;cursor:pointer;}
    .badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:700;letter-spacing:0.01em;}
    .badge-High{background:var(--red-l);color:var(--red-d);}
    .badge-Medium{background:var(--amber-l);color:var(--amber-d);}
    .badge-Low{background:var(--green-l);color:var(--green-d);}
    .badge-teal{background:var(--teal-xl);color:var(--teal-d);}
    .prog-track{height:6px;background:var(--border-l);border-radius:99px;overflow:hidden;}
    .prog-fill{height:100%;background:linear-gradient(90deg,var(--teal-l),var(--teal) 60%,var(--teal-d));border-radius:99px;transition:width var(--t-slow);}
    .avatar{width:38px;height:38px;border-radius:99px;background:var(--teal-xl);display:flex;align-items:center;justify-content:center;color:var(--teal-d);font-weight:700;font-size:14px;flex-shrink:0;border:1px solid var(--teal-l);}
    .avatar-lg{width:64px;height:64px;font-size:22px;background:linear-gradient(160deg,var(--teal-l),var(--teal-xl));box-shadow:var(--shadow-s);}
    .mx-auto{margin-left:auto;margin-right:auto;}
    .splash{position:fixed;inset:0;background:linear-gradient(155deg,var(--teal-dd) 0%,#052e2a 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;transition:opacity 0.45s ease;}
    .splash.fading{opacity:0;pointer-events:none;}
    .splash-logo{width:76px;height:76px;background:rgba(255,255,255,0.12);border-radius:22px;display:flex;align-items:center;justify-content:center;margin-bottom:20px;border:1px solid rgba(255,255,255,0.18);animation:breathe 2.4s ease-in-out infinite;}
    @keyframes breathe{0%,100%{transform:scale(1);}50%{transform:scale(1.04);}}
    .splash-title{font-family:var(--display);font-size:38px;color:#fff;font-weight:700;letter-spacing:-0.5px;}
    @media(max-width:480px){.splash-title{font-size:30px;}}
    .splash-sub{color:rgba(255,255,255,0.62);font-size:13px;margin-top:6px;letter-spacing:0.04em;}
    .splash-dots{display:flex;gap:6px;margin-top:52px;}
    .splash-dot{width:6px;height:6px;border-radius:99px;background:rgba(255,255,255,0.4);animation:dot-bounce 1.3s ease-in-out infinite;}
    .splash-dot:nth-child(2){animation-delay:0.18s;}
    .splash-dot:nth-child(3){animation-delay:0.36s;}
    @keyframes dot-bounce{0%,80%,100%{transform:scale(0.7);opacity:0.4;}40%{transform:scale(1.1);opacity:1;}}
    .auth-wrap{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;overflow:hidden;background:radial-gradient(circle at 18% 12%,var(--teal-l) 0%,transparent 45%),linear-gradient(165deg,var(--teal-xl) 0%,var(--bg) 62%);}
    @media(max-width:480px){.auth-wrap{padding:18px 14px;}}
    .auth-blob-a,.auth-blob-b{position:absolute;border-radius:50%;pointer-events:none;filter:blur(2px);}
    .auth-blob-a{width:420px;height:420px;top:-140px;right:-120px;background:radial-gradient(circle,rgba(var(--teal-rgb),0.14) 0%,transparent 70%);}
    .auth-blob-b{width:340px;height:340px;bottom:-120px;left:-100px;background:radial-gradient(circle,rgba(47,111,237,0.10) 0%,transparent 70%);}
    .auth-box{position:relative;z-index:1;width:100%;max-width:420px;}
    .auth-logo{text-align:center;margin-bottom:32px;}
    .auth-icon{width:60px;height:60px;background:linear-gradient(160deg,var(--teal) 0%,var(--teal-dd) 100%);border-radius:18px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;box-shadow:0 6px 18px rgba(var(--teal-rgb),0.32);}
    .auth-title{font-family:var(--display);font-size:28px;color:var(--ink);font-weight:700;letter-spacing:-0.3px;}
    .auth-hint{font-size:13px;color:var(--muted);margin-top:5px;line-height:1.5;}
    .auth-foot{text-align:center;margin-top:18px;font-size:11px;color:var(--muted-l);line-height:1.7;}
    .auth-card{padding:28px 24px;border-radius:var(--radius-l);backdrop-filter:blur(18px);background:rgba(255,255,255,0.86);}
    :root[data-theme="dark"] .auth-card{background:rgba(22,31,41,0.82);}
    .tabs{display:flex;background:var(--border-l);border-radius:var(--radius-s);padding:4px;margin-bottom:22px;}
    .tab{flex:1;padding:10px;text-align:center;border-radius:8px;font-family:var(--font);font-size:13px;font-weight:700;cursor:pointer;border:none;background:none;color:var(--muted);transition:background var(--t-fast),color var(--t-fast),box-shadow var(--t-fast);min-height:40px;}
    .tab.active{background:var(--surface);color:var(--ink);box-shadow:var(--shadow-s);}
    .field-icon-wrap{position:relative;}
    .auth-input-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted-l);pointer-events:none;}
    .field-input.has-icon{padding-left:42px;}
    .auth-row{display:flex;align-items:center;justify-content:flex-end;margin:-4px 0 14px;}
    .auth-forgot{background:none;border:none;padding:0;font-family:var(--font);font-size:12.5px;font-weight:700;color:var(--teal-d);cursor:pointer;}
    .auth-forgot:hover{text-decoration:underline;}
    .auth-divider{display:flex;align-items:center;gap:12px;margin:22px 0 16px;}
    .auth-divider::before,.auth-divider::after{content:"";flex:1;height:1px;background:var(--border);}
    .auth-divider span{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted-l);white-space:nowrap;}
    .social-row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
    .social-btn{display:flex;align-items:center;justify-content:center;padding:11px;border-radius:var(--radius-s);border:1.5px solid var(--border);background:var(--surface);cursor:pointer;min-height:46px;transition:border-color var(--t-fast),background var(--t-fast),transform var(--t-fast);}
    .social-btn:hover{border-color:var(--muted-l);background:var(--border-l);transform:translateY(-1px);}
    .social-btn:active{transform:translateY(0) scale(0.97);}
    .social-btn:disabled{opacity:0.55;cursor:not-allowed;transform:none;}
    .social-btn-inner{position:relative;display:flex;align-items:center;justify-content:center;}
    .social-soon-badge{position:absolute;top:-14px;left:50%;transform:translateX(-50%);background:var(--ink-3);color:#fff;font-size:8px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;padding:2px 5px;border-radius:5px;white-space:nowrap;line-height:1.3;}
    :root[data-theme="dark"] .social-soon-badge{background:var(--muted-l);color:var(--bg);}
    .auth-apple-note{text-align:center;font-size:11px;color:var(--muted-l);margin-top:14px;}
    .social-spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--border);border-top-color:var(--teal);animation:social-spin 0.7s linear infinite;}
    @keyframes social-spin{to{transform:rotate(360deg);}}
    .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    @media(max-width:360px){.grid-2{grid-template-columns:1fr;}}
    .pw-wrap{position:relative;}
    .pw-toggle{position:absolute;right:13px;top:50%;transform:translateY(-50%);border:none;background:none;cursor:pointer;color:var(--muted-l);display:flex;padding:6px;border-radius:6px;transition:color var(--t-fast),background var(--t-fast);}
    .pw-toggle:hover{color:var(--teal-d);background:var(--teal-xl);}
    .home-header{display:flex;align-items:center;justify-content:space-between;padding:24px 24px 16px;}
    @media(max-width:767px){.home-header{padding:18px 16px 14px;}}
    .greeting{font-size:12px;color:var(--muted);margin-bottom:3px;font-weight:500;}
    .hero-card{margin:0 24px 20px;padding:28px;border-radius:var(--radius-l);background:linear-gradient(150deg,var(--teal) 0%,var(--teal-dd) 100%);position:relative;overflow:hidden;box-shadow:0 12px 32px rgba(var(--teal-rgb),0.24);}
    @media(max-width:767px){.hero-card{margin:0 16px 16px;padding:22px 20px;}}
    .hero-bg-icon{position:absolute;top:-16px;right:-16px;opacity:0.1;}
    .hero-eyebrow{font-size:11px;color:rgba(255,255,255,0.7);font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;}
    .hero-headline{font-family:var(--display);font-size:22px;color:#fff;line-height:1.3;margin-bottom:18px;}
    @media(max-width:480px){.hero-headline{font-size:19px;}}
    .hero-btn{display:inline-flex;align-items:center;gap:6px;background:#fff;color:var(--teal-dd);font-family:var(--font);font-size:13px;font-weight:700;padding:12px 20px;border-radius:10px;border:none;cursor:pointer;transition:box-shadow var(--t-fast),transform var(--t-fast);min-height:44px;}
    .hero-btn:hover{box-shadow:0 8px 22px rgba(0,0,0,0.18);transform:translateY(-1px);}
    .hero-btn:active{transform:translateY(0) scale(0.97);}
    .stats-row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:0 24px 20px;}
    @media(max-width:767px){.stats-row{padding:0 16px 16px;gap:8px;}}
    .stat-card{background:var(--surface);border-radius:var(--radius);border:1px solid var(--border);padding:16px 12px;text-align:center;transition:box-shadow var(--t-med),transform var(--t-med);}
    .stat-card:hover{box-shadow:var(--shadow);transform:translateY(-2px);}
    .stat-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;margin:0 auto 8px;}
    .stat-val{font-size:20px;font-weight:800;color:var(--ink);line-height:1;}
    @media(max-width:360px){.stat-val{font-size:17px;}}
    .stat-lbl{font-size:10px;color:var(--muted);font-weight:600;margin-top:3px;text-transform:uppercase;letter-spacing:0.05em;}
    .section{padding:0 24px 20px;}
    @media(max-width:767px){.section{padding:0 16px 16px;}}
    .section-ttl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:10px;}
    .rec-list{display:flex;flex-direction:column;gap:8px;}
    .rec-card{background:var(--surface);border-radius:var(--radius);border:1px solid var(--border);padding:14px 16px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:box-shadow var(--t-med),transform var(--t-med),border-color var(--t-med);}
    .rec-card:hover{box-shadow:var(--shadow);border-color:var(--teal-l);transform:translateY(-1px);}
    .rec-card:active{transform:translateY(0) scale(0.99);}
    .rec-icon-wrap{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .rec-info{flex:1;min-width:0;}
    .rec-name{font-size:14px;font-weight:700;color:var(--ink);}
    .rec-meta{font-size:12px;color:var(--muted);margin-top:2px;}
    .disease-grid{display:flex;flex-wrap:wrap;gap:6px;}
    .al-hero{background:linear-gradient(150deg,var(--teal-xl) 0%,#e3f1fb 100%);border-radius:var(--radius-l);padding:28px 24px 24px;margin-bottom:16px;display:flex;gap:20px;align-items:center;border:1px solid var(--teal-l);}
    @media(max-width:480px){.al-hero{flex-direction:column;text-align:center;padding:22px 18px;}}
    .al-hero-text{flex:1;}
    .al-hero-illus{flex-shrink:0;width:120px;height:140px;}
    @media(max-width:480px){.al-hero-illus{width:96px;height:112px;}}
    .feat-list{display:flex;flex-direction:column;gap:0;}
    .feat-row{display:flex;align-items:flex-start;gap:14px;padding:14px 0;}
    .feat-row+.feat-row{border-top:1px solid var(--border);}
    .feat-icon{width:36px;height:36px;background:var(--teal-xl);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .feat-title{font-size:13px;font-weight:700;color:var(--ink);margin-bottom:2px;}
    .feat-desc{font-size:12px;color:var(--muted);line-height:1.55;}
    .q-screen{height:100vh;display:flex;flex-direction:column;background:var(--bg);}
    .q-topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0;}
    @media(max-width:480px){.q-topbar{padding:12px 14px;}}
    .q-close{width:36px;height:36px;background:var(--border-l);border-radius:8px;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:background var(--t-fast),transform var(--t-fast);}
    .q-close:hover{background:var(--border);}
    .q-close:active{transform:scale(0.92);}
    .q-counter{font-size:12px;font-weight:700;color:var(--muted);width:38px;text-align:right;flex-shrink:0;}
    .q-body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 20px;overflow-y:auto;}
    @media(max-width:480px){.q-body{padding:18px 16px;}}
    .q-cat-pill{display:inline-flex;padding:4px 12px;background:var(--teal-xl);color:var(--teal-d);border-radius:99px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:20px;border:1px solid var(--teal-l);}
    .q-illus{width:160px;height:160px;margin-bottom:24px;}
    @media(max-width:480px){.q-illus{width:128px;height:128px;margin-bottom:18px;}}
    .q-illus-svg{width:100%;height:100%;}
    .q-text{font-family:var(--display);font-size:22px;font-weight:700;color:var(--ink);text-align:center;line-height:1.35;margin-bottom:32px;max-width:320px;}
    @media(max-width:480px){.q-text{font-size:19px;margin-bottom:24px;}}
    .q-answers{display:flex;flex-direction:column;gap:10px;width:100%;max-width:340px;}
    .ans-btn{display:flex;align-items:center;gap:12px;padding:16px 18px;border-radius:var(--radius);border:2px solid var(--border);background:var(--surface);font-family:var(--font);font-size:15px;font-weight:700;cursor:pointer;transition:border-color var(--t-fast),background var(--t-fast),transform var(--t-fast),box-shadow var(--t-fast);min-height:56px;}
    .ans-btn:hover{box-shadow:var(--shadow-s);}
    .ans-btn:active{transform:scale(0.97);}
    .ans-btn.yes{border-color:#5fc9bb;background:var(--teal-xl);color:var(--teal-dd);}
    .ans-btn.yes:hover{background:var(--teal-l);}
    .ans-btn.no{border-color:var(--border);background:var(--border-l);color:var(--ink-3);}
    .ans-btn.no:hover{background:var(--border);}
    .ans-btn-icon{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .ans-yes-icon{background:var(--teal-l);}
    .ans-no-icon{background:var(--border);}
    .q-anim{animation:qSlide var(--t-slow) var(--ease);}
    @keyframes qSlide{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:none;}}
    .analyzing{height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg);padding:24px;}
    .spin-ring{width:140px;height:140px;margin-bottom:28px;animation:spin-slow 3s linear infinite;}
    @media(max-width:480px){.spin-ring{width:108px;height:108px;}}
    @keyframes spin-slow{to{transform:rotate(360deg);}}
    .loading-dots{display:flex;gap:7px;margin-top:24px;}
    .ldot{width:9px;height:9px;border-radius:99px;background:var(--teal);animation:dot-bounce 1.2s ease-in-out infinite;}
    .ldot:nth-child(2){animation-delay:0.18s;}
    .ldot:nth-child(3){animation-delay:0.36s;}
    .result-ring{width:110px;height:110px;border-radius:99px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;animation:ring-in 0.45s var(--ease-spring);}
    @keyframes ring-in{from{transform:scale(0.6);opacity:0;}to{transform:scale(1);opacity:1;}}
    .result-ring-High{background:linear-gradient(155deg,#fde2e2,#fac6c6);box-shadow:0 0 0 10px rgba(226,61,61,0.09);}
    .result-ring-Medium{background:linear-gradient(155deg,#fde9c4,#fad596);box-shadow:0 0 0 10px rgba(232,147,15,0.09);}
    .result-ring-Low{background:linear-gradient(155deg,#d6f3e1,#aee8c4);box-shadow:0 0 0 10px rgba(31,157,85,0.09);}
    .result-ring-None{background:linear-gradient(155deg,#d6f3e1,#aee8c4);box-shadow:0 0 0 10px rgba(31,157,85,0.09);}
    .rec-bubbles{display:flex;flex-direction:column;gap:10px;}
    .rec-bubble{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-radius:var(--radius);border-left:4px solid transparent;background:var(--surface);box-shadow:var(--shadow-s);animation:bubble-in var(--t-slow) ease both;}
    .rec-bubble:nth-child(1){animation-delay:0.05s;}
    .rec-bubble:nth-child(2){animation-delay:0.12s;}
    .rec-bubble:nth-child(3){animation-delay:0.19s;}
    .rec-bubble:nth-child(4){animation-delay:0.26s;}
    @keyframes bubble-in{from{opacity:0;transform:translateX(-8px);}to{opacity:1;transform:none;}}
    .rec-bubble-icon{width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .rec-bubble-label{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px;}
    .rec-bubble-text{font-size:13px;color:var(--ink-2);line-height:1.5;font-weight:500;}
    .score-bar-row{display:flex;align-items:center;gap:10px;margin-bottom:9px;}
    .score-bar-name{font-size:12px;color:var(--muted);width:150px;flex-shrink:0;}
    @media(max-width:380px){.score-bar-name{width:104px;font-size:11px;}}
    .score-bar-track{flex:1;height:5px;background:var(--border-l);border-radius:99px;overflow:hidden;}
    .score-bar-fill{height:100%;background:linear-gradient(90deg,var(--muted-l),var(--muted));border-radius:99px;transition:width var(--t-slow);}
    .score-bar-pct{font-size:12px;color:var(--muted);width:30px;text-align:right;}
    .disclaimer{display:flex;gap:10px;align-items:flex-start;background:var(--amber-l);border:1px solid #f3cf8f;border-radius:var(--radius-s);padding:12px 14px;}
    .disclaimer p{font-size:12px;color:#7a4a09;line-height:1.55;}
    .search-wrap{position:relative;margin-bottom:12px;}
    .search-icon{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--muted-l);pointer-events:none;}
    .search-input{width:100%;padding:12px 14px 12px 40px;border:1.5px solid var(--border);border-radius:var(--radius-s);font-family:var(--font);font-size:14px;color:var(--ink);background:var(--surface);outline:none;transition:border-color var(--t-fast),box-shadow var(--t-fast);min-height:46px;}
    .search-input:focus{border-color:var(--teal);box-shadow:var(--focus-ring);}
    .chip-row{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px;}
    .chip{padding:7px 14px;border-radius:99px;border:1.5px solid var(--border);font-family:var(--font);font-size:12px;font-weight:700;cursor:pointer;transition:all var(--t-fast);background:var(--surface);color:var(--muted);min-height:36px;}
    .chip:hover{border-color:var(--muted-l);}
    .chip.on{border-color:var(--teal);background:var(--teal-xl);color:var(--teal-d);}
    .empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:56px 24px;gap:10px;text-align:center;}
    .menu-list{display:flex;flex-direction:column;}
    .menu-item{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--border);cursor:pointer;transition:opacity var(--t-fast),padding-left var(--t-fast);min-height:48px;}
    .menu-item:last-child{border-bottom:none;}
    .menu-item:hover{opacity:0.78;padding-left:4px;}
    .menu-ico{width:34px;height:34px;background:var(--border-l);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .toggle-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;gap:12px;}
    .toggle{position:relative;width:44px;height:25px;flex-shrink:0;}
    .toggle input{opacity:0;width:0;height:0;}
    .toggle-slider{position:absolute;inset:0;background:var(--border);border-radius:99px;cursor:pointer;transition:background var(--t-fast);}
    .toggle input:checked+.toggle-slider{background:var(--teal);}
    .toggle input:focus-visible+.toggle-slider{box-shadow:var(--focus-ring);}
    .toggle-slider::before{content:'';position:absolute;height:19px;width:19px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:transform var(--t-fast);box-shadow:var(--shadow-s);}
    .toggle input:checked+.toggle-slider::before{transform:translateX(19px);}
    .icon-btn{transition:background var(--t-fast),transform var(--t-fast);min-width:36px;min-height:36px;align-items:center;justify-content:center;}
    .icon-btn:hover{background:var(--border)!important;}
    .icon-btn:active{transform:scale(0.92);}
    .flex{display:flex;}.items-c{align-items:center;}.justify-b{justify-content:space-between;}
    .gap-2{gap:8px;}.gap-3{gap:12px;}
    .mt-1{margin-top:4px;}.mt-2{margin-top:8px;}.mt-3{margin-top:12px;}.mt-4{margin-top:16px;}
    .mb-2{margin-bottom:8px;}.mb-3{margin-bottom:12px;}.mb-4{margin-bottom:16px;}
    .w-full{width:100%;}.text-c{text-align:center;}.italic{font-style:italic;}
    .notif{position:fixed;top:22px;left:50%;transform:translateX(-50%);background:var(--ink-2);color:#fff;padding:11px 22px;border-radius:var(--radius-s);font-size:13px;font-weight:600;z-index:9999;animation:notif-in var(--t-slow) ease;white-space:nowrap;box-shadow:var(--shadow-l);max-width:90vw;overflow:hidden;text-overflow:ellipsis;}
    @keyframes notif-in{from{opacity:0;transform:translateX(-50%) translateY(-12px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}
    .profile-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;}
    .ps-card{background:var(--surface);border-radius:var(--radius);border:1px solid var(--border);padding:18px 14px;text-align:center;transition:box-shadow var(--t-med),transform var(--t-med);}
    .ps-card:hover{box-shadow:var(--shadow);transform:translateY(-2px);}
    .ps-val{font-size:26px;font-weight:800;line-height:1;margin-bottom:4px;}
    .ps-lbl{font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:0.07em;}
    .edit-panel{background:var(--border-l);border-radius:var(--radius);padding:18px;margin-bottom:14px;border:1px solid var(--border);}
    .edit-panel-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);margin-bottom:14px;}
    .sec-section{margin-bottom:20px;}
    .sec-section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);margin-bottom:10px;}
    .sec-row{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;}
    .sec-row:last-child{border-bottom:none;}
    .sec-row-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .sec-row-body{flex:1;min-width:140px;}
    .sec-row-label{font-size:14px;font-weight:700;color:var(--ink);margin-bottom:2px;}
    .sec-row-hint{font-size:12px;color:var(--muted);word-break:break-word;}
    .sec-field-wrap{background:var(--border-l);border-radius:var(--radius);padding:16px;margin-top:10px;border:1px solid var(--border);}
    .about-hero{background:linear-gradient(150deg,var(--teal) 0%,var(--teal-dd) 100%);border-radius:var(--radius-l);padding:28px 24px;margin-bottom:20px;position:relative;overflow:hidden;box-shadow:0 12px 32px rgba(var(--teal-rgb),0.22);}
    @media(max-width:480px){.about-hero{padding:22px 18px;}}
    .about-hero-bg{position:absolute;top:-30px;right:-30px;opacity:0.08;}
    .about-hero-eyebrow{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.65);margin-bottom:8px;}
    .about-hero-title{font-family:var(--display);font-size:28px;color:#fff;font-weight:700;line-height:1.2;margin-bottom:10px;}
    @media(max-width:480px){.about-hero-title{font-size:24px;}}
    .about-hero-sub{font-size:13px;color:rgba(255,255,255,0.76);line-height:1.6;}
    .about-mission{background:var(--teal-xl);border-radius:var(--radius);border:1px solid var(--teal-l);padding:20px;margin-bottom:16px;}
    .about-mission-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--teal-d);margin-bottom:8px;}
    .about-mission-text{font-size:14px;color:var(--ink-2);line-height:1.65;font-weight:500;}
    .about-fact-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;}
    .about-fact{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;text-align:center;transition:box-shadow var(--t-med);}
    .about-fact:hover{box-shadow:var(--shadow-s);}
    .about-fact-val{font-family:var(--display);font-size:26px;font-weight:700;color:var(--teal-d);line-height:1;margin-bottom:4px;}
    .about-fact-lbl{font-size:11px;color:var(--muted);font-weight:600;}
    .about-feature-row{display:flex;align-items:flex-start;gap:14px;padding:14px 0;border-bottom:1px solid var(--border);}
    .about-feature-row:last-child{border-bottom:none;}
    .about-feature-icon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .about-feature-title{font-size:13px;font-weight:700;color:var(--ink);margin-bottom:3px;}
    .about-feature-desc{font-size:12px;color:var(--muted);line-height:1.55;}
    .about-team-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-bottom:10px;display:flex;align-items:center;gap:14px;transition:box-shadow var(--t-med);}
    .about-team-card:hover{box-shadow:var(--shadow-s);}
    .about-team-avatar{width:46px;height:46px;border-radius:99px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex-shrink:0;}
    .about-team-name{font-size:14px;font-weight:700;color:var(--ink);margin-bottom:2px;}
    .about-team-role{font-size:12px;color:var(--muted);}
    .about-version-strip{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--border);gap:12px;}
    .about-version-strip:last-child{border-bottom:none;}
    .about-version-key{font-size:13px;color:var(--muted);}
    .about-version-val{font-size:13px;font-weight:700;color:var(--ink);text-align:right;}
    .no-symptoms-ring{width:110px;height:110px;border-radius:99px;background:linear-gradient(155deg,#d6f3e1,#aee8c4);box-shadow:0 0 0 10px rgba(31,157,85,0.09);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;animation:ring-in 0.45s var(--ease-spring);}
    .theme-preview-strip{display:flex;gap:6px;margin-top:10px;}
    .theme-preview-swatch{flex:1;height:40px;border-radius:999px;border:1.5px solid var(--border);cursor:pointer;transition:border-color var(--t-fast),transform var(--t-fast),box-shadow var(--t-fast);display:flex;align-items:center;justify-content:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:0.03em;background:var(--surface);padding:0 10px;}
    .theme-preview-swatch:hover{transform:translateY(-1px);box-shadow:var(--shadow-s);}
    .theme-preview-swatch.selected{border-color:var(--teal);box-shadow:0 0 0 2px rgba(var(--teal-rgb),0.15);}
    .theme-preview-swatch.light-sw{background:#f4f7f9;color:#0b1726;}
    .theme-preview-swatch.dark-sw{background:#0f161e;color:#e8eef3;}
    .theme-preview-swatch.system-sw{background:linear-gradient(135deg,#f4f7f9 50%,#0f161e 50%);color:var(--ink);}
    @media(max-width:480px){.theme-preview-strip{gap:5px;}.theme-preview-swatch{height:38px;font-size:10px;padding:0 6px;gap:4px;}}
    @media(max-width:360px){.theme-preview-swatch{height:36px;font-size:0;gap:0;}.theme-preview-swatch svg{margin:0;}}
    .fs-strip{display:flex;gap:6px;margin-top:10px;}
    .fs-btn{flex:1;height:40px;border-radius:999px;border:1.5px solid var(--border);cursor:pointer;transition:border-color var(--t-fast),transform var(--t-fast),box-shadow var(--t-fast);display:flex;align-items:center;justify-content:center;font-weight:700;letter-spacing:0.03em;background:var(--surface);color:var(--muted);padding:0 10px;}
    .fs-btn:hover{transform:translateY(-1px);box-shadow:var(--shadow-s);border-color:var(--muted-l);}
    .fs-btn.selected{border-color:var(--teal);color:var(--teal-d);box-shadow:0 0 0 2px rgba(var(--teal-rgb),0.15);}
    .fs-btn.fs-small{font-size:11px;}
    .fs-btn.fs-medium{font-size:13px;}
    .fs-btn.fs-large{font-size:16px;}
    @media(max-width:359px){.stats-row{grid-template-columns:1fr 1fr 1fr;}.q-answers{max-width:100%;}.hero-card{padding:20px 16px;}}
    @media(min-width:1280px){.page-head,.page-body{max-width:980px;margin-left:auto;margin-right:auto;width:100%;}}

    /* ── Font size scaling ────────────────── */
    html[data-fontsize="small"] body { font-size: 13px; }
    html[data-fontsize="small"] .t-display { font-size: 20px; }
    html[data-fontsize="small"] .t-title { font-size: 15px; }
    html[data-fontsize="small"] .t-subtitle { font-size: 12px; }
    html[data-fontsize="small"] .t-label { font-size: 9px; }
    html[data-fontsize="small"] .btn { font-size: 12px; }
    html[data-fontsize="small"] .tab { font-size: 11px; }
    html[data-fontsize="small"] .field-input { font-size: 13px; }
    html[data-fontsize="small"] .field-label { font-size: 9px; }
    html[data-fontsize="small"] .badge { font-size: 9px; }
    html[data-fontsize="small"] .nav-item { font-size: 12px; }
    html[data-fontsize="small"] .bnav-item { font-size: 9px; }
    html[data-fontsize="small"] .rec-name { font-size: 12px; }
    html[data-fontsize="small"] .rec-meta { font-size: 10px; }
    html[data-fontsize="small"] .stat-val { font-size: 17px; }
    html[data-fontsize="small"] .stat-lbl { font-size: 9px; }
    html[data-fontsize="small"] .feat-title { font-size: 11px; }
    html[data-fontsize="small"] .feat-desc { font-size: 10px; }
    html[data-fontsize="small"] .rec-bubble-text { font-size: 11px; }
    html[data-fontsize="small"] .rec-bubble-label { font-size: 9px; }
    html[data-fontsize="small"] .chip { font-size: 10px; }
    html[data-fontsize="small"] .search-input { font-size: 12px; }
    html[data-fontsize="small"] .section-ttl { font-size: 9px; }
    html[data-fontsize="small"] .score-bar-name { font-size: 10px; }
    html[data-fontsize="small"] .score-bar-pct { font-size: 10px; }
    html[data-fontsize="small"] .ans-btn { font-size: 13px; }
    html[data-fontsize="small"] .q-text { font-size: 18px; }

    html[data-fontsize="large"] body { font-size: 17px; }
    html[data-fontsize="large"] .t-display { font-size: 30px; }
    html[data-fontsize="large"] .t-title { font-size: 21px; }
    html[data-fontsize="large"] .t-subtitle { font-size: 16px; }
    html[data-fontsize="large"] .t-label { font-size: 13px; }
    html[data-fontsize="large"] .btn { font-size: 16px; }
    html[data-fontsize="large"] .tab { font-size: 15px; }
    html[data-fontsize="large"] .field-input { font-size: 17px; }
    html[data-fontsize="large"] .field-label { font-size: 13px; }
    html[data-fontsize="large"] .badge { font-size: 13px; }
    html[data-fontsize="large"] .nav-item { font-size: 16px; }
    html[data-fontsize="large"] .bnav-item { font-size: 12px; }
    html[data-fontsize="large"] .rec-name { font-size: 16px; }
    html[data-fontsize="large"] .rec-meta { font-size: 14px; }
    html[data-fontsize="large"] .stat-val { font-size: 24px; }
    html[data-fontsize="large"] .stat-lbl { font-size: 12px; }
    html[data-fontsize="large"] .feat-title { font-size: 15px; }
    html[data-fontsize="large"] .feat-desc { font-size: 14px; }
    html[data-fontsize="large"] .rec-bubble-text { font-size: 15px; }
    html[data-fontsize="large"] .rec-bubble-label { font-size: 12px; }
    html[data-fontsize="large"] .chip { font-size: 14px; }
    html[data-fontsize="large"] .search-input { font-size: 16px; }
    html[data-fontsize="large"] .section-ttl { font-size: 13px; }
    html[data-fontsize="large"] .score-bar-name { font-size: 14px; }
    html[data-fontsize="large"] .score-bar-pct { font-size: 14px; }
    html[data-fontsize="large"] .ans-btn { font-size: 17px; }
    html[data-fontsize="large"] .q-text { font-size: 25px; }
  `;
  document.head.appendChild(el);
};

// ─────────────────────────────────────────────
// SVG COMPONENTS
// ─────────────────────────────────────────────
function MedicalHeartMark({ size = 22, color = "#fff" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 21C12 21 3 14.5 3 8.5C3 5.42 5.42 3 8.5 3C10.24 3 11.91 3.81 13 5.08C14.09 3.81 15.76 3 17.5 3C20.58 3 23 5.42 23 8.5C23 14.5 12 21 12 21Z" fill={color} opacity="0.92"/>
      <polyline points="6,12 8.5,12 9.5,9 10.5,15 11.5,10.5 12.5,13 13.2,12 15.5,12 17.5,12" stroke="#0c8a7e" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

function MedicalHeartLarge({ size = 32, color = "#fff" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M16 28C16 28 4 19.5 4 11.5C4 7.36 7.36 4 11.5 4C13.72 4 15.78 5.01 17.2 6.66C18.62 5.01 20.68 4 22.9 4C27.04 4 30.4 7.36 30.4 11.5C30.4 19.5 16 28 16 28Z" fill={color} opacity="0.9"/>
      <polyline points="8,16 11,16 12.5,12 14,20 15.5,14 16.5,17 17.5,16 20,16 23,16" stroke="#0c8a7e" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

function MedicalHeartSplash() {
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
      <path d="M22 38C22 38 6 27 6 16C6 10.48 10.48 6 16 6C18.9 6 21.56 7.38 23.2 9.6C24.84 7.38 27.5 6 30.4 6C35.92 6 40 10.48 40 16C40 27 22 38 22 38Z" fill="white" opacity="0.9"/>
      <polyline points="10,22 15,22 17,16 19,28 21,19 23,24 25,22 29,22 34,22" stroke="#0c8a7e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

function HealthProfessionalIllus({ width = 120, height = 140 }) {
  return (
    <svg width={width} height={height} viewBox="0 0 120 140" fill="none">
      <circle cx="60" cy="70" r="58" fill="#e0f2f1"/>
      <rect x="30" y="72" width="60" height="60" rx="18" fill="#ffffff"/>
      <path d="M60 72 L45 80 L45 110 L60 104 L75 110 L75 80 Z" fill="#eefcfa" stroke="#b2dfdb" strokeWidth="1"/>
      <path d="M48 82 Q44 90 44 98 Q44 106 52 106 Q60 106 60 98" stroke="#0c8a7e" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
      <circle cx="60" cy="99" r="5" fill="#0c8a7e"/>
      <circle cx="60" cy="99" r="2.5" fill="#bdf0ea"/>
      <line x1="48" y1="82" x2="42" y2="76" stroke="#0c8a7e" strokeWidth="2" strokeLinecap="round"/>
      <circle cx="42" cy="75" r="2" fill="#0c8a7e"/>
      <rect x="64" y="84" width="18" height="12" rx="3" fill="#e0f2f1" stroke="#b2dfdb" strokeWidth="1"/>
      <rect x="66" y="86" width="10" height="2" rx="1" fill="#0c8a7e" opacity="0.6"/>
      <rect x="53" y="58" width="14" height="18" rx="5" fill="#f5cba7"/>
      <ellipse cx="60" cy="46" rx="22" ry="24" fill="#f5cba7"/>
      <path d="M38 42 Q38 22 60 22 Q82 22 82 42 Q82 34 60 32 Q38 34 38 42 Z" fill="#4a3728"/>
      <ellipse cx="52" cy="46" rx="3.5" ry="4" fill="#fff"/>
      <ellipse cx="68" cy="46" rx="3.5" ry="4" fill="#fff"/>
      <circle cx="53" cy="47" r="2" fill="#3d2b1f"/>
      <circle cx="69" cy="47" r="2" fill="#3d2b1f"/>
      <path d="M53 60 Q60 65 67 60" stroke="#c9785c" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
      <ellipse cx="38" cy="48" rx="4" ry="6" fill="#f5cba7"/>
      <ellipse cx="82" cy="48" rx="4" ry="6" fill="#f5cba7"/>
      <rect x="18" y="75" width="14" height="40" rx="7" fill="#ffffff" stroke="#dde4ea" strokeWidth="1"/>
      <rect x="88" y="75" width="14" height="40" rx="7" fill="#ffffff" stroke="#dde4ea" strokeWidth="1"/>
      <ellipse cx="25" cy="118" rx="7" ry="6" fill="#f5cba7"/>
      <ellipse cx="95" cy="118" rx="7" ry="6" fill="#f5cba7"/>
      <rect x="56" y="88" width="8" height="2.5" rx="1.25" fill="#0c8a7e" opacity="0.8"/>
      <rect x="58.75" y="85.25" width="2.5" height="8" rx="1.25" fill="#0c8a7e" opacity="0.8"/>
    </svg>
  );
}

const IllusGeneral = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#fdecec"/>
    <rect x="91" y="38" width="18" height="82" rx="9" fill="#cbd5e1"/>
    <rect x="93" y="78" width="14" height="38" rx="7" fill="#e23d3d"/>
    <circle cx="100" cy="128" r="17" fill="#e23d3d"/>
    <circle cx="141" cy="68" r="20" fill="#fbbf24" opacity="0.25"/>
    <circle cx="141" cy="68" r="13" fill="#fbbf24" opacity="0.55"/>
    <circle cx="141" cy="68" r="8" fill="#e8930f"/>
  </svg>
);

const IllusRespiratory = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#eaf1ff"/>
    <line x1="100" y1="58" x2="100" y2="108" stroke="#90a0ae" strokeWidth="5" strokeLinecap="round"/>
    <path d="M100 88 Q76 88 66 108 Q56 130 70 146 Q84 160 90 150 Q93 140 100 134" stroke="#2f6fed" strokeWidth="7" fill="none" strokeLinecap="round"/>
    <path d="M100 88 Q124 88 134 108 Q144 130 130 146 Q116 160 110 150 Q107 140 100 134" stroke="#2f6fed" strokeWidth="7" fill="none" strokeLinecap="round"/>
    <ellipse cx="72" cy="146" rx="15" ry="13" fill="#60a5fa"/>
    <ellipse cx="128" cy="146" rx="15" ry="13" fill="#60a5fa"/>
  </svg>
);

const IllusDigestive = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#e9f9ee"/>
    <path d="M85 58 Q65 70 70 92 Q75 112 92 117 Q96 152 100 162 Q104 152 108 117 Q125 112 130 92 Q135 70 115 58 Q108 53 100 52 Q92 53 85 58Z" fill="#4ade80" opacity="0.55"/>
    <circle cx="80" cy="100" r="7" fill="#4ade80"/>
    <circle cx="120" cy="100" r="7" fill="#4ade80"/>
  </svg>
);

const IllusLiver = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#fef3e0"/>
    <path d="M55 80 Q50 112 65 136 Q80 159 112 156 Q147 151 151 121 Q155 91 136 76 Q116 60 90 65 Q64 68 55 80Z" fill="#fbbf24" opacity="0.35"/>
    <path d="M55 80 Q50 112 65 136 Q80 159 112 156 Q147 151 151 121 Q155 91 136 76 Q116 60 90 65 Q64 68 55 80Z" stroke="#e8930f" strokeWidth="2.5" fill="none"/>
  </svg>
);

const IllusSkin = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#fef9f0"/>
    <ellipse cx="100" cy="112" rx="54" ry="63" fill="#fde8d8"/>
    <circle cx="79" cy="89" r="6" fill="#f87171" opacity="0.68"/>
    <circle cx="116" cy="83" r="5" fill="#f87171" opacity="0.68"/>
    <circle cx="119" cy="117" r="7" fill="#f87171" opacity="0.68"/>
  </svg>
);

const IllusUrinary = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#eaf1ff"/>
    <path d="M80 68 Q60 80 62 106 Q64 132 80 142 L80 162 L120 162 L120 142 Q136 132 138 106 Q140 80 120 68 Z" fill="#93c5fd" opacity="0.7"/>
    <ellipse cx="100" cy="151" rx="20" ry="10" fill="#60a5fa" opacity="0.4"/>
  </svg>
);

const IllusEyes = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#eaf1ff"/>
    <path d="M30 100 Q100 50 170 100 Q100 150 30 100Z" fill="#bfdbfe" stroke="#2f6fed" strokeWidth="2"/>
    <circle cx="100" cy="100" r="24" fill="#1d4ed8"/>
    <circle cx="100" cy="100" r="14" fill="#0b1726"/>
    <circle cx="108" cy="94" r="5" fill="#fff" opacity="0.8"/>
  </svg>
);

const IllusAnalysis = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#eefcfa"/>
    <circle cx="100" cy="100" r="52" stroke="#99f6e4" strokeWidth="2.5" fill="none" strokeDasharray="8 4"/>
    <circle cx="100" cy="100" r="36" stroke="#2dd4bf" strokeWidth="2.5" fill="none" strokeDasharray="5 3"/>
    <circle cx="100" cy="100" r="20" fill="#0c8a7e"/>
    <path d="M92 100 L98 106 L110 93" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="100" cy="48" r="7" fill="#0c8a7e"/>
    <circle cx="100" cy="152" r="7" fill="#0c8a7e"/>
    <circle cx="48" cy="100" r="7" fill="#0c8a7e"/>
    <circle cx="152" cy="100" r="7" fill="#0c8a7e"/>
  </svg>
);

const IllusDoctor = () => (
  <svg viewBox="0 0 200 200" fill="none" className="q-illus-svg">
    <circle cx="100" cy="100" r="90" fill="#eefcfa"/>
    <ellipse cx="100" cy="158" rx="42" ry="28" fill="#0c8a7e"/>
    <circle cx="100" cy="72" r="28" fill="#fde8d8"/>
    <rect x="72" y="96" width="56" height="62" rx="20" fill="#0c8a7e"/>
    <circle cx="88" cy="68" r="4" fill="#5b3a29"/>
    <circle cx="112" cy="68" r="4" fill="#5b3a29"/>
    <path d="M90 83 Q100 91 110 83" stroke="#5b3a29" strokeWidth="2" fill="none" strokeLinecap="round"/>
    <rect x="91" y="116" width="18" height="4" rx="2" fill="#fff"/>
    <rect x="98" y="109" width="4" height="18" rx="2" fill="#fff"/>
    <ellipse cx="100" cy="44" rx="30" ry="20" fill="#1a2a3c"/>
  </svg>
);

const CATEGORY_ILLUS = {
  General: IllusGeneral, Respiratory: IllusRespiratory, Digestive: IllusDigestive,
  Liver: IllusLiver, Skin: IllusSkin, Eyes: IllusEyes, Urinary: IllusUrinary,
  Rectal: IllusDigestive, Neurological: IllusGeneral, Metabolic: IllusGeneral,
  Infection: IllusDoctor, History: IllusDoctor,
};

function QuestionIllus({ question }) {
  try {
    const imgPath = question ? SYMPTOM_IMAGES[question.id] : null;
    const catPath = question ? getCategoryImage(question.category) : null;
    const src = imgPath || catPath;
    if (src) {
      return (
        <div className="q-illus">
          <img src={src} alt={question?.category || "symptom"}
            style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: 16 }}
          />
        </div>
      );
    }
  } catch (_) { /* symptomImages.js not available, fall through to SVG */ }
  const Comp = question ? (CATEGORY_ILLUS[question.category] || IllusDoctor) : IllusDoctor;
  return <div className="q-illus"><Comp /></div>;
}

// ─────────────────────────────────────────────
// ICONS
// ─────────────────────────────────────────────
function Icon({ name, size = 18, color = "currentColor", className = "" }) {
  const s = { width: size, height: size, flexShrink: 0 };
  const p = { viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: "2",
              strokeLinecap: "round", strokeLinejoin: "round", style: s, className };
  switch (name) {
    case "home":      return <svg {...p}><path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/><path d="M9 21V12h6v9"/></svg>;
    case "activity":  return <svg {...p}><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>;
    case "clipboard": return <svg {...p}><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><path d="M12 11h4M12 16h4M8 11h.01M8 16h.01"/></svg>;
    case "user":      return <svg {...p}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>;
    case "settings":  return <svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>;
    case "heart":     return <svg {...p}><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>;
    case "alert":     return <svg {...p}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
    case "info":      return <svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>;
    case "check":     return <svg {...p}><polyline points="20 6 9 17 4 12"/></svg>;
    case "x":         return <svg {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
    case "logout":    return <svg {...p}><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>;
    case "chevR":     return <svg {...p}><polyline points="9 18 15 12 9 6"/></svg>;
    case "chevL":     return <svg {...p}><polyline points="15 18 9 12 15 6"/></svg>;
    case "edit":      return <svg {...p}><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
    case "trash":     return <svg {...p}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>;
    case "search":    return <svg {...p}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
    case "shield":    return <svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case "database":  return <svg {...p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>;
    case "eye":       return <svg {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
    case "eyeOff":    return <svg {...p}><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>;
    case "mail":      return <svg {...p}><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/></svg>;
    case "lock":      return <svg {...p}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>;
    case "calendar":  return <svg {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
    case "sun":       return <svg {...p}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>;
    case "moon":      return <svg {...p}><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>;
    case "monitor":   return <svg {...p}><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>;
    case "refresh":   return <svg {...p}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>;
    case "download":  return <svg {...p}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>;
    case "map":       return <svg {...p}><path d="M9 20l-6-3V4l6 3 6-3 6 3v13l-6-3-6 3z"/><line x1="9" y1="7" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="17"/></svg>;
    default:          return <svg {...p}><circle cx="12" cy="12" r="4"/></svg>;
  }
}

// ─────────────────────────────────────────────
// TOAST NOTIFICATION
// ─────────────────────────────────────────────
let _notifTimer;
function Notif({ msg }) {
  if (!msg) return null;
  return <div className="notif">{msg}</div>;
}

// ─────────────────────────────────────────────
// RECOMMENDATION BUBBLE
// ─────────────────────────────────────────────
function RecBubble({ icon, label, text, accent }) {
  if (!text) return null;
  return (
    <div className="rec-bubble" style={{ borderLeftColor: accent }}>
      <div className="rec-bubble-icon" style={{ background: `${accent}18` }}>
        <Icon name={icon} size={16} color={accent} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
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
  const [assActive,  setAssActive]  = useState(false);
  const [answers,    setAnswers]    = useState({});
  const [asked,      setAsked]      = useState([]);
  const [currentQ,   setCurrentQ]   = useState(null);
  const [qIdx,       setQIdx]       = useState(0);
  const [sessionId,  setSessionId]  = useState(null);
  const [analyzing,  setAnalyzing]  = useState(false);
  const [result,     setResult]     = useState(null);
  const [trajectory, setTrajectory] = useState([]);
  // Set only when a health worker starts an assessment from a patient's
  // profile (see HomeScreen's worker view). Null for every self-screening
  // flow, which is what keeps that flow byte-for-byte unchanged.
  const [assessmentPatient, setAssessmentPatient] = useState(null);
  // App-level mirror of the logged-in account's role, used only to route
  // the "Check" and "Records" bottom-nav tabs to WorkerCheck/WorkerRecords
  // for a health worker instead of the individual self-screening/records
  // screens. HomeScreen keeps its own separate /user/profile fetch for the
  // Home tab -- this is intentionally not shared with it. Stays null
  // (falling through to today's patient-facing behavior everywhere) until
  // the fetch resolves, and on any fetch failure.
  const [role, setRole] = useState(null);

  // ── Theme ──────────────────────────────────
  const [theme, setTheme] = useState(() => {
    const saved = Store.get("tc_settings");
    return saved?.theme || "light";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      root.setAttribute("data-theme", mq.matches ? "dark" : "light");
      const handler = (e) => root.setAttribute("data-theme", e.matches ? "dark" : "light");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    root.setAttribute("data-theme", theme);
  }, [theme]);

  const handleThemeChange = useCallback((t) => setTheme(t), []);

  // ── Font size ──────────────────────────────
  const [fontSize, setFontSize] = useState(() => {
    const saved = Store.get("tc_settings");
    return saved?.fontSize || "medium";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (fontSize === "medium") {
      root.removeAttribute("data-fontsize");
    } else {
      root.setAttribute("data-fontsize", fontSize);
    }
  }, [fontSize]);

  const handleFontSizeChange = useCallback((fs) => setFontSize(fs), []);

  const MAX_Q = 15;

  const toast = useCallback((msg) => {
    setNotif(msg);
    clearTimeout(_notifTimer);
    _notifTimer = setTimeout(() => setNotif(""), 3000);
  }, []);

  // ── Restore session ──────────────────────
  useEffect(() => {
    const t1 = setTimeout(() => setSplashFade(true), 1900);
    const t2 = setTimeout(() => {
      setSplash(false);
      const saved = Store.get(USER_KEY);
      const token = localStorage.getItem(TOKEN_KEY);
      if (saved && token && saved.token === token) {
        _loggingOut = false;
        setUser(saved);
      } else {
        Store.remove(USER_KEY);
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
      }
    }, 2300);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const login = (u) => {
    _loggingOut = false;
    api.setToken(u.token);
    Store.set(USER_KEY, u);
    setUser(u);
    setPage("home");
  };

  const logout = useCallback(() => {
    _loggingOut = true;
    api.setToken(null);
    Store.remove(USER_KEY);
    setAssActive(false);
    setResult(null);
    setAnalyzing(false);
    setAnswers({});
    setAsked([]);
    setCurrentQ(null);
    setQIdx(0);
    setSessionId(null);
    setTrajectory([]);
    setDetailRec(null);
    setAssessmentPatient(null);
    setPage("home");
    setUser(null);
    setNotif("");
    setTimeout(() => toast("Signed out successfully."), 50);
  }, [toast]);

  useEffect(() => {
    api.onUnauthorized = () => {
      if (_loggingOut || !user) return;
      logout();
      toast("Your session has expired. Please sign in again.");
    };
    return () => { api.onUnauthorized = null; };
  }, [logout, toast, user]);

  // App-level role fetch, used only to route the "Check" and "Records"
  // bottom-nav tabs (see renderPage() below). Resilient by design: any
  // failure just leaves role as null, which falls through to today's
  // unchanged patient-facing behavior for both tabs.
  useEffect(() => {
    if (!user) { setRole(null); return; }
    let cancelled = false;
    api.get("/user/profile")
      .then((data) => { if (!cancelled && !_loggingOut) setRole(data?.role || null); })
      .catch(() => { if (!cancelled) setRole(null); });
    return () => { cancelled = true; };
  }, [user?.id]);

  // ── Assessment flow ────────────────────────
  const startAssessment = async (patient = null) => {
    setAnswers({});
    setAsked([]);
    setQIdx(0);
    setResult(null);
    setAnalyzing(false);
    setSessionId(null);
    setTrajectory([]);
    setAssessmentPatient(patient);

    let firstQ = ALL_QUESTIONS[0];
    let sid    = null;

    try {
      const data = await api.post("/symptoms/start", patient?.id ? { patient_id: patient.id } : {});
      if (_loggingOut) return;
      sid    = data.session_id;
      firstQ = data.first_question || ALL_QUESTIONS[0];
      setSessionId(sid);
    } catch (e) {
      if (_loggingOut) return;
      // Backend unreachable — continue in offline mode without blocking the user
      toast("Running in offline mode. Your result will not be saved to history.");
    }

    if (_loggingOut) return;
    setCurrentQ(firstQ);
    setAssActive(true);
    setPage("assessment");
  };

  const handleAnswer = async (val) => {
    const newAnswers = { ...answers, [currentQ.id]: val };
    const newAsked   = [...asked, currentQ.id];
    setAnswers(newAnswers);
    setAsked(newAsked);

    // Build a local trajectory snapshot for every answer (PDF report fallback)
    const snapshotScores = computeOfflineSnapshot(newAnswers, newAsked);
    const top6 = Object.fromEntries(
      Object.entries(snapshotScores).sort((a, b) => b[1] - a[1]).slice(0, 6)
    );
    setTrajectory((prev) => [
      ...prev,
      { step: prev.length + 1, symptom: currentQ.id, answer: val, scores: top6 },
    ]);

    if (newAsked.length >= MAX_Q) { finishAssessment(newAnswers, newAsked); return; }

    let next = null;
    if (sessionId) {
      try {
        const res = await api.post(`/symptoms/next?session_id=${sessionId}`, {
          question_id: currentQ.id, answer: val,
        });
        if (_loggingOut) return;
        if (res.completed) { finishAssessment(newAnswers, newAsked); return; }
        next = res.next_question;
      } catch {
        next = getNextQuestionOffline(newAnswers, newAsked);
      }
    } else {
      next = getNextQuestionOffline(newAnswers, newAsked);
    }

    if (_loggingOut) return;
    if (!next) { finishAssessment(newAnswers, newAsked); return; }
    setCurrentQ(next);
    setQIdx(qIdx + 1);
  };

  const finishAssessment = async (finalAnswers, finalAsked = asked) => {
    setAssActive(false);
    setAnalyzing(true);
    await new Promise((r) => setTimeout(r, 2400));
    if (_loggingOut) return;

    let pred = null;
    let savedToHistory = false;

    if (sessionId) {
      try {
        pred = await api.post(`/diagnosis/analyze?session_id=${sessionId}`, assessmentPatient?.id ? { patient_id: assessmentPatient.id } : {});
        if (_loggingOut) return;
        savedToHistory = true;
      } catch (e) {
        if (_loggingOut) return;
        toast("Could not save to your history. Showing offline result.");
      }
    }

    if (!pred) pred = predictOffline(finalAnswers, finalAsked);
    if (_loggingOut) return;

    // Backend trajectory takes priority over local snapshot
    const finalTrajectory =
      pred.confidence_trajectory && pred.confidence_trajectory.length > 0
        ? pred.confidence_trajectory
        : trajectory;

    setResult({ ...pred, confidence_trajectory: finalTrajectory, saved: savedToHistory });
    setAnalyzing(false);
    setPage("result");
  };

  const resetAssessment = () => {
    setAssActive(false);
    setResult(null);
    setAnalyzing(false);
    setAnswers({});
    setAsked([]);
    setCurrentQ(null);
    setQIdx(0);
    setSessionId(null);
    setTrajectory([]);
    setAssessmentPatient(null);
    setPage("home");
  };

  // ── Splash ─────────────────────────────────
  if (splash) {
    return (
      <div className={`splash${splashFade ? " fading" : ""}`}>
        <div className="splash-logo"><MedicalHeartSplash /></div>
        <div className="splash-title">TropiCare</div>
        <div className="splash-sub">Guided Clinical Assessment</div>
        <div className="splash-dots">
          <div className="splash-dot" /><div className="splash-dot" /><div className="splash-dot" />
        </div>
      </div>
    );
  }

  if (!user)     return <AuthScreen onLogin={login} toast={toast} />;
  if (analyzing) return <AnalyzingScreen />;
  if (page === "result" && result)
    return (
      <ResultScreen
        result={result}
        user={user}
        assessmentPatient={assessmentPatient}
        onReset={resetAssessment}
        onNewCheck={() => startAssessment(assessmentPatient)}
        toast={toast}
      />
    );
  if (assActive && currentQ)
    return <QuestionScreen question={currentQ} qIdx={qIdx} total={MAX_Q} onAnswer={handleAnswer} onQuit={resetAssessment} />;

  const navItems = [
    { id: "home",       label: "Home",    icon: "home"      },
    { id: "assessment", label: "Check",   icon: "activity"  },
    { id: "records",    label: "Records", icon: "clipboard" },
    { id: "profile",    label: "Profile", icon: "user"      },
  ];

  const renderPage = () => {
    switch (page) {
      case "home":
        return <HomeScreen userId={user.id} user={user} onStart={startAssessment} onNav={setPage} toast={toast} />;
      case "assessment":
        return role === "worker"
          ? <WorkerCheck user={user} onStart={startAssessment} toast={toast} />
          : <AssessmentLanding onStart={startAssessment} />;
      case "records":
        return role === "worker"
          ? <WorkerRecords user={user} onStart={startAssessment} onNav={setPage} toast={toast} />
          : <RecordsScreen toast={toast} onDetail={setDetailRec} detail={detailRec} onClearDetail={() => setDetailRec(null)} />;
      case "profile":
        return <ProfileScreen user={user} onLogout={logout} onNav={setPage} toast={toast} />;
      case "settings":
        return (
          <SettingsScreen
            onBack={() => setPage("profile")}
            toast={toast}
            onThemeChange={handleThemeChange}
            currentTheme={theme}
            onFontSizeChange={handleFontSizeChange}
            currentFontSize={fontSize}
          />
        );
      case "privacy":
        return <PrivacySecurityScreen onBack={() => setPage("profile")} toast={toast} user={user} onLogout={logout} />;
      case "about":
        return <AboutScreen onBack={() => setPage("profile")} />;
      case "mydata":
        return <MyDataScreen onBack={() => setPage("profile")} toast={toast} />;
      default:
        return <HomeScreen userId={user.id} user={user} onStart={startAssessment} onNav={setPage} />;
    }
  };

  return (
    <div className="shell">
      <Notif msg={notif} />

      {/* Sidebar — desktop */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark"><MedicalHeartMark size={20} color="#fff" /></div>
          <div>
            <div className="brand-name">TropiCare</div>
            <div className="brand-sub">Symptom Checker</div>
          </div>
        </div>
        <nav className="sidebar-nav">
          {[...navItems, { id: "settings", label: "Settings", icon: "settings" }].map((n) => (
            <button key={n.id}
              className={`nav-item${page === n.id ? " active" : ""}`}
              onClick={() => setPage(n.id)}>
              <Icon name={n.icon} size={17} />
              {n.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot" style={{ marginTop: "auto" }}>
          <button className="nav-item" style={{ color: "var(--red)", width: "100%" }} onClick={logout}>
            <Icon name="logout" size={16} color="var(--red)" />
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
          <button key={n.id}
            className={`bnav-item${page === n.id ? " active" : ""}`}
            onClick={() => {
              setPage(n.id);
              if (n.id !== "assessment") setAssActive(false);
            }}>
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
  const [mode,         setMode]         = useState("login");
  const [name,         setName]         = useState("");
  const [email,        setEmail]        = useState("");
  const [pw,           setPw]           = useState("");
  const [age,          setAge]          = useState("");
  const [gender,       setGender]       = useState("");
  const [role,         setRole]         = useState("patient");
  const [showPw,       setShowPw]       = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [socialLoading, setSocialLoading] = useState(null); // "google" | "facebook" | "apple" | null

  const switchMode = (m) => {
    setMode(m);
    setName(""); setEmail(""); setPw(""); setAge(""); setGender(""); setRole("patient");
  };

  const submit = async () => {
    if (!email.trim() || !pw.trim()) { toast("Please fill in all required fields."); return; }
    if (mode === "register" && !name.trim()) { toast("Please enter your full name."); return; }
    if (pw.length < 8 && mode === "register") { toast("Password must be at least 8 characters."); return; }
    setLoading(true);
    try {
      let data;
      if (mode === "register") {
        data = await api.post("/auth/register", {
          email: email.trim(), password: pw, name: name.trim(), age, gender, role,
        });
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

  const handleForgotPassword = () => {
    toast("Password reset isn't available yet. Please contact support.");
  };

  // Facebook's SDK needs a <div id="fb-root"> in the DOM before FB.init()
  // runs. Google's and Facebook's SDKs are preloaded here, as soon as the
  // auth screen mounts, so that clicking a button later can open its
  // sign-in popup immediately — with no network wait in between — which
  // is what keeps browsers from treating the popup as unsolicited.
  useEffect(() => {
    if (!document.getElementById("fb-root")) {
      const root = document.createElement("div");
      root.id = "fb-root";
      document.body.appendChild(root);
    }
    preloadSocialSdks();
  }, []);

  const finishOAuthLogin = async (path, body) => {
    const data = await api.post(path, body);
    onLogin({ ...data.user, token: data.access_token });
  };

  const handleGoogleLogin = async () => {
    if (!GOOGLE_ENABLED) {
      toast("Google sign-in hasn't been configured yet. Add a Google Client ID to enable it.");
      return;
    }
    setSocialLoading("google");
    try {
      await loadScript("https://accounts.google.com/gsi/client");
      const google = window.google;
      if (!google?.accounts?.oauth2) throw new Error("Google sign-in failed to load. Please try again.");

      const accessToken = await new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: "openid email profile",
          callback: (resp) => {
            if (resp.error) reject(new Error(resp.error_description || resp.error));
            else resolve(resp.access_token);
          },
          error_callback: (err) => reject(new Error(err?.message || "Google sign-in was cancelled.")),
        });
        client.requestAccessToken();
      });

      await finishOAuthLogin("/auth/google", { access_token: accessToken });
    } catch (e) {
      toast(e.message || "Google sign-in failed. Please try again.");
    } finally {
      setSocialLoading(null);
    }
  };

  const handleFacebookLogin = async () => {
    if (!FACEBOOK_ENABLED) {
      toast("Facebook sign-in hasn't been configured yet. Add a Facebook App ID to enable it.");
      return;
    }
    setSocialLoading("facebook");
    try {
      await loadScript("https://connect.facebook.net/en_US/sdk.js");
      const FB = window.FB;
      if (!FB) throw new Error("Facebook sign-in failed to load. Please try again.");
      if (!FB._tcInitialized) {
        FB.init({ appId: FACEBOOK_APP_ID, cookie: true, xfbml: false, version: "v23.0" });
        FB._tcInitialized = true;
      }

      const accessToken = await new Promise((resolve, reject) => {
        FB.login((resp) => {
          if (resp.authResponse) resolve(resp.authResponse.accessToken);
          else reject(new Error("Facebook sign-in was cancelled."));
        }, { scope: "email", auth_type: "rerequest" });
      });

      await finishOAuthLogin("/auth/facebook", { access_token: accessToken });
    } catch (e) {
      toast(e.message || "Facebook sign-in failed. Please try again.");
    } finally {
      setSocialLoading(null);
    }
  };

  const handleAppleLogin = async () => {
    // Apple Sign In requires a paid Apple Developer Program membership.
    // Until APPLE_CLIENT_ID is set, the button below is shown disabled
    // with a "Coming soon" badge, so this branch is a safety net only.
    if (!APPLE_ENABLED) {
      toast("Apple sign-in is coming soon.");
      return;
    }
    setSocialLoading("apple");
    try {
      await loadScript("https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js");
      const AppleID = window.AppleID;
      if (!AppleID) throw new Error("Apple sign-in failed to load. Please try again.");

      AppleID.auth.init({
        clientId:    APPLE_CLIENT_ID,
        scope:       "name email",
        redirectURI: APPLE_REDIRECT_URI,
        usePopup:    true,
      });

      const result = await AppleID.auth.signIn();
      const idToken  = result?.authorization?.id_token;
      if (!idToken) throw new Error("Apple sign-in did not return a valid token.");
      // Apple only sends the user's name on the very first authorization,
      // in a separate `user` object — never inside the id_token itself.
      const fullName = result?.user?.name
        ? `${result.user.name.firstName || ""} ${result.user.name.lastName || ""}`.trim()
        : "";

      await finishOAuthLogin("/auth/apple", { id_token: idToken, name: fullName });
    } catch (e) {
      const msg = e?.error === "popup_closed_by_user" ? "Apple sign-in was cancelled." : (e.message || "Apple sign-in failed. Please try again.");
      toast(msg);
    } finally {
      setSocialLoading(null);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-blob-a" />
      <div className="auth-blob-b" />
      <div className="auth-box">
        <div className="auth-logo">
          <div className="auth-icon"><MedicalHeartLarge size={34} color="#fff" /></div>
          <div className="auth-title">TropiCare</div>
          <div className="auth-hint">Guided symptom assessment for tropical diseases</div>
        </div>
        <div className="card auth-card" style={{ boxShadow: "0 20px 60px rgba(11,23,38,0.14)" }}>
          <div className="tabs">
            {["login", "register"].map((m) => (
              <button key={m} className={`tab${mode === m ? " active" : ""}`} onClick={() => switchMode(m)}>
                {m === "login" ? "Sign In" : "Create Account"}
              </button>
            ))}
          </div>
          {mode === "register" && (
            <div className="field">
              <label className="field-label">Full Name</label>
              <input className="field-input" placeholder="e.g. Kofi Mensah" value={name}
                onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          {mode === "register" && (
            <div className="field">
              <label className="field-label">I'm using this for</label>
              <div className="tabs">
                <button
                  type="button"
                  className={`tab${role === "patient" ? " active" : ""}`}
                  onClick={() => setRole("patient")}
                >
                  Myself
                </button>
                <button
                  type="button"
                  className={`tab${role === "worker" ? " active" : ""}`}
                  onClick={() => setRole("worker")}
                >
                  I'm a health worker
                </button>
              </div>
            </div>
          )}
          <div className="field">
            <label className="field-label">Email Address</label>
            <div className="field-icon-wrap">
              <span className="auth-input-icon"><Icon name="mail" size={16} /></span>
              <input className="field-input has-icon" type="email" placeholder="you@email.com" value={email}
                onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          {mode === "register" && (
            <div className="grid-2">
              <div className="field">
                <label className="field-label">Age</label>
                <input className="field-input" type="number" placeholder="25" value={age}
                  onChange={(e) => setAge(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">Gender</label>
                <select className="field-input field-select" value={gender}
                  onChange={(e) => setGender(e.target.value)}>
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
            <div className="pw-wrap field-icon-wrap">
              <span className="auth-input-icon"><Icon name="lock" size={16} /></span>
              <input className="field-input has-icon" type={showPw ? "text" : "password"}
                placeholder={mode === "register" ? "Min. 8 characters" : "Enter password"}
                value={pw} onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                style={{ paddingRight: 46 }} />
              <button className="pw-toggle" type="button" onClick={() => setShowPw(!showPw)}>
                <Icon name={showPw ? "eyeOff" : "eye"} size={17} />
              </button>
            </div>
          </div>
          {mode === "login" && (
            <div className="auth-row">
              <button className="auth-forgot" type="button" onClick={handleForgotPassword}>
                Forgot password?
              </button>
            </div>
          )}
          <button className="btn btn-primary btn-full btn-lg mt-2" onClick={submit} disabled={loading}>
            {loading ? "Please wait..." : mode === "login" ? "Sign In" : "Create Account"}
          </button>
          <div className="auth-divider"><span>Or continue with</span></div>
          <div className="social-row">
            <button className="social-btn" type="button" aria-label="Continue with Google"
              onClick={handleGoogleLogin} disabled={socialLoading !== null}>
              {socialLoading === "google" ? <span className="social-spinner" /> : <GoogleGlyph size={19} />}
            </button>
            <button className="social-btn" type="button" aria-label="Continue with Facebook"
              onClick={handleFacebookLogin} disabled={socialLoading !== null}>
              {socialLoading === "facebook" ? <span className="social-spinner" /> : <FacebookGlyph size={19} />}
            </button>
            <button className="social-btn social-btn-soon" type="button"
              aria-label="Apple sign-in — coming soon" title="Apple sign-in is coming soon"
              onClick={handleAppleLogin} disabled={!APPLE_ENABLED || socialLoading !== null}>
              {socialLoading === "apple" ? <span className="social-spinner" /> : (
                <span className="social-btn-inner">
                  <AppleGlyph size={19} />
                  {!APPLE_ENABLED && <span className="social-soon-badge">Soon</span>}
                </span>
              )}
            </button>
          </div>
          {!APPLE_ENABLED && (
            <div className="auth-apple-note">...</div>
          )}
        </div>
        <div className="auth-foot">TropiCare · Symptom Checker for Tropical Diseases</div>
      </div>
    </div>
  );
}

function GoogleGlyph({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34.6 5.1 29.6 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.4-.1-2.4-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l6-6C34.6 5.1 29.6 3 24 3 16 3 9 7.7 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 45c5.5 0 10.4-2.1 14.1-5.5l-6.5-5.5C29.5 35.7 26.9 37 24 37c-5.3 0-9.7-3.4-11.3-8.1l-6.5 5C9 42.2 16 45 24 45z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.4l6.5 5.5C41.5 36.5 45 30.9 45 24c0-1.4-.1-2.4-.4-3.5z"/>
    </svg>
  );
}

function FacebookGlyph({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path fill="#1877F2" d="M24 12a12 12 0 10-13.9 11.9v-8.4H7.1V12h3v-2.6c0-3 1.8-4.6 4.5-4.6 1.3 0 2.6.2 2.6.2v2.9h-1.5c-1.5 0-1.9.9-1.9 1.8V12h3.3l-.5 3.5h-2.8v8.4A12 12 0 0024 12z"/>
    </svg>
  );
}

function AppleGlyph({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#0b1726">
      <path d="M16.4 1.4c0 1.1-.4 2.1-1.1 2.9-.8.9-2 1.6-3.1 1.5-.1-1.1.4-2.2 1.1-3 .8-.9 2.1-1.5 3.1-1.4zM19.8 17.3c-.4.9-.9 1.7-1.5 2.5-.8 1.1-1.7 2.5-2.9 2.5-1.1 0-1.4-.7-2.9-.7-1.5 0-1.9.7-2.9.7-1.2 0-2.1-1.3-2.9-2.4-1.7-2.4-3-6.8-1.3-9.8.9-1.5 2.4-2.4 4.1-2.5 1.1 0 2.2.8 2.9.8.7 0 2-.9 3.3-.8.6 0 2.2.2 3.3 1.8-.1.1-2 1.2-1.9 3.5 0 2.8 2.4 3.7 2.7 3.4z"/>
    </svg>
  );
}

// ─────────────────────────────────────────────
// HOME SCREEN
// ─────────────────────────────────────────────
function HomeScreen({ userId, user, onStart, onNav, toast }) {
  const [records,  setRecords]  = useState([]);
  const [profile,  setProfile]  = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    Promise.all([
      api.get("/user/profile").catch(() => null),
      api.get("/patient/history?limit=3").catch(() => null),
    ]).then(([profileData, historyData]) => {
      if (cancelled || _loggingOut) return;
      setProfile(profileData);
      setRecords(Array.isArray(historyData) ? historyData : []);
      setLoading(false);
      if (!profileData && !historyData) setError(true);
    });

    return () => { cancelled = true; };
  }, [userId]);

  // Role-gated worker view. role === "patient" (or an older account with no
  // role at all, which defaults to "patient" server-side) always falls
  // through to the existing view below, completely untouched.
  if (profile?.role === "worker") {
    return <WorkerDashboard user={user} onStart={onStart} onNav={onNav} toast={toast} />;
  }

  // Use profile API counts for accuracy (never limited by fetch page size)
  const totalAssessments = profile?.assessment_count ?? records.length;
  const highRiskCount    = profile?.high_risk_count  ?? records.filter((r) => r.risk === "High").length;
  const lastCheck        = records[0] ? fmtDate(records[0].created_at) : "None";

  const stats = [
    { label: "Assessments", val: loading ? "..." : totalAssessments, icon: "activity", color: "var(--teal)"  },
    { label: "High Risk",   val: loading ? "..." : highRiskCount,    icon: "alert",    color: "var(--red)"   },
    { label: "Last Check",  val: loading ? "..." : lastCheck,        icon: "calendar", color: "var(--blue)"  },
  ];

  return (
    <div>
      {/* Header */}
      <div className="home-header">
        <div>
          <div className="greeting">{getGreeting()}</div>
          <div style={{ fontFamily: "var(--display)", fontSize: 22, fontWeight: 700, color: "var(--ink)" }}>
            {(user?.name || "Patient").split(" ")[0]}
          </div>
        </div>
        <div className="avatar">{(user?.name || "P")[0].toUpperCase()}</div>
      </div>

      {/* Hero */}
      <div className="hero-card">
        <div className="hero-bg-icon"><Icon name="heart" size={110} color="#fff" /></div>
        <div className="hero-eyebrow">Guided Clinical Assessment</div>
        <div className="hero-headline">Check your symptoms in under 2 minutes</div>
        <button className="hero-btn" onClick={onStart}>
          Start Assessment <Icon name="chevR" size={14} color="var(--teal-dd)" />
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

      {/* Recent Assessments */}
      <div className="section">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div className="section-ttl" style={{ margin: 0 }}>Recent Assessments</div>
          {records.length > 0 && (
            <button onClick={() => onNav("records")} style={{
              fontSize: 12, color: "var(--teal-d)", background: "none", border: "none",
              cursor: "pointer", fontWeight: 700, fontFamily: "var(--font)", padding: "4px 0",
            }}>
              View All
            </button>
          )}
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: "24px 0", color: "var(--muted)", fontSize: 13 }}>
            Loading recent assessments...
          </div>
        ) : error ? (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 10 }}>
              Could not recent assessments. Check your connection.
            </div>
          </div>
        ) : records.length === 0 ? (
          <div className="card card-p" style={{ textAlign: "center", padding: "32px 20px" }}>
            <div style={{ width: 56, height: 56, margin: "0 auto 14px" }}><IllusDoctor /></div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)", marginBottom: 6 }}>
              No assessments yet
            </div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 18, lineHeight: 1.55 }}>
              Complete your first assessment to see your health history here.
            </div>
            <button className="btn btn-primary" onClick={onStart}>
              <Icon name="activity" size={15} color="#fff" />
              Start Assessment
            </button>
          </div>
        ) : (
          <div className="rec-list">
            {records.map((r) => (
              <div key={r.id} className="rec-card" onClick={() => onNav("records")}>
                <div className="rec-icon-wrap" style={{ background: `${RISK_COLOR[r.risk] || "var(--teal)"}18` }}>
                  <Icon name="heart" size={18} color={RISK_COLOR[r.risk] || "var(--teal)"} />
                </div>
                <div className="rec-info">
                  <div className="rec-name">{r.disease || "No diagnosis"}</div>
                  <div className="rec-meta">{fmtDate(r.created_at)} · {Math.round((r.confidence || 0) * 100)}% match</div>
                </div>
                <span className={`badge badge-${r.risk}`}>{r.risk}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ height: 24 }} />
    </div>
  );
}

// ─────────────────────────────────────────────
// WORKER PATIENTS — shared data hook
// Single source of truth for a worker's registered patients (GET
// /patients, sorted highest-risk first by the backend). Used by all
// three worker-facing tabs below so the fetch/loading/error logic
// exists in exactly one place instead of being duplicated per screen.
// ─────────────────────────────────────────────
function useWorkerPatients() {
  const [patients, setPatients] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(false);

  const reload = async () => {
    setLoading(true);
    setError(false);
    try {
      const data = await api.get("/patients");
      if (_loggingOut) return;
      setPatients(Array.isArray(data) ? data : []);
    } catch {
      if (!_loggingOut) { setPatients([]); setError(true); }
    } finally {
      if (!_loggingOut) setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  return { patients, loading, error, reload };
}

// Shared patient-row renderer used by the Dashboard, Check, and Records
// worker views so a patient's list entry looks and behaves identically
// everywhere it appears. `onClick` decides what tapping the row does --
// opening the patient's detail view (Dashboard/Records) or starting an
// assessment for them directly (Check).
function WorkerPatientRow({ patient, onClick }) {
  return (
    <div className="rec-card" onClick={() => onClick(patient)}>
      <div className="rec-icon-wrap" style={{ background: `${RISK_COLOR[patient.latest_risk] || "var(--teal)"}18` }}>
        <Icon name="user" size={18} color={RISK_COLOR[patient.latest_risk] || "var(--teal)"} />
      </div>
      <div className="rec-info">
        <div className="rec-name">{patient.name}</div>
        <div className="rec-meta">
          {[patient.age ? `${patient.age}y` : null, patient.gender, patient.community].filter(Boolean).join(" · ") || "No details on file"}
        </div>
      </div>
      {patient.latest_risk && <span className={`badge badge-${patient.latest_risk}`}>{patient.latest_risk}</span>}
      <Icon name="chevR" size={14} color="var(--muted-l)" />
    </div>
  );
}

// ─────────────────────────────────────────────
// WORKER DASHBOARD (Home tab)
// A snapshot, not the full roster: quick stats, the highest-risk /
// most-recently-screened patients, and fast paths into registering a
// patient or starting a new check. The full patient list lives on the
// Records tab (WorkerRecords) instead of being duplicated here.
// ─────────────────────────────────────────────
function WorkerDashboard({ user, onStart, onNav, toast }) {
  const { patients, loading, error, reload } = useWorkerPatients();
  const [view,       setView]       = useState("dashboard"); // "dashboard" | "detail"
  const [selectedId, setSelectedId] = useState(null);

  if (view === "detail" && selectedId) {
    return (
      <WorkerPatientDetail
        patientId={selectedId}
        user={user}
        toast={toast}
        onBack={() => { setView("dashboard"); reload(); }}
        onStart={onStart}
      />
    );
  }

  const highRiskCount = patients.filter((p) => p.latest_risk === "High").length;
  const lastScreening = patients
    .map((p) => p.latest_assessment_at)
    .filter(Boolean)
    .sort()
    .reverse()[0];

  const stats = [
    { label: "Patients",  val: loading ? "..." : patients.length,                icon: "activity", color: "var(--teal)" },
    { label: "High Risk", val: loading ? "..." : highRiskCount,                  icon: "alert",    color: "var(--red)"  },
    { label: "Last Check",val: loading ? "..." : (lastScreening ? fmtDate(lastScreening) : "None"), icon: "calendar", color: "var(--blue)" },
  ];

  // Highest-risk / most-recent first, capped to a short snapshot list --
  // patients is already sorted this way by GET /patients.
  const recent = patients.slice(0, 5);

  return (
    <div>
      <div className="home-header">
        <div>
          <div className="greeting">{getGreeting()}</div>
          <div style={{ fontFamily: "var(--display)", fontSize: 22, fontWeight: 700, color: "var(--ink)" }}>
            {(user?.name || "Health Worker").split(" ")[0]}
          </div>
        </div>
        <div className="avatar">{(user?.name || "W")[0].toUpperCase()}</div>
      </div>

      {/* Hero — the single entry point for starting a check and, from
          there, registering a new patient. Kept as the one canonical
          "add a patient" path rather than duplicating that action here. */}
      <div className="hero-card">
        <div className="hero-bg-icon"><Icon name="activity" size={110} color="#fff" /></div>
        <div className="hero-eyebrow">Health Worker Screening</div>
        <div className="hero-headline">Start a new patient check</div>
        <button className="hero-btn" onClick={() => onNav("assessment")}>
          Start a Check <Icon name="chevR" size={14} color="var(--teal-dd)" />
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

      <div className="section">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div className="section-ttl" style={{ margin: 0 }}>Recent Patients</div>
          {patients.length > 0 && (
            <button onClick={() => onNav("records")} style={{
              fontSize: 12, color: "var(--teal-d)", background: "none", border: "none",
              cursor: "pointer", fontWeight: 700, fontFamily: "var(--font)", padding: "4px 0",
            }}>
              View All
            </button>
          )}
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: "24px 0", color: "var(--muted)", fontSize: 13 }}>
            Loading patients...
          </div>
        ) : error ? (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 10 }}>
              Could not load your patients. Check your connection.
            </div>
            <button className="btn btn-secondary" onClick={reload}>Retry</button>
          </div>
        ) : patients.length === 0 ? (
          <div className="card card-p" style={{ textAlign: "center", padding: "32px 20px" }}>
            <div style={{ width: 56, height: 56, margin: "0 auto 14px" }}><IllusDoctor /></div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)", marginBottom: 6 }}>
              No patients yet
            </div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 18, lineHeight: 1.55 }}>
              Register your first patient to start running assessments on their behalf.
            </div>
            <button className="btn btn-primary" onClick={() => onNav("assessment")}>
              <Icon name="activity" size={15} color="#fff" />
              Start a Check
            </button>
          </div>
        ) : (
          <div className="rec-list">
            {recent.map((p) => (
              <WorkerPatientRow key={p.id} patient={p} onClick={(pt) => { setSelectedId(pt.id); setView("detail"); }} />
            ))}
          </div>
        )}
      </div>

      <div style={{ height: 24 }} />
    </div>
  );
}

// ─────────────────────────────────────────────
// WORKER CHECK (Check tab)
// Exists to answer one question fast -- "who am I screening right now."
// No dashboard framing: search or register a patient, then go straight
// into the assessment for them. Tapping a row starts their assessment
// directly rather than opening their history.
// ─────────────────────────────────────────────
function WorkerCheck({ user, onStart, toast }) {
  const { patients, loading, error, reload } = useWorkerPatients();
  const [view,   setView]   = useState("picker"); // "picker" | "new"
  const [search, setSearch] = useState("");

  if (view === "new") {
    return (
      <NewPatientForm
        onCancel={() => setView("picker")}
        onCreated={(created) => {
          setView("picker");
          reload();
          if (created) onStart(created);
        }}
      />
    );
  }

  const features = [
    { icon: "user",     title: "Select or Register", desc: "Search for an existing patient, or register someone new in a few seconds.", color: "var(--teal)",   bg: "var(--teal-xl)"  },
    { icon: "shield",   title: "Confirm Consent",     desc: "Every patient's consent is recorded before their first assessment begins.", color: "var(--blue)",   bg: "var(--blue-l)"   },
    { icon: "activity", title: "Guided Assessment",   desc: "The same adaptive, up-to-15-question assessment used for individual checks.",color: "var(--purple)", bg: "var(--purple-l)" },
  ];

  const filtered = patients.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <div className="page-head">
        <div className="al-hero">
          <div className="al-hero-text">
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--teal)", marginBottom: 6 }}>
              Health Worker Screening
            </div>
            <div style={{ fontFamily: "var(--display)", fontSize: 24, fontWeight: 700, color: "var(--ink)", lineHeight: 1.3, marginBottom: 8 }}>
              Start a symptom check for a patient
            </div>
            <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, marginBottom: 16 }}>
              Select a patient you've already registered, or register someone new, then run the same guided assessment used for individual screenings.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {["Free", "Under 2 min", "41 diseases"].map((t) => (
                <span key={t} className="badge badge-teal">
                  <Icon name="check" size={10} color="var(--teal)" />&nbsp;{t}
                </span>
              ))}
            </div>
          </div>
          <div className="al-hero-illus"><HealthProfessionalIllus width={120} height={140} /></div>
        </div>
      </div>
      <div className="page-body" style={{ flex: 1 }}>
        <div className="card card-p mb-4">
          <div className="section-ttl mb-1">How it works</div>
          <div className="feat-list">
            {features.map((f) => (
              <div key={f.title} className="feat-row">
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

        <div className="section-ttl mb-2">Select a Patient</div>

        <button className="btn btn-primary btn-full mb-3" onClick={() => setView("new")}>
          <Icon name="activity" size={15} color="#fff" />
          New Patient
        </button>

        {patients.length > 0 && (
          <div className="search-wrap mb-3">
            <span className="search-icon"><Icon name="search" size={15} /></span>
            <input className="search-input" placeholder="Search patients by name..."
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        )}

        {loading ? (
          <div className="empty-state"><div className="t-subtitle">Loading patients...</div></div>
        ) : error ? (
          <div className="empty-state">
            <Icon name="alert" size={36} color="var(--muted-l)" />
            <div className="t-title">Could not load patients</div>
            <div className="t-subtitle">Check your connection and try again.</div>
            <button className="btn btn-primary mt-3" onClick={reload}>Retry</button>
          </div>
        ) : patients.length === 0 ? (
          <div className="empty-state">
            <div style={{ width: 80, height: 80 }}><IllusDoctor /></div>
            <div className="t-title">No patients yet</div>
            <div className="t-subtitle">Register a patient above to start their first check.</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="t-title">No matching patients</div>
            <div className="t-subtitle">Try a different search, or register a new patient.</div>
          </div>
        ) : (
          <div className="rec-list">
            {filtered.map((p) => (
              <WorkerPatientRow key={p.id} patient={p} onClick={(pt) => onStart(pt)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// WORKER RECORDS (Records tab)
// The full, browsable patient roster -- search plus risk-tier filter
// chips, mirroring RecordsScreen's pattern for individual users but
// scoped to patient.latest_risk instead of an assessment's own risk.
// Tapping a patient opens their full detail/history view. Registering a
// new patient happens only from the Check tab -- this screen is purely
// for browsing/reviewing existing patients, so it carries no "New
// Patient" action of its own.
// ─────────────────────────────────────────────
function WorkerRecords({ user, onStart, onNav, toast }) {
  const { patients, loading, error, reload } = useWorkerPatients();
  const [view,       setView]       = useState("list"); // "list" | "detail"
  const [selectedId, setSelectedId] = useState(null);
  const [search,     setSearch]     = useState("");
  const [filter,     setFilter]     = useState("All");

  if (view === "detail" && selectedId) {
    return (
      <WorkerPatientDetail
        patientId={selectedId}
        user={user}
        toast={toast}
        onBack={() => { setView("list"); reload(); }}
        onStart={onStart}
      />
    );
  }

  const filtered = patients.filter((p) => {
    const ms = p.name.toLowerCase().includes(search.toLowerCase());
    const mf = filter === "All" || p.latest_risk === filter;
    return ms && mf;
  });

  return (
    <div>
      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div className="t-display">Patients</div>
            <div className="t-subtitle mt-1">{patients.length} total patient{patients.length !== 1 ? "s" : ""}</div>
          </div>
          <button onClick={reload} className="icon-btn"
            style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
            <Icon name="refresh" size={16} color="var(--muted)" />
          </button>
        </div>
      </div>
      <div className="page-body">
        <div className="search-wrap">
          <span className="search-icon"><Icon name="search" size={15} /></span>
          <input className="search-input" placeholder="Search by patient name..."
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="chip-row">
          {["All", "High", "Medium", "Low"].map((f) => (
            <button key={f} className={`chip${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>

        {loading ? (
          <div className="empty-state"><div className="t-subtitle">Loading patients...</div></div>
        ) : error ? (
          <div className="empty-state">
            <Icon name="alert" size={36} color="var(--muted-l)" />
            <div className="t-title">Could not load patients</div>
            <div className="t-subtitle">Check your connection and try again.</div>
            <button className="btn btn-primary mt-3" onClick={reload}>Retry</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div style={{ width: 80, height: 80 }}><IllusDoctor /></div>
            <div className="t-title">{search || filter !== "All" ? "No matching patients" : "No patients yet"}</div>
            <div className="t-subtitle">
              {search || filter !== "All"
                ? "Try a different search or filter."
                : "Register your first patient to start running assessments on their behalf."}
            </div>
            {!(search || filter !== "All") && (
              <button className="btn btn-primary mt-3" onClick={() => onNav("assessment")}>
                <Icon name="activity" size={15} color="#fff" />
                Start a Check
              </button>
            )}
          </div>
        ) : (
          <div className="rec-list">
            {filtered.map((p) => (
              <WorkerPatientRow key={p.id} patient={p} onClick={(pt) => { setSelectedId(pt.id); setView("detail"); }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// NEW PATIENT FORM (worker)
// ─────────────────────────────────────────────
function NewPatientForm({ onCancel, onCreated }) {
  const [name,      setName]      = useState("");
  const [age,       setAge]       = useState("");
  const [gender,    setGender]    = useState("");
  const [community, setCommunity] = useState("");
  const [consent,   setConsent]   = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err,       setErr]       = useState("");

  const submit = async () => {
    if (!name.trim()) { setErr("Please enter the patient's name."); return; }
    if (!consent) { setErr("Patient consent is required before registering them."); return; }
    setErr("");
    setSubmitting(true);
    try {
      const created = await api.post("/patients", {
        name: name.trim(),
        age: age ? Number(age) : null,
        gender: gender || null,
        community: community.trim() || null,
        consent_given: true,
      });
      // Pass the created patient back so a caller that needs it (WorkerCheck,
      // to start an assessment immediately) can use it. Callers that only
      // need to refresh their list (WorkerDashboard, WorkerRecords) can
      // simply ignore the argument -- their existing onCreated() calls
      // remain valid with no changes required on their end.
      onCreated(created);
    } catch (e) {
      setErr(e.message || "Could not register this patient. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
        <button onClick={onCancel} className="icon-btn"
          style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
          <Icon name="chevL" size={16} color="var(--ink)" />
        </button>
        <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 700, color: "var(--ink)" }}>
          New Patient
        </div>
      </div>

      <div className="card card-p">
        <div className="field">
          <label className="field-label">Full Name</label>
          <input className="field-input" placeholder="e.g. Ama Owusu" value={name}
            onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid-2">
          <div className="field">
            <label className="field-label">Age</label>
            <input className="field-input" type="number" placeholder="25" value={age}
              onChange={(e) => setAge(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">Gender</label>
            <select className="field-input field-select" value={gender}
              onChange={(e) => setGender(e.target.value)}>
              <option value="">Select</option>
              <option>Male</option>
              <option>Female</option>
              <option>Other</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field-label">Community</label>
          <input className="field-input" placeholder="e.g. Ayigya" value={community}
            onChange={(e) => setCommunity(e.target.value)} />
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
            style={{ marginTop: 3 }} />
          <span style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
            The patient has given consent to be registered and screened using TropiCare.
          </span>
        </label>

        {err && (
          <div className="disclaimer mt-2">
            <Icon name="alert" size={13} color="var(--amber)" />
            <p>{err}</p>
          </div>
        )}

        <button className="btn btn-primary btn-full mt-3" onClick={submit} disabled={submitting || !consent}>
          {submitting ? "Registering..." : "Register Patient"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// WORKER PATIENT DETAIL
// A patient's info plus their assessment history, with a button to start
// a new assessment on their behalf. Tapping a past assessment opens
// WorkerRecordDetail below -- the same rich, professional detail view an
// individual sees for their own records, scoped to this patient.
// ─────────────────────────────────────────────
function WorkerPatientDetail({ patientId, user, onBack, onStart, toast }) {
  const [patient,        setPatient]        = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState(false);
  const [selectedRecord, setSelectedRecord] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    api.get(`/patients/${patientId}`)
      .then((d) => { if (!cancelled && !_loggingOut) setPatient(d); })
      .catch(() => { if (!cancelled && !_loggingOut) setError(true); })
      .finally(() => { if (!cancelled && !_loggingOut) setLoading(false); });
    return () => { cancelled = true; };
  }, [patientId]);

  if (selectedRecord && patient) {
    return (
      <WorkerRecordDetail
        record={selectedRecord}
        patientName={patient.name}
        workerName={user?.name}
        onBack={() => setSelectedRecord(null)}
        toast={toast}
      />
    );
  }

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "48px 0", color: "var(--muted)", fontSize: 13 }}>
        Loading patient...
      </div>
    );
  }

  if (error || !patient) {
    return (
      <div style={{ textAlign: "center", padding: "48px 0" }}>
        <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 10 }}>Could not load this patient.</div>
        <button className="btn btn-secondary" onClick={onBack}>Back</button>
      </div>
    );
  }

  const history = patient.history || [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
        <button onClick={onBack} className="icon-btn"
          style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
          <Icon name="chevL" size={16} color="var(--ink)" />
        </button>
        <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 700, color: "var(--ink)" }}>
          {patient.name}
        </div>
      </div>

      <div className="card card-p mb-3">
        <div className="t-subtitle" style={{ fontSize: 13 }}>
          {[patient.age ? `${patient.age} years` : null, patient.gender, patient.community].filter(Boolean).join(" · ") || "No details on file"}
        </div>
      </div>

      <button className="btn btn-primary btn-full btn-lg mb-4" onClick={() => onStart(patient)}>
        <Icon name="activity" size={15} color="#fff" />
        Start New Assessment
      </button>

      <div className="section-ttl mb-2">Assessment History</div>
      {history.length === 0 ? (
        <div className="card card-p" style={{ textAlign: "center", padding: "24px 20px" }}>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>No assessments recorded for this patient yet.</div>
        </div>
      ) : (
        <div className="rec-list">
          {history.map((h) => (
            <div key={h.id} className="rec-card" onClick={() => setSelectedRecord(h)}>
              <div className="rec-icon-wrap" style={{ background: `${RISK_COLOR[h.risk] || "var(--teal)"}18` }}>
                <Icon name="heart" size={18} color={RISK_COLOR[h.risk] || "var(--teal)"} />
              </div>
              <div className="rec-info">
                <div className="rec-name">{h.disease || "No diagnosis"}</div>
                <div className="rec-meta">{fmtDate(h.created_at)} · {Math.round((h.confidence || 0) * 100)}% match</div>
              </div>
              <span className={`badge badge-${h.risk}`}>{h.risk}</span>
              <Icon name="chevR" size={14} color="var(--muted-l)" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// WORKER RECORD DETAIL
// The same rich assessment-detail view an individual gets for their own
// past records (RecordDetail) -- result ring, red-flag banner, clinic
// finder, recommendations, reported symptoms, differential diagnosis,
// PDF download, and delete -- scoped to one of a worker's patients.
//
// patientName is passed down explicitly from the already-loaded patient
// object rather than trusting the backend record's own patient_name
// field, and workerName is passed through to generateTropiCareReport's
// `worker` argument -- both required so the PDF's data-leak guard
// (isSelfReport) is set correctly for a worker-generated report; passing
// no `worker` here would incorrectly treat this as a self-report.
// ─────────────────────────────────────────────
function WorkerRecordDetail({ record, patientName, workerName, onBack, toast }) {
  const [full,        setFull]        = useState(record);
  const [downloading, setDownloading] = useState(false);
  const [delConfirm,  setDelConfirm]  = useState(false);
  const [deleting,    setDeleting]    = useState(false);
  const [deleted,     setDeleted]     = useState(false);
  const [showClinicFinder, setShowClinicFinder] = useState(false);

  // Fetch full record (includes ml_scores + confidence_trajectory). The
  // worker owns this diagnosis (DiagnosisModel.user_id == the worker's own
  // id), so the same ownership-checked endpoint individuals use for their
  // own records works correctly here too.
  useEffect(() => {
    let cancelled = false;
    if (!record?.id) return;
    api.get(`/patient/history/${record.id}`)
      .then((d) => { if (!cancelled && !_loggingOut) setFull({ ...record, ...d }); })
      .catch(() => { /* keep summary record as fallback */ });
    return () => { cancelled = true; };
  }, [record?.id]);

  const handleDownload = () => {
    setDownloading(true);
    try {
      generateTropiCareReport({
        patient:   { name: patientName },
        diagnosis: full,
        worker:    { name: workerName },
      });
    } catch (e) {
      if (toast) toast("Could not generate the PDF report.");
      console.error("PDF error:", e);
    } finally {
      setDownloading(false);
    }
  };

  const handleDelete = async () => {
    if (!delConfirm) {
      setDelConfirm(true);
      setTimeout(() => setDelConfirm(false), 6000);
      return;
    }
    setDeleting(true);
    try {
      await api.delete(`/patient/history/${full.id}`);
      if (toast) toast("Record deleted.");
      setDeleted(true);
      setTimeout(() => onBack(), 600);
    } catch {
      if (toast) toast("Could not delete. Please try again.");
      setDeleting(false);
      setDelConfirm(false);
    }
  };

  if (deleted) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>Record deleted.</div>
      </div>
    );
  }

  const color = RISK_COLOR[full.risk] || "var(--teal)";
  const rec   = full.recommendation   || {};
  const syms  = (full.active_symptoms || []).map((s) => s.replace(/_/g, " "));
  const mlScores = full.ml_scores
    ? Object.entries(full.ml_scores).filter(([d]) => d !== full.disease).slice(0, 5)
    : [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <button onClick={onBack} className="icon-btn"
          style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
          <Icon name="chevL" size={16} color="var(--ink)" />
        </button>
        <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 700, color: "var(--ink)" }}>
          Assessment Detail
        </div>
      </div>

      <div style={{ maxWidth: 600, margin: "0 auto", padding: "20px 16px 64px" }}>
        {/* Result summary */}
        <div className="card card-p text-c mb-3">
          <div className={`result-ring result-ring-${full.risk}`} style={{ width: 90, height: 90 }}>
            <Icon name={full.risk === "High" ? "alert" : full.risk === "Medium" ? "info" : "check"} size={36} color={color} />
          </div>
          <div style={{ fontFamily: "var(--display)", fontSize: 22, fontWeight: 700, margin: "12px 0 6px", color: "var(--ink)" }}>
            {full.disease || "No diagnosis"}
          </div>
          <span className={`badge badge-${full.risk}`}>{full.risk} Risk</span>
          <div className="t-subtitle mt-2" style={{ fontSize: 12 }}>
            {patientName} · {new Date(full.created_at).toLocaleString("en-GB")}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color, marginTop: 6 }}>
            {Math.round((full.confidence || 0) * 100)}% match
          </div>
          {full.explanation && (
            <div className="t-subtitle mt-3 italic" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              {full.explanation}
            </div>
          )}
        </div>

        {/* Urgent red-flag banner — same treatment as an individual's own
            record detail: shown whenever a dangerous symptom pattern was
            detected, even if the predicted condition displays a lower
            risk color. */}
        {full.red_flags && full.red_flags.length > 0 && (
          <div
            className="card card-p mb-3"
            style={{ border: `1px solid ${RISK_COLOR.High}`, background: RISK_BG.High }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Icon name="alert" size={16} color={RISK_COLOR.High} />
              <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 14, color: RISK_COLOR.High }}>
                Urgent — Seek Care Now
              </span>
            </div>
            {full.red_flags.map((msg, i) => (
              <p
                key={i}
                style={{
                  fontSize: 13,
                  color: "var(--ink)",
                  lineHeight: 1.5,
                  marginBottom: i < full.red_flags.length - 1 ? 6 : 0,
                }}
              >
                {msg}
              </p>
            ))}
          </div>
        )}

        {/* Clinic finder — available at every risk level */}
        <button className="btn btn-outline btn-full mb-4" onClick={() => setShowClinicFinder(true)}>
          <Icon name="map" size={16} />
          Find Nearby Clinics
        </button>

        {/* Recommendations */}
        <div className="section-ttl mb-2">Recommendations</div>
        <div className="rec-bubbles mb-4">
          <RecBubble icon="heart"     label="Home Care"        text={rec.home_care} accent="var(--green-d)"  />
          <RecBubble icon="clipboard" label="Recommended Test" text={rec.test}      accent="var(--blue-d)"   />
          <RecBubble icon="user"      label="Doctor Visit"     text={rec.doctor}    accent={color}            />
          {rec.safety && <RecBubble icon="alert" label="Important" text={rec.safety} accent="var(--red-d)" />}
        </div>

        {/* Reported symptoms */}
        {syms.length > 0 && (
          <div className="card card-p mb-4">
            <div className="section-ttl mb-2">Reported Symptoms ({syms.length})</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {syms.map((s) => (
                <span key={s} style={{
                  padding: "5px 12px", background: "var(--teal-xl)",
                  borderRadius: 99, fontSize: 12, fontWeight: 600, color: "var(--teal-d)",
                }}>
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ML scores */}
        {mlScores.length > 0 && (
          <div className="card card-p mb-4">
            <div className="section-ttl mb-3">Differential Diagnosis</div>
            {mlScores.map(([d, conf]) => (
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

        {/* Actions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button className="btn btn-secondary btn-full" onClick={handleDownload} disabled={downloading}>
            <Icon name="download" size={15} />
            {downloading ? "Preparing PDF..." : "Download PDF Report"}
          </button>
          {delConfirm && (
            <div className="disclaimer">
              <Icon name="alert" size={13} color="var(--amber)" />
              <p>Tap delete again to permanently remove this record. This cannot be undone.</p>
            </div>
          )}
          <button className="btn btn-danger btn-full" onClick={handleDelete} disabled={deleting}>
            <Icon name="trash" size={14} color="#fff" />
            {deleting ? "Deleting..." : delConfirm ? "Confirm Delete" : "Delete Record"}
          </button>
          {delConfirm && (
            <button className="btn btn-secondary btn-full" onClick={() => setDelConfirm(false)}>Cancel</button>
          )}
        </div>
      </div>

      {showClinicFinder && <ClinicFinder onClose={() => setShowClinicFinder(false)} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// ASSESSMENT LANDING
// ─────────────────────────────────────────────
function AssessmentLanding({ onStart }) {
  const features = [
    { icon: "activity", title: "Adaptive Questions",    desc: "Up to 15 questions tailored to your answers — no irrelevant ones.", color: "var(--teal)",   bg: "var(--teal-xl)"  },
    { icon: "shield",   title: "41 Diseases Covered",   desc: "Covers tropical and common diseases prevalent across West Africa.", color: "var(--blue)",   bg: "var(--blue-l)"   },
    { icon: "info",     title: "Clear Recommendations", desc: "Home care, tests to consider, and when to see a doctor.",           color: "var(--purple)", bg: "var(--purple-l)" },
  ];
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <div className="page-head">
        <div className="al-hero">
          <div className="al-hero-text">
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--teal)", marginBottom: 6 }}>
              Symptom Assessment
            </div>
            <div style={{ fontFamily: "var(--display)", fontSize: 24, fontWeight: 700, color: "var(--ink)", lineHeight: 1.3, marginBottom: 8 }}>
              Talk to our AI clinician
            </div>
            <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, marginBottom: 16 }}>
              Answer a short set of questions and receive a detailed assessment with personalised recommendations.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {["Free", "Under 2 min", "41 diseases"].map((t) => (
                <span key={t} className="badge badge-teal">
                  <Icon name="check" size={10} color="var(--teal)" />&nbsp;{t}
                </span>
              ))}
            </div>
          </div>
          <div className="al-hero-illus"><HealthProfessionalIllus width={120} height={140} /></div>
        </div>
      </div>
      <div className="page-body" style={{ flex: 1 }}>
        <div className="card card-p mb-4">
          <div className="section-ttl mb-1">How it works</div>
          <div className="feat-list">
            {features.map((f) => (
              <div key={f.title} className="feat-row">
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
        <button className="btn btn-primary btn-full btn-lg" onClick={onStart}>
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
  const answer = (val) => { setAnimKey((k) => k + 1); onAnswer(val); };
  return (
    <div className="q-screen">
      <div className="q-topbar">
        <button className="q-close" onClick={onQuit} aria-label="Exit assessment">
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
      <div style={{ fontFamily: "var(--display)", fontSize: 24, fontWeight: 700, textAlign: "center", color: "var(--ink)" }}>
        Analysing Results
      </div>
      <div className="t-subtitle mt-2 text-c" style={{ minHeight: 22 }}>{steps[step]}</div>
      <div className="loading-dots">
        <div className="ldot" /><div className="ldot" /><div className="ldot" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// RESULT SCREEN
// ─────────────────────────────────────────────
function ResultScreen({ result, user, assessmentPatient, onReset, onNewCheck, toast }) {
  const [downloading, setDownloading] = useState(false);
  const [showClinicFinder, setShowClinicFinder] = useState(false);

  const heading = assessmentPatient?.name ? `${assessmentPatient.name}'s Results` : "Your Result";

  const handleDownload = () => {
    setDownloading(true);
    try {
      if (assessmentPatient) {
        generateTropiCareReport({ patient: assessmentPatient, diagnosis: result, worker: user });
      } else {
        generateTropiCareReport({ patient: user, diagnosis: result });
      }
    } catch (e) {
      if (toast) toast("Could not generate the PDF report. Please try again.");
      console.error("PDF error:", e);
    } finally {
      setDownloading(false);
    }
  };

  const topBarStyle = {
    background: "var(--surface)",
    borderBottom: "1px solid var(--border)",
    padding: "16px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    position: "sticky",
    top: 0,
    zIndex: 10,
  };

  const CloseBtn = () => (
    <button onClick={onReset} className="icon-btn" aria-label="Close"
      style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
      <Icon name="x" size={16} color="var(--muted)" />
    </button>
  );

  if (!result.disease) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
        <div style={topBarStyle}>
          <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 700, color: "var(--ink)" }}>{heading}</div>
          <CloseBtn />
        </div>
        <div style={{ maxWidth: 600, margin: "0 auto", padding: "48px 16px 64px", textAlign: "center" }}>
          <div className="no-symptoms-ring">
            <Icon name="check" size={52} color="var(--green)" />
          </div>
          <div style={{ fontFamily: "var(--display)", fontSize: 26, fontWeight: 700, marginBottom: 10, color: "var(--ink)" }}>
            No Symptoms Detected
          </div>
          <div style={{ fontSize: 15, color: "var(--muted)", lineHeight: 1.65, marginBottom: 32, maxWidth: 380, margin: "0 auto 32px" }}>
            Based on your responses, no significant symptoms were detected. There are no indicators of the conditions this system screens for.
          </div>
          <div className="rec-bubbles mb-4" style={{ textAlign: "left" }}>
            <RecBubble icon="heart"  label="What this means" text="Your answers did not match the symptom patterns for any of the 41 conditions in our database." accent="var(--green-d)" />
            <RecBubble icon="user"   label="Recommendation"  text="If you feel unwell but were unsure how to answer, consider retaking the assessment or visiting a clinic." accent="var(--blue-d)" />
            <RecBubble icon="info"   label="Good to know"    text="This result does not mean you are definitely healthy — it means your answers did not point to a specific condition." accent="var(--purple-d)" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button className="btn btn-secondary btn-full" onClick={handleDownload} disabled={downloading}>
              <Icon name="download" size={15} />
              {downloading ? "Preparing PDF..." : "Download PDF Report"}
            </button>
            <button className="btn btn-primary btn-full btn-lg" onClick={onNewCheck}>Retake Assessment</button>
            <button className="btn btn-secondary btn-full" onClick={onReset}>Return to Home</button>
          </div>
        </div>
      </div>
    );
  }

  const risk   = result.risk || "Medium";
  const color  = RISK_COLOR[risk] || "var(--teal)";
  const bg     = RISK_BG[risk]    || "var(--green-l)";
  const rec    = result.recommendation || {};
  const scores = result.all_scores
    ? Object.entries(result.all_scores).filter(([d]) => d !== result.disease).slice(0, 5)
    : [];

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <div style={topBarStyle}>
        <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 700, color: "var(--ink)" }}>{heading}</div>
        <CloseBtn />
      </div>

      <div style={{ maxWidth: 600, margin: "0 auto", padding: "24px 16px 64px" }}>
        {/* Result ring */}
        <div className="text-c mb-4">
          <div className={`result-ring result-ring-${risk}`}>
            <Icon name={risk === "High" ? "alert" : risk === "Medium" ? "info" : "check"} size={44} color={color} />
          </div>
          <span className={`badge badge-${risk}`} style={{ fontSize: 12, padding: "4px 14px" }}>{risk} Risk</span>
        </div>

        {/* Urgent red-flag banner — shown whenever a dangerous symptom pattern
            was detected, even if the predicted condition itself displays a
            lower risk color. Distinct from the general medical disclaimer
            below. */}
        {result.red_flags && result.red_flags.length > 0 && (
          <div
            className="card card-p mb-3"
            style={{ border: `1px solid ${RISK_COLOR.High}`, background: RISK_BG.High }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Icon name="alert" size={16} color={RISK_COLOR.High} />
              <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 14, color: RISK_COLOR.High }}>
                Urgent — Seek Care Now
              </span>
            </div>
            {result.red_flags.map((msg, i) => (
              <p
                key={i}
                style={{
                  fontSize: 13,
                  color: "var(--ink)",
                  lineHeight: 1.5,
                  marginBottom: i < result.red_flags.length - 1 ? 6 : 0,
                }}
              >
                {msg}
              </p>
            ))}
          </div>
        )}

        {/* Diagnosis card */}
        <div className="card card-p mb-3 text-c">
          <div className="t-label mb-2">Predicted Condition</div>
          <div style={{ fontFamily: "var(--display)", fontSize: 26, fontWeight: 700, marginBottom: 12, color: "var(--ink)" }}>
            {result.disease}
          </div>
          <div style={{ height: 6, background: "var(--border-l)", borderRadius: 99, overflow: "hidden", marginBottom: 6 }}>
            <div style={{
              height: "100%",
              width: `${Math.round(result.confidence * 100)}%`,
              background: `linear-gradient(90deg,${color}80,${color})`,
              borderRadius: 99,
              transition: "width 0.8s cubic-bezier(0.4,0,0.2,1)",
            }} />
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color }}>{Math.round(result.confidence * 100)}% match</div>
          {result.explanation && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)", fontSize: 13, color: "var(--muted)", fontStyle: "italic", lineHeight: 1.6 }}>
              {result.explanation}
            </div>
          )}
        </div>

        {/* Clinic finder — available at every risk level */}
        <button className="btn btn-outline btn-full mb-4" onClick={() => setShowClinicFinder(true)}>
          <Icon name="map" size={16} />
          Find Nearby Clinics
        </button>

        {/* Recommendations */}
        <div className="section-ttl mb-2">What to Do</div>
        <div className="rec-bubbles mb-4">
          <RecBubble icon="heart"     label="Home Care"        text={rec.home_care} accent="var(--green-d)"  />
          <RecBubble icon="clipboard" label="Recommended Test" text={rec.test}      accent="var(--blue-d)"   />
          <RecBubble icon="user"      label="Doctor Visit"     text={rec.doctor}    accent={color}            />
          {rec.safety && <RecBubble icon="alert" label="Important" text={rec.safety} accent="var(--red-d)" />}
        </div>

        {/* Other possibilities */}
        {scores.length > 0 && (
          <div className="card card-p mb-4">
            <div className="section-ttl mb-3">Other Possibilities</div>
            {scores.map(([d, conf]) => {
              const altRisk = RISK_MAP[d] || "Medium";
              return (
                <div key={d} className="score-bar-row">
                  <span className="score-bar-name">
                    {d}
                    {altRisk === "High" && (
                      <span
                        className="badge badge-High"
                        style={{ marginLeft: 8, fontSize: 10, padding: "2px 8px", verticalAlign: "middle" }}
                      >
                        High Risk
                      </span>
                    )}
                  </span>
                  <div className="score-bar-track">
                    <div className="score-bar-fill" style={{ width: `${Math.round(conf * 100)}%` }} />
                  </div>
                  <span className="score-bar-pct">{Math.round(conf * 100)}%</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Offline notice */}
        {result.method === "offline-scoring" && (
          <div className="disclaimer mb-4">
            <Icon name="info" size={14} color="var(--amber)" />
            <p>This result was calculated offline and has not been saved to your history. Check your connection and retake the assessment if you need a saved record.</p>
          </div>
        )}

        {/* Medical disclaimer */}
        <div className="disclaimer mb-4">
          <Icon name="alert" size={14} color="var(--amber)" />
          <p>This result is for informational purposes only. It does not replace a clinical diagnosis. Consult a qualified healthcare professional before making any medical decisions.</p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button className="btn btn-secondary btn-full" onClick={handleDownload} disabled={downloading}>
            <Icon name="download" size={15} />
            {downloading ? "Preparing PDF..." : "Download PDF Report"}
          </button>
          <button className="btn btn-primary btn-full btn-lg" onClick={onNewCheck}>
            <Icon name="activity" size={16} color="#fff" />
            Start New Assessment
          </button>
          <button className="btn btn-secondary btn-full" onClick={onReset}>Return to Home</button>
        </div>
      </div>

      {showClinicFinder && <ClinicFinder onClose={() => setShowClinicFinder(false)} />}
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
  const [error,   setError]   = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    setError(false);
    try {
      const data = await api.get("/patient/history?limit=100");
      if (_loggingOut) return;
      setRecords(Array.isArray(data) ? data : []);
    } catch {
      if (!_loggingOut) { setRecords([]); setError(true); }
    } finally {
      if (!_loggingOut) setLoading(false);
    }
  };

  if (detail) return <RecordDetail record={detail} onBack={onClearDetail} toast={toast} />;

  const filtered = records.filter((r) => {
    const ms = (r.disease || "").toLowerCase().includes(search.toLowerCase())
            || (r.patient_name || "").toLowerCase().includes(search.toLowerCase());
    const mf = filter === "All" || r.risk === filter;
    return ms && mf;
  });

  return (
    <div>
      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div className="t-display">My Records</div>
            <div className="t-subtitle mt-1">{records.length} total assessment{records.length !== 1 ? "s" : ""}</div>
          </div>
          <button onClick={load} className="icon-btn"
            style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
            <Icon name="refresh" size={16} color="var(--muted)" />
          </button>
        </div>
      </div>
      <div className="page-body">
        <div className="search-wrap">
          <span className="search-icon"><Icon name="search" size={15} /></span>
          <input className="search-input" placeholder="Search by condition or name..."
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="chip-row">
          {["All", "High", "Medium", "Low"].map((f) => (
            <button key={f} className={`chip${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>

        {loading ? (
          <div className="empty-state"><div className="t-subtitle">Loading records...</div></div>
        ) : error ? (
          <div className="empty-state">
            <Icon name="alert" size={36} color="var(--muted-l)" />
            <div className="t-title">Could not load records</div>
            <div className="t-subtitle">Check your connection and try again.</div>
            <button className="btn btn-primary mt-3" onClick={load}>Retry</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div style={{ width: 80, height: 80 }}><IllusDoctor /></div>
            <div className="t-title">{search || filter !== "All" ? "No matching records" : "No records yet"}</div>
            <div className="t-subtitle">
              {search || filter !== "All"
                ? "Try a different search or filter."
                : "Complete an assessment to see your results here."}
            </div>
          </div>
        ) : (
          <div className="rec-list">
            {filtered.map((r) => (
              <div key={r.id} className="rec-card" onClick={() => onDetail(r)}>
                <div className="rec-icon-wrap" style={{ background: `${RISK_COLOR[r.risk] || "var(--teal)"}18` }}>
                  <Icon name="heart" size={18} color={RISK_COLOR[r.risk] || "var(--teal)"} />
                </div>
                <div className="rec-info">
                  <div className="rec-name">{r.disease || "No diagnosis"}</div>
                  <div className="rec-meta">
                    {r.patient_name} · {fmtDate(r.created_at)} · {Math.round((r.confidence || 0) * 100)}% match
                  </div>
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

// ─────────────────────────────────────────────
// RECORD DETAIL
// ─────────────────────────────────────────────
function RecordDetail({ record, onBack, toast }) {
  const [full,        setFull]        = useState(record);
  const [downloading, setDownloading] = useState(false);
  const [delConfirm,  setDelConfirm]  = useState(false);
  const [deleting,    setDeleting]    = useState(false);
  const [deleted,     setDeleted]     = useState(false);
  const [showClinicFinder, setShowClinicFinder] = useState(false);

  // Fetch full record (includes ml_scores + confidence_trajectory)
  useEffect(() => {
    let cancelled = false;
    if (!record?.id) return;
    api.get(`/patient/history/${record.id}`)
      .then((d) => { if (!cancelled && !_loggingOut) setFull({ ...record, ...d }); })
      .catch(() => { /* keep summary record as fallback */ });
    return () => { cancelled = true; };
  }, [record?.id]);

  const handleDownload = () => {
    setDownloading(true);
    try {
      generateTropiCareReport({ patient: { name: full.patient_name }, diagnosis: full });
    } catch (e) {
      if (toast) toast("Could not generate the PDF report.");
      console.error("PDF error:", e);
    } finally {
      setDownloading(false);
    }
  };

  const handleDelete = async () => {
    if (!delConfirm) {
      setDelConfirm(true);
      setTimeout(() => setDelConfirm(false), 6000);
      return;
    }
    setDeleting(true);
    try {
      await api.delete(`/patient/history/${full.id}`);
      if (toast) toast("Record deleted.");
      setDeleted(true);
      setTimeout(() => onBack(), 600);
    } catch {
      if (toast) toast("Could not delete. Please try again.");
      setDeleting(false);
      setDelConfirm(false);
    }
  };

  if (deleted) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>Record deleted.</div>
      </div>
    );
  }

  const color = RISK_COLOR[full.risk] || "var(--teal)";
  const bg    = RISK_BG[full.risk]    || "var(--green-l)";
  const rec   = full.recommendation   || {};
  const syms  = (full.active_symptoms || []).map((s) => s.replace(/_/g, " "));
  const mlScores = full.ml_scores
    ? Object.entries(full.ml_scores).filter(([d]) => d !== full.disease).slice(0, 5)
    : [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <button onClick={onBack} className="icon-btn"
          style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
          <Icon name="chevL" size={16} color="var(--ink)" />
        </button>
        <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 700, color: "var(--ink)" }}>
          Assessment Detail
        </div>
      </div>

      <div style={{ maxWidth: 600, margin: "0 auto", padding: "20px 16px 64px" }}>
        {/* Result summary */}
        <div className="card card-p text-c mb-3">
          <div className={`result-ring result-ring-${full.risk}`} style={{ width: 90, height: 90 }}>
            <Icon name={full.risk === "High" ? "alert" : full.risk === "Medium" ? "info" : "check"} size={36} color={color} />
          </div>
          <div style={{ fontFamily: "var(--display)", fontSize: 22, fontWeight: 700, margin: "12px 0 6px", color: "var(--ink)" }}>
            {full.disease || "No diagnosis"}
          </div>
          <span className={`badge badge-${full.risk}`}>{full.risk} Risk</span>
          <div className="t-subtitle mt-2" style={{ fontSize: 12 }}>
            {full.patient_name} · {new Date(full.created_at).toLocaleString("en-GB")}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color, marginTop: 6 }}>
            {Math.round((full.confidence || 0) * 100)}% match
          </div>
          {full.explanation && (
            <div className="t-subtitle mt-3 italic" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              {full.explanation}
            </div>
          )}
        </div>

        {/* Clinic finder — available at every risk level */}
        <button className="btn btn-outline btn-full mb-4" onClick={() => setShowClinicFinder(true)}>
          <Icon name="map" size={16} />
          Find Nearby Clinics
        </button>

        {/* Recommendations */}
        <div className="section-ttl mb-2">Recommendations</div>
        <div className="rec-bubbles mb-4">
          <RecBubble icon="heart"     label="Home Care"        text={rec.home_care} accent="var(--green-d)"  />
          <RecBubble icon="clipboard" label="Recommended Test" text={rec.test}      accent="var(--blue-d)"   />
          <RecBubble icon="user"      label="Doctor Visit"     text={rec.doctor}    accent={color}            />
          {rec.safety && <RecBubble icon="alert" label="Important" text={rec.safety} accent="var(--red-d)" />}
        </div>

        {/* Reported symptoms */}
        {syms.length > 0 && (
          <div className="card card-p mb-4">
            <div className="section-ttl mb-2">Reported Symptoms ({syms.length})</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {syms.map((s) => (
                <span key={s} style={{
                  padding: "5px 12px", background: "var(--teal-xl)",
                  borderRadius: 99, fontSize: 12, fontWeight: 600, color: "var(--teal-d)",
                }}>
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ML scores */}
        {mlScores.length > 0 && (
          <div className="card card-p mb-4">
            <div className="section-ttl mb-3">Differential Diagnosis</div>
            {mlScores.map(([d, conf]) => (
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

        {/* Actions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button className="btn btn-secondary btn-full" onClick={handleDownload} disabled={downloading}>
            <Icon name="download" size={15} />
            {downloading ? "Preparing PDF..." : "Download PDF Report"}
          </button>
          {delConfirm && (
            <div className="disclaimer">
              <Icon name="alert" size={13} color="var(--amber)" />
              <p>Tap delete again to permanently remove this record. This cannot be undone.</p>
            </div>
          )}
          <button className="btn btn-danger btn-full" onClick={handleDelete} disabled={deleting}>
            <Icon name="trash" size={14} color="#fff" />
            {deleting ? "Deleting..." : delConfirm ? "Confirm Delete" : "Delete Record"}
          </button>
          {delConfirm && (
            <button className="btn btn-secondary btn-full" onClick={() => setDelConfirm(false)}>Cancel</button>
          )}
        </div>
      </div>

      {showClinicFinder && <ClinicFinder onClose={() => setShowClinicFinder(false)} />}
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
  const [saving,  setSaving]  = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get("/user/profile")
      .then((d) => { if (!cancelled && !_loggingOut) setProfile(d); })
      .catch(() => { if (!cancelled && !_loggingOut) setProfile(user || {}); });
    return () => { cancelled = true; };
  }, []);

  const saveProfile = async () => {
    if (!name.trim()) { toast("Name cannot be empty."); return; }
    setSaving(true);
    try {
      const data = await api.put("/user/profile", { name: name.trim(), age, gender });
      if (_loggingOut) return;
      setProfile((prev) => ({ ...prev, ...data }));
      const existing = Store.get(USER_KEY) || {};
      Store.set(USER_KEY, { ...existing, name: name.trim(), age, gender });
      toast("Profile updated.");
      setEditing(false);
    } catch (e) {
      toast(e.message || "Could not save. Check your connection.");
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = () => {
    setName(user?.name || "");
    setAge(user?.age || "");
    setGender(user?.gender || "");
    setEditing(false);
  };

  const p = { ...user, ...profile };

  const menuItems = [
    { label: "Settings",           icon: "settings", action: () => onNav("settings") },
    { label: "Privacy & Security", icon: "shield",   action: () => onNav("privacy")  },
    { label: "About TropiCare",    icon: "info",     action: () => onNav("about")    },
    { label: "My Data",            icon: "database", action: () => onNav("mydata")   },
  ];

  return (
    <div>
      <div className="page-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="t-display">Profile</div>
        {!editing && (
          <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
            <Icon name="edit" size={13} /> Edit
          </button>
        )}
      </div>
      <div className="page-body">
        {/* Profile card */}
        {!editing && (
          <div className="card card-p text-c mb-3">
            <div className="avatar avatar-lg mx-auto mb-3">{(p.name || "P")[0].toUpperCase()}</div>
            <div className="t-title">{p.name}</div>
            <div className="t-subtitle mt-1">{p.email}</div>
            {(p.age || p.gender) && (
              <div className="t-subtitle">{[p.age && `${p.age} yrs`, p.gender].filter(Boolean).join(" · ")}</div>
            )}
            <div className="mt-2">
              <span className="badge badge-teal">
                Member since {new Date(p.joined_at || Date.now()).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}
              </span>
            </div>
          </div>
        )}

        {/* Edit form */}
        {editing && (
          <div className="edit-panel mb-3">
            <div className="edit-panel-title">Edit Profile</div>
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
                  <option>Male</option><option>Female</option><option>Other</option>
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={saveProfile} disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </button>
              <button className="btn btn-secondary" onClick={cancelEdit}>Cancel</button>
            </div>
          </div>
        )}

        {/* Stats */}
        <div className="profile-stat-grid">
          <div className="ps-card">
            <div className="ps-val" style={{ color: "var(--teal)" }}>{p.assessment_count || 0}</div>
            <div className="ps-lbl">Assessments</div>
          </div>
          <div className="ps-card">
            <div className="ps-val" style={{ color: "var(--red)" }}>{p.high_risk_count || 0}</div>
            <div className="ps-lbl">High Risk</div>
          </div>
        </div>

        {/* Menu */}
        <div className="card card-p mb-3">
          <div className="menu-list">
            {menuItems.map((item) => (
              <div key={item.label} className="menu-item" onClick={item.action}>
                <div className="menu-ico"><Icon name={item.icon} size={16} color="var(--muted)" /></div>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: "var(--ink)" }}>{item.label}</span>
                <Icon name="chevR" size={14} color="var(--muted-l)" />
              </div>
            ))}
          </div>
        </div>

        <button className="btn btn-danger btn-full" onClick={onLogout}>
          <Icon name="logout" size={15} color="#fff" /> Sign Out
        </button>
        <div className="text-c mt-4" style={{ fontSize: 11, color: "var(--muted-l)", lineHeight: 1.7 }}>
          TropiCare · Symptom Checker for Tropical Diseases
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// MY DATA SCREEN
// ─────────────────────────────────────────────
function MyDataScreen({ onBack, toast }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search,  setSearch]  = useState("");
  const [delId,   setDelId]   = useState(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.get("/patient/history?limit=100");
      if (!_loggingOut) setRecords(Array.isArray(data) ? data : []);
    } catch {
      if (!_loggingOut) setRecords([]);
    } finally {
      if (!_loggingOut) setLoading(false);
    }
  };

  const deleteRecord = async (id) => {
    if (delId !== id) {
      setDelId(id);
      setTimeout(() => setDelId((cur) => (cur === id ? null : cur)), 5000);
      return;
    }
    try {
      await api.delete(`/patient/history/${id}`);
      setRecords((prev) => prev.filter((r) => r.id !== id));
      setDelId(null);
      toast("Record deleted.");
    } catch {
      toast("Could not delete. Please try again.");
    }
  };

  const counts = { High: 0, Medium: 0, Low: 0 };
  records.forEach((r) => { if (counts[r.risk] !== undefined) counts[r.risk]++; });

  const shown = records.filter((r) =>
    (r.disease || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 20px 0" }}>
        <button onClick={onBack} className="icon-btn"
          style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
          <Icon name="chevL" size={16} color="var(--ink)" />
        </button>
        <div className="t-display">My Data</div>
      </div>
      <div className="page-body">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 16 }}>
          {[["High", "var(--red)"], ["Medium", "var(--amber)"], ["Low", "var(--green)"]].map(([r, c]) => (
            <div key={r} className="stat-card">
              <div className="stat-val" style={{ color: c }}>{counts[r]}</div>
              <div className="stat-lbl">{r}</div>
            </div>
          ))}
        </div>

        <div style={{ background: "var(--teal-xl)", border: "1px solid var(--teal-l)", borderRadius: "var(--radius)", padding: 16, marginBottom: 20, display: "flex", gap: 10, alignItems: "flex-start" }}>
          <Icon name="shield" size={16} color="var(--teal)" />
          <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, margin: 0 }}>
            Your assessment data is stored securely and visible only to you.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div className="section-ttl" style={{ margin: 0 }}>All Assessments ({records.length})</div>
          <button onClick={load} className="icon-btn"
            style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
            <Icon name="refresh" size={14} color="var(--muted)" />
          </button>
        </div>

        <div className="search-wrap mb-3">
          <span className="search-icon"><Icon name="search" size={15} /></span>
          <input className="search-input" placeholder="Search by condition..."
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        {loading ? (
          <div className="empty-state"><div className="t-subtitle">Loading...</div></div>
        ) : shown.length === 0 ? (
          <div className="empty-state">
            <Icon name="database" size={36} color="var(--muted-l)" />
            <div className="t-subtitle">{search ? "No matching records" : "No assessments yet"}</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {shown.map((r) => (
              <div key={r.id} className="card" style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)" }}>{r.disease || "No diagnosis"}</div>
                  <div className="t-subtitle" style={{ fontSize: 11 }}>
                    {fmtDate(r.created_at)} · {Math.round((r.confidence || 0) * 100)}% match
                  </div>
                </div>
                <span className={`badge badge-${r.risk}`}>{r.risk}</span>
                {delId === r.id ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => deleteRecord(r.id)}
                      style={{ border: "none", background: "var(--red)", color: "#fff", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                      Confirm
                    </button>
                    <button onClick={() => setDelId(null)}
                      style={{ border: "none", background: "var(--border-l)", color: "var(--muted)", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button onClick={() => deleteRecord(r.id)}
                    style={{ border: "none", background: "var(--red-l)", borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" }}>
                    <Icon name="trash" size={13} color="var(--red)" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// PRIVACY & SECURITY SCREEN
// ─────────────────────────────────────────────
function PrivacySecurityScreen({ onBack, toast, user, onLogout }) {
  const [currentPw,     setCurrentPw]     = useState("");
  const [newPw,         setNewPw]         = useState("");
  const [confirmPw,     setConfirmPw]     = useState("");
  const [showCur,       setShowCur]       = useState(false);
  const [showNew,       setShowNew]       = useState(false);
  const [showCon,       setShowCon]       = useState(false);
  const [pwLoading,     setPwLoading]     = useState(false);
  const [pwExpanded,    setPwExpanded]    = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const changePassword = async () => {
    if (!currentPw || !newPw || !confirmPw) { toast("Please fill in all password fields."); return; }
    if (newPw.length < 8) { toast("New password must be at least 8 characters."); return; }
    if (newPw !== confirmPw) { toast("New passwords do not match."); return; }
    if (currentPw === newPw) { toast("New password must differ from your current one."); return; }
    setPwLoading(true);
    try {
      await api.put("/user/change-password", { current_password: currentPw, new_password: newPw });
      toast("Password changed successfully.");
      setCurrentPw(""); setNewPw(""); setConfirmPw(""); setPwExpanded(false);
    } catch (e) {
      toast(e.message || "Could not change password. Check your current password.");
    } finally {
      setPwLoading(false);
    }
  };

  const deleteAccount = async () => {
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      setTimeout(() => setDeleteConfirm(false), 6000);
      return;
    }
    setDeleteLoading(true);
    try {
      await api.delete("/user/account");
      onLogout();
    } catch {
      toast("Could not delete account. Please try again.");
      setDeleteLoading(false);
    }
  };

  const privacyPoints = [
    { icon: "database", color: "var(--teal)",   bg: "var(--teal-xl)",  label: "Data stays yours",       desc: "Your assessment history is stored in a secured database tied to your account only." },
    { icon: "user",     color: "var(--blue)",   bg: "var(--blue-l)",   label: "No third-party sharing", desc: "Your personal health data is never sold or shared with advertisers or third parties." },
    { icon: "shield",   color: "var(--purple)", bg: "var(--purple-l)", label: "Encrypted in transit",   desc: "All data between your device and our servers is protected using HTTPS encryption." },
    { icon: "trash",    color: "var(--red)",    bg: "var(--red-l)",    label: "Right to delete",        desc: "You can permanently delete your account and all associated data at any time." },
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 20px 0" }}>
        <button onClick={onBack} className="icon-btn"
          style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
          <Icon name="chevL" size={16} color="var(--ink)" />
        </button>
        <div className="t-display">Privacy & Security</div>
      </div>
      <div className="page-body">

        {/* Account Security */}
        <div className="sec-section">
          <div className="sec-section-title">Account Security</div>
          <div className="card card-p">
            {/* Change password row */}
            <div className="sec-row" style={{ paddingTop: 0 }}>
              <div className="sec-row-icon" style={{ background: "var(--blue-l)" }}>
                <Icon name="edit" size={16} color="var(--blue)" />
              </div>
              <div className="sec-row-body">
                <div className="sec-row-label">Change Password</div>
                <div className="sec-row-hint">Update your account password</div>
              </div>
              <button
                className={`btn btn-sm ${pwExpanded ? "btn-secondary" : "btn-outline"}`}
                onClick={() => {
                  setPwExpanded(!pwExpanded);
                  if (pwExpanded) { setCurrentPw(""); setNewPw(""); setConfirmPw(""); }
                }}>
                {pwExpanded ? "Cancel" : "Change"}
              </button>
            </div>

            {pwExpanded && (
              <div className="sec-field-wrap">
                <div className="field">
                  <label className="field-label">Current Password</label>
                  <div className="pw-wrap">
                    <input className="field-input" type={showCur ? "text" : "password"}
                      placeholder="Enter current password" value={currentPw}
                      onChange={(e) => setCurrentPw(e.target.value)} style={{ paddingRight: 46 }} />
                    <button className="pw-toggle" type="button" onClick={() => setShowCur(!showCur)}>
                      <Icon name={showCur ? "eyeOff" : "eye"} size={16} />
                    </button>
                  </div>
                </div>
                <div className="field">
                  <label className="field-label">New Password</label>
                  <div className="pw-wrap">
                    <input className="field-input" type={showNew ? "text" : "password"}
                      placeholder="Min. 8 characters" value={newPw}
                      onChange={(e) => setNewPw(e.target.value)} style={{ paddingRight: 46 }} />
                    <button className="pw-toggle" type="button" onClick={() => setShowNew(!showNew)}>
                      <Icon name={showNew ? "eyeOff" : "eye"} size={16} />
                    </button>
                  </div>
                </div>
                <div className="field">
                  <label className="field-label">Confirm New Password</label>
                  <div className="pw-wrap">
                    <input className="field-input" type={showCon ? "text" : "password"}
                      placeholder="Repeat new password" value={confirmPw}
                      onChange={(e) => setConfirmPw(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && changePassword()}
                      style={{ paddingRight: 46 }} />
                    <button className="pw-toggle" type="button" onClick={() => setShowCon(!showCon)}>
                      <Icon name={showCon ? "eyeOff" : "eye"} size={16} />
                    </button>
                  </div>
                </div>

                {newPw.length > 0 && (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
                    padding: "8px 12px", borderRadius: 8,
                    background: newPw.length < 8 ? "var(--red-l)" : "var(--green-l)",
                    border: `1px solid ${newPw.length < 8 ? "var(--red-d)" : "var(--green-d)"}`,
                  }}>
                    <Icon name={newPw.length < 8 ? "alert" : "check"} size={13}
                      color={newPw.length < 8 ? "var(--red)" : "var(--green)"} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: newPw.length < 8 ? "var(--red-d)" : "var(--green-d)" }}>
                      {newPw.length < 8
                        ? `${8 - newPw.length} more character${8 - newPw.length !== 1 ? "s" : ""} needed`
                        : "Password length is good"}
                    </span>
                  </div>
                )}
                {confirmPw.length > 0 && (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 8, marginBottom: 14,
                    padding: "8px 12px", borderRadius: 8,
                    background: newPw !== confirmPw ? "var(--red-l)" : "var(--green-l)",
                    border: `1px solid ${newPw !== confirmPw ? "var(--red-d)" : "var(--green-d)"}`,
                  }}>
                    <Icon name={newPw !== confirmPw ? "x" : "check"} size={13}
                      color={newPw !== confirmPw ? "var(--red)" : "var(--green)"} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: newPw !== confirmPw ? "var(--red-d)" : "var(--green-d)" }}>
                      {newPw !== confirmPw ? "Passwords do not match" : "Passwords match"}
                    </span>
                  </div>
                )}

                <button className="btn btn-primary btn-full" onClick={changePassword} disabled={pwLoading}>
                  {pwLoading ? "Updating..." : "Update Password"}
                </button>
              </div>
            )}

            {/* Email row */}
            <div className="sec-row">
              <div className="sec-row-icon" style={{ background: "var(--teal-xl)" }}>
                <Icon name="user" size={16} color="var(--teal)" />
              </div>
              <div className="sec-row-body">
                <div className="sec-row-label">Email Address</div>
                <div className="sec-row-hint">{user?.email || "—"}</div>
              </div>
              <span className="badge badge-teal" style={{ fontSize: 10 }}>Verified</span>
            </div>
          </div>
        </div>

        {/* Privacy */}
        <div className="sec-section">
          <div className="sec-section-title">Your Privacy</div>
          <div className="card card-p">
            {privacyPoints.map((pt, i) => (
              <div key={pt.label} className="sec-row" style={{ paddingTop: i === 0 ? 0 : 14 }}>
                <div className="sec-row-icon" style={{ background: pt.bg }}>
                  <Icon name={pt.icon} size={16} color={pt.color} />
                </div>
                <div className="sec-row-body">
                  <div className="sec-row-label">{pt.label}</div>
                  <div className="sec-row-hint">{pt.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Danger Zone */}
        <div className="sec-section">
          <div className="sec-section-title">Danger Zone</div>
          <div style={{ border: "1.5px solid var(--red)", borderRadius: "var(--radius)", padding: 18 }}>
            <div style={{ fontWeight: 700, color: "var(--red)", marginBottom: 4, fontSize: 14 }}>
              Delete Account
            </div>
            <div className="t-subtitle mb-3" style={{ fontSize: 13 }}>
              Permanently removes your account and all health records. This cannot be undone.
            </div>
            {deleteConfirm && (
              <div className="disclaimer mb-3">
                <Icon name="alert" size={13} color="var(--amber)" />
                <p>Tap again to confirm. All your data will be permanently deleted.</p>
              </div>
            )}
            <button className="btn btn-danger btn-full" onClick={deleteAccount} disabled={deleteLoading}>
              <Icon name="trash" size={14} color="#fff" />
              {deleteLoading ? "Deleting..." : deleteConfirm ? "Confirm Delete Account" : "Delete My Account"}
            </button>
            {deleteConfirm && (
              <button className="btn btn-secondary btn-full mt-2" onClick={() => setDeleteConfirm(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ABOUT SCREEN
// ─────────────────────────────────────────────
function AboutScreen({ onBack }) {
  const features = [
    { icon: "activity",  color: "var(--teal)",   bg: "var(--teal-xl)",  title: "Adaptive Symptom Assessment", desc: "Questions adjust in real time based on your answers — no irrelevant questions, no wasted time." },
    { icon: "database",  color: "var(--blue)",   bg: "var(--blue-l)",   title: "Machine Learning Diagnosis",   desc: "A calibrated ensemble of Random Forest, XGBoost, and Logistic Regression trained on a curated dataset of 41 tropical and common diseases." },
    { icon: "shield",    color: "var(--purple)", bg: "var(--purple-l)", title: "Risk Stratification",          desc: "Every result is classified as High, Medium, or Low risk with clear, actionable next steps." },
    { icon: "heart",     color: "var(--red)",    bg: "var(--red-l)",    title: "AI-Powered Recommendations",   desc: "OpenRouter AI generates personalised home care, test, and doctor-visit guidance tailored to your symptoms." },
    { icon: "clipboard", color: "var(--amber)",  bg: "var(--amber-l)",  title: "Assessment History",           desc: "All past results are stored securely so you and your care provider can track changes over time." },
    { icon: "map",       color: "var(--teal)",   bg: "var(--teal-xl)",  title: "Nearby Clinic Finder",         desc: "Locate nearby hospitals and clinics with one tap and get directions, for any assessment result." },
    { icon: "user",      color: "var(--green)",  bg: "var(--green-l)",  title: "Built for West Africa",        desc: "Disease coverage and clinical guidance are tailored to the disease burden and healthcare context of West Africa." },
  ];

  const team = [
    { initials: "OA", name: "Obed Mensah",          role: "Full-Stack Developer · Frontend, Backend & ML",      color: "var(--teal)",   bg: "var(--teal-xl)"  },
    { initials: "AK", name: "Afrique-Ahali Kekeli", role: "Research Lead · Dataset Curation & Disease Mapping", color: "var(--blue)",   bg: "var(--blue-l)"   },
    { initials: "JK", name: "Prof. J.J. Kponyo",    role: "Project Supervisor · KNUST",                         color: "var(--purple)", bg: "var(--purple-l)" },
  ];

  const versionInfo = [
    { key: "Version",     val: "1.0.0" },
    { key: "Release",     val: "Jan 2026" },
    { key: "Platform",    val: "Web · Mobile" },
    { key: "Institution", val: "KNUST, Ghana" },
    { key: "License",     val: "Academic use only" },
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 20px 0" }}>
        <button onClick={onBack} className="icon-btn"
          style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
          <Icon name="chevL" size={16} color="var(--ink)" />
        </button>
        <div className="t-display">About TropiCare</div>
      </div>
      <div className="page-body">
        <div className="about-hero">
          <div className="about-hero-bg"><Icon name="heart" size={160} color="#fff" /></div>
          <div className="about-hero-title">TropiCare</div>
          <div className="about-hero-sub">
            An AI-guided symptom checker built to help patients and clinicians identify tropical
            diseases faster with clear risk levels and personalised recommendations.
          </div>
        </div>

        <div className="about-mission mb-4">
          <div className="about-mission-label">Our Mission</div>
          <div className="about-mission-text">
            TropiCare bridges the gap between symptom onset and clinical attention in resource-constrained
            settings. By combining machine learning with adaptive questioning, it provides structured,
            risk-stratified guidance to patients and triage staff before a doctor is available.
          </div>
        </div>

        <div className="about-fact-grid mb-4">
          {[
            { val: "41", lbl: "Diseases covered"  },
            { val: "130", lbl: "Tracked symptoms"  },
            { val: "15", lbl: "Max questions"      },
            { val: "3",  lbl: "ML models"          },
          ].map((f) => (
            <div key={f.lbl} className="about-fact">
              <div className="about-fact-val">{f.val}</div>
              <div className="about-fact-lbl">{f.lbl}</div>
            </div>
          ))}
        </div>

        <div className="section-ttl mb-2">What TropiCare Does</div>
        <div className="card card-p mb-4">
          {features.map((f) => (
            <div key={f.title} className="about-feature-row">
              <div className="about-feature-icon" style={{ background: f.bg }}>
                <Icon name={f.icon} size={17} color={f.color} />
              </div>
              <div>
                <div className="about-feature-title">{f.title}</div>
                <div className="about-feature-desc">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="disclaimer mb-4">
          <Icon name="alert" size={14} color="var(--amber)" />
          <p>
            TropiCare is an informational tool only. It does not replace a clinical examination or a
            qualified healthcare professional. Always consult a doctor for a definitive diagnosis.
          </p>
        </div>

        <div className="section-ttl mb-2">The Team</div>
        {team.map((t) => (
          <div key={t.name} className="about-team-card">
            <div className="about-team-avatar" style={{ background: t.bg, color: t.color }}>
              {t.initials}
            </div>
            <div>
              <div className="about-team-name">{t.name}</div>
              <div className="about-team-role">{t.role}</div>
            </div>
          </div>
        ))}

        <div className="section-ttl mt-4 mb-2">Version Info</div>
        <div className="card card-p mb-4">
          {versionInfo.map((v) => (
            <div key={v.key} className="about-version-strip">
              <span className="about-version-key">{v.key}</span>
              <span className="about-version-val">{v.val}</span>
            </div>
          ))}
        </div>

        <div className="text-c" style={{ fontSize: 11, color: "var(--muted-l)", lineHeight: 1.8 }}>
          TropiCare · Symptom Checker for Tropical Diseases<br />
          Kwame Nkrumah University of Science and Technology
        </div>
        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// SETTINGS SCREEN
// ─────────────────────────────────────────────
function SettingsScreen({ onBack, toast, onThemeChange, currentTheme, onFontSizeChange, currentFontSize }) {
  const [theme,    setTheme]    = useState(currentTheme    || "light");
  const [fontSize, setFontSize] = useState(currentFontSize || "medium");
  const [notifs,   setNotifs]   = useState(true);
  const [lang,     setLang]     = useState("en");
  const [saved,    setSaved]    = useState(false);

  // Sync if parent-supplied values change
  useEffect(() => {
    if (currentTheme    && currentTheme    !== theme)    setTheme(currentTheme);
    if (currentFontSize && currentFontSize !== fontSize) setFontSize(currentFontSize);
  }, [currentTheme, currentFontSize]);

  // Load persisted settings on mount
  useEffect(() => {
    const s = Store.get("tc_settings");
    if (s) {
      if (s.theme)         setTheme(s.theme);
      if (s.fontSize)      setFontSize(s.fontSize);
      if (s.notifications !== undefined) setNotifs(s.notifications !== false);
      if (s.language)      setLang(s.language);
    }
  }, []);

  const applyTheme = (val) => {
    setTheme(val);
    setSaved(false);
    if (onThemeChange) onThemeChange(val);
  };

  const applyFontSize = (val) => {
    setFontSize(val);
    setSaved(false);
    // Apply immediately for live preview
    const root = document.documentElement;
    if (val === "medium") {
      root.removeAttribute("data-fontsize");
    } else {
      root.setAttribute("data-fontsize", val);
    }
    if (onFontSizeChange) onFontSizeChange(val);
  };

  const save = () => {
    Store.set("tc_settings", { theme, fontSize, notifications: notifs, language: lang });
    if (onThemeChange)    onThemeChange(theme);
    if (onFontSizeChange) onFontSizeChange(fontSize);
    setSaved(true);
    toast("Settings saved.");
  };

  const THEME_OPTIONS = [
    { val: "light",  label: "Light",  icon: "sun"     },
    { val: "dark",   label: "Dark",   icon: "moon"    },
    { val: "system", label: "System", icon: "monitor" },
  ];

  const FONT_OPTIONS = [
    { val: "small",  label: "Small"  },
    { val: "medium", label: "Medium" },
    { val: "large",  label: "Large"  },
  ];

  const LANG_OPTIONS = [
    { val: "en", label: "English" },
    { val: "tw", label: "Twi"     },
    { val: "fr", label: "French"  },
    { val: "ha", label: "Hausa"   },
  ];

  const Toggle = ({ checked, onChange }) => (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-slider" />
    </label>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 20px 0" }}>
        <button onClick={onBack} className="icon-btn"
          style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
          <Icon name="chevL" size={16} color="var(--ink)" />
        </button>
        <div className="t-display">Settings</div>
      </div>
      <div className="page-body">

        {/* Appearance */}
        <div style={{ marginBottom: 16 }}>
          <div className="section-ttl mb-2">Appearance</div>
          <div className="card card-p">

            {/* Theme */}
            <div className="t-label mb-2">Theme</div>
            <div className="theme-preview-strip">
              {THEME_OPTIONS.map((o) => (
                <button
                  key={o.val}
                  className={`theme-preview-swatch ${o.val}-sw${theme === o.val ? " selected" : ""}`}
                  onClick={() => applyTheme(o.val)}
                  aria-pressed={theme === o.val}
                  title={`${o.label} theme`}>
                  <Icon
                    name={o.icon}
                    size={14}
                    color={
                      o.val === "dark" ? "#e8eef3"
                      : o.val === "system" ? "var(--teal)"
                      : "#0b1726"
                    }
                  />
                  <span>{o.label}</span>
                </button>
              ))}
            </div>
            {theme === "system" && (
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
                <Icon name="monitor" size={13} color="var(--muted)" />
                Follows your device display settings and updates live.
              </div>
            )}

            {/* Font size */}
            <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 16 }}>
              <div className="t-label mb-2">Text Size</div>
              <div className="fs-strip">
                {FONT_OPTIONS.map((o) => (
                  <button
                    key={o.val}
                    className={`fs-btn fs-${o.val}${fontSize === o.val ? " selected" : ""}`}
                    onClick={() => applyFontSize(o.val)}
                    aria-pressed={fontSize === o.val}>
                    {o.label}
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
                Medium is the default. Changes apply immediately across the app.
              </div>
            </div>
          </div>
        </div>

        {/* Notifications */}
        <div style={{ marginBottom: 16 }}>
          <div className="section-ttl mb-2">Notifications</div>
          <div className="card card-p">
            <div className="toggle-row">
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ink)" }}>Push Notifications</div>
                <div className="t-subtitle" style={{ fontSize: 12 }}>Health reminders and updates</div>
              </div>
              <Toggle checked={notifs} onChange={(v) => { setNotifs(v); setSaved(false); }} />
            </div>
          </div>
        </div>

        {/* Language */}
        <div style={{ marginBottom: 16 }}>
          <div className="section-ttl mb-2">Language</div>
          <div className="card card-p">
            <div className="chip-row" style={{ marginBottom: 0 }}>
              {LANG_OPTIONS.map((o) => (
                <button
                  key={o.val}
                  className={`chip${lang === o.val ? " on" : ""}`}
                  onClick={() => { setLang(o.val); setSaved(false); }}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Privacy summary */}
        <div style={{ marginBottom: 16 }}>
          <div className="section-ttl mb-2">Privacy</div>
          <div className="card card-p">
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
              <Icon name="shield" size={16} color="var(--green)" />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)" }}>Encrypted Storage</div>
                <div className="t-subtitle" style={{ fontSize: 12 }}>All data is secured in transit and at rest</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 12 }}>
              <Icon name="check" size={16} color="var(--green)" />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)" }}>No Third-Party Sharing</div>
                <div className="t-subtitle" style={{ fontSize: 12 }}>Your health data is never shared</div>
              </div>
            </div>
          </div>
        </div>

        <button className="btn btn-primary btn-full" onClick={save}>
          <Icon name="check" size={15} color="#fff" />
          Save Settings
        </button>

        {saved && (
          <div style={{ marginTop: 10, textAlign: "center", fontSize: 12, color: "var(--green-d)", fontWeight: 600 }}>
            Settings saved.
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function getGreeting() {
  const h = new Date().getHours();
  if (h >= 5  && h < 12) return "Good morning,";
  if (h >= 12 && h < 17) return "Good afternoon,";
  if (h >= 17 && h < 21) return "Good evening,";
  return "Good night,";
}

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}
