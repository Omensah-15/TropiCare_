/*
 * TropiCare — App.jsx
 * Backend: FastAPI (tropicare.onrender.com)
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────
// BACKEND CONFIG
// ─────────────────────────────────────────────
const API_BASE = "https://tropicare.onrender.com/api/v1";

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
  "Hepatitis A":          ["yellowing
