import os
import json
import uuid
import logging
import asyncio
import hashlib
import secrets
import time
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any

import aiohttp
import numpy as np

try:
    import joblib
    JOBLIB_AVAILABLE = True
except ImportError:
    JOBLIB_AVAILABLE = False

from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Depends, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, validator
from sqlalchemy import (
    create_engine, Column, Integer, String, Float,
    Boolean, DateTime, ForeignKey, Text, event,
)
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from jose import JWTError, jwt
from dotenv import load_dotenv

# -----------------------------------------------------------------
# CONFIG
# -----------------------------------------------------------------
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("tropicare")

SECRET_KEY               = os.getenv("SECRET_KEY", "tropicare-fallback-secret-2024")
ALGORITHM                = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_URL     = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODEL   = os.getenv("OPENROUTER_MODEL", "mistralai/mistral-7b-instruct:free")

OPENROUTER_CONNECT_TIMEOUT = float(os.getenv("OPENROUTER_CONNECT_TIMEOUT", "10"))
OPENROUTER_READ_TIMEOUT    = float(os.getenv("OPENROUTER_READ_TIMEOUT",    "50"))
OPENROUTER_TOTAL_TIMEOUT   = float(os.getenv("OPENROUTER_TOTAL_TIMEOUT",   "60"))
OPENROUTER_MAX_RETRIES     = int(os.getenv("OPENROUTER_MAX_RETRIES",       "2"))
OPENROUTER_RETRY_DELAY     = float(os.getenv("OPENROUTER_RETRY_DELAY",     "3.0"))

SITE_URL     = os.getenv("SITE_URL",  "https://tropicare.onrender.com")
SITE_NAME    = os.getenv("SITE_NAME", "TropiCare")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./tropicare.db")
MODELS_DIR   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

DB_POOL_SIZE    = int(os.getenv("DB_POOL_SIZE",    "10"))
DB_MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "20"))
DB_POOL_TIMEOUT = int(os.getenv("DB_POOL_TIMEOUT", "30"))

# -----------------------------------------------------------------
# DATABASE
# -----------------------------------------------------------------
_is_sqlite = DATABASE_URL.startswith("sqlite")

if _is_sqlite:
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
        pool_size=1,
        max_overflow=0,
        pool_pre_ping=True,
        pool_recycle=1800,
    )

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA cache_size=-65536")
        cur.close()
else:
    pg_connect_args: Dict[str, Any] = {
        "connect_timeout": 10,
        "application_name": "TropiCare",
        "options": "-c statement_timeout=30000",
    }
    engine = create_engine(
        DATABASE_URL,
        pool_size=DB_POOL_SIZE,
        max_overflow=DB_MAX_OVERFLOW,
        pool_timeout=DB_POOL_TIMEOUT,
        pool_pre_ping=True,
        pool_recycle=1800,
        connect_args=pg_connect_args,
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base         = declarative_base()


# -----------------------------------------------------------------
# ORM MODELS
# -----------------------------------------------------------------
class UserModel(Base):
    __tablename__ = "users"
    id         = Column(Integer, primary_key=True, index=True)
    email      = Column(String(255), unique=True, index=True, nullable=False)
    name       = Column(String(255), nullable=False)
    pw_hash    = Column(String(512), nullable=True)
    age        = Column(String(10), nullable=True)
    gender     = Column(String(20), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class DiagnosisModel(Base):
    __tablename__ = "diagnoses"
    id              = Column(Integer, primary_key=True, index=True)
    user_id         = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    session_id      = Column(String(64), index=True)
    disease         = Column(String(100))
    risk            = Column(String(20))
    confidence      = Column(Float)
    answers         = Column(Text)
    active_symptoms = Column(Text)
    rec_home_care   = Column(Text, nullable=True)
    rec_test        = Column(Text, nullable=True)
    rec_doctor      = Column(Text, nullable=True)
    rec_safety      = Column(Text, nullable=True)
    ai_explanation  = Column(Text, nullable=True)
    ml_scores       = Column(Text, nullable=True)
    ai_used         = Column(Boolean, default=False)
    created_at      = Column(DateTime, default=datetime.utcnow, index=True)


class SessionModel(Base):
    __tablename__ = "assessment_sessions"
    id              = Column(Integer, primary_key=True, index=True)
    session_id      = Column(String(64), unique=True, index=True)
    user_id         = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    answers         = Column(Text, default="{}")
    asked_questions = Column(Text, default="[]")
    completed       = Column(Boolean, default=False, index=True)
    created_at      = Column(DateTime, default=datetime.utcnow, index=True)


# -----------------------------------------------------------------
# DB HELPERS
# -----------------------------------------------------------------
def _load_json(value: Optional[str], default):
    if value is None:
        return default
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


def _dump_json(value) -> str:
    return json.dumps(value, separators=(",", ":"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# -----------------------------------------------------------------
# ML MODEL REGISTRY
# -----------------------------------------------------------------
LOADED_MODELS: Dict[str, Any] = {}
_REQUIRED_MODEL_KEYS = ("sctd_ensemble", "sctd_label_encoder", "sctd_feature_columns")


def load_ml_models() -> None:
    if not JOBLIB_AVAILABLE:
        logger.warning("joblib not installed — ML models cannot be loaded. Using scoring engine.")
        return

    os.makedirs(MODELS_DIR, exist_ok=True)
    pkl_files = [f for f in os.listdir(MODELS_DIR) if f.endswith(".pkl")]
    if not pkl_files:
        logger.warning("No .pkl files found in %s — using scoring engine.", MODELS_DIR)
        return

    for fname in pkl_files:
        key = fname.replace(".pkl", "")
        try:
            LOADED_MODELS[key] = joblib.load(os.path.join(MODELS_DIR, fname))
            logger.info("Loaded ML model: %s (key=%s)", fname, key)
        except Exception as exc:
            logger.error("Failed to load %s: %s", fname, exc)

    missing = [k for k in _REQUIRED_MODEL_KEYS if k not in LOADED_MODELS]
    if missing:
        logger.warning(
            "Missing required model keys %s — ML will fall back to scoring engine. "
            "Rename your .pkl files to: %s",
            missing, [f"{k}.pkl" for k in _REQUIRED_MODEL_KEYS],
        )
    else:
        le   = LOADED_MODELS.get("sctd_label_encoder")
        cols = LOADED_MODELS.get("sctd_feature_columns")
        ens  = LOADED_MODELS.get("sctd_ensemble")
        logger.info(
            "ML ensemble ready | features=%s classes=%s estimator=%s",
            len(list(cols)) if cols else "?",
            len(le.classes_) if hasattr(le, "classes_") else "?",
            type(ens).__name__ if ens else "?",
        )


# -----------------------------------------------------------------
# DISEASE / SYMPTOM DATA
# -----------------------------------------------------------------
RISK_MAP: Dict[str, str] = {
    "Malaria": "High", "Typhoid": "High", "Dengue": "High",
    "Tuberculosis": "High", "Hepatitis B": "High", "Hepatitis C": "High",
    "Hepatitis D": "High", "Pneumonia": "High",
    "Hepatitis A": "Medium", "Hepatitis E": "Medium",
    "Alcoholic Hepatitis": "Medium", "Jaundice": "Medium",
    "Chicken Pox": "Medium", "Bronchial Asthma": "Medium",
    "Urinary Tract Infection": "Medium", "Dimorphic Haemorrhoids": "Medium",
    "Peptic Ulcer Disease": "Medium", "Diabetes": "Medium",
    "Fungal Infection": "Low", "Allergy": "Low",
    "Common Cold": "Low", "Drug Reaction": "Low",
}

DISEASE_SYMPTOM_MAP: Dict[str, List[str]] = {
    "Malaria":                ["high_fever","chills","sweating","headache","muscle_pain","vomiting","fatigue","joint_pain","nausea","malaise","loss_of_appetite","fast_heart_rate","confusion","coma"],
    "Typhoid":                ["high_fever","headache","fatigue","loss_of_appetite","vomiting","constipation","toxic_look","abdominal_pain","diarrhoea","loss_of_appetite_fever","fast_heart_rate","red_spots_over_body","confusion"],
    "Dengue":                 ["high_fever","headache","pain_behind_eyes","muscle_pain","joint_pain","skin_rash","red_spots_over_body","vomiting","fatigue","malaise","fast_heart_rate","swelled_lymph_nodes"],
    "Tuberculosis":           ["cough","blood_in_sputum","weight_loss","fatigue","sweating","chest_pain","breathlessness","phlegm","loss_of_appetite","high_fever","swollen_lymph_neck","family_history"],
    "Hepatitis B":            ["yellowing_of_eyes","yellowish_skin","dark_urine","fatigue","blood_transfusion","unsterile_injections","abdominal_pain","nausea","loss_of_appetite","internal_itching","acute_liver_failure"],
    "Hepatitis C":            ["yellowing_of_eyes","yellowish_skin","fatigue","nausea","loss_of_appetite","blood_transfusion","dark_urine","weight_loss","internal_itching","abdominal_pain"],
    "Hepatitis D":            ["yellowing_of_eyes","yellowish_skin","dark_urine","fatigue","acute_liver_failure","fluid_overload","blood_transfusion","unsterile_injections","swelling_stomach"],
    "Pneumonia":              ["cough","breathlessness","chest_pain","high_fever","rusty_sputum","chills","fatigue","phlegm","loss_of_appetite","malaise"],
    "Hepatitis A":            ["yellowing_of_eyes","yellowish_skin","dark_urine","fatigue","loss_of_appetite","nausea","abdominal_pain","vomiting","mild_fever","malaise","distension_of_abdomen"],
    "Hepatitis E":            ["yellowing_of_eyes","yellowish_skin","fatigue","loss_of_appetite","nausea","mild_fever","yellow_urine","abdominal_pain","malaise"],
    "Alcoholic Hepatitis":    ["yellowing_of_eyes","vomiting","abdominal_pain","alcohol_history","swelling_stomach","fluid_overload","yellowish_skin","acute_liver_failure","distension_of_abdomen"],
    "Jaundice":               ["yellowing_of_eyes","yellowish_skin","dark_urine","yellow_urine","itching","fatigue","abdominal_pain","internal_itching","fluid_overload","distension_of_abdomen"],
    "Chicken Pox":            ["skin_rash","itching","red_spots_over_body","mild_fever","fatigue","headache","loss_of_appetite","nodal_skin_eruptions"],
    "Bronchial Asthma":       ["breathlessness","cough","phlegm","chest_pain","fatigue"],
    "Urinary Tract Infection":["burning_micturition","urinating_frequently","continuous_feel_of_urine","bladder_discomfort","foul_smell_of_urine","spotting_urination","back_pain"],
    "Dimorphic Haemorrhoids": ["bloody_stool","pain_anal_region","pain_bowel_movements","constipation","passage_of_gases","irritation_anus"],
    "Peptic Ulcer Disease":   ["stomach_pain","indigestion","vomiting","loss_of_appetite","nausea","stomach_bleeding","abdominal_pain","passage_of_gases"],
    "Diabetes":               ["polyuria","excessive_hunger","irregular_sugar_level","weight_loss","fatigue","blurred_vision","urinating_frequently","increased_appetite","family_history","obesity"],
    "Fungal Infection":       ["itching","skin_rash","dischromic_patches","nodal_skin_eruptions","irritation_anus"],
    "Allergy":                ["continuous_sneezing","runny_nose","itching","watering_from_eyes","skin_rash","redness_of_eyes","throat_irritation","mild_fever","joint_pain"],
    "Common Cold":            ["runny_nose","continuous_sneezing","throat_irritation","mild_fever","cough","headache","sinus_pressure","watering_from_eyes","loss_of_smell"],
    "Drug Reaction":          ["itching","skin_rash","red_spots_over_body","fatigue","nausea","diarrhoea"],
}

ALL_QUESTIONS: List[Dict[str, str]] = [
    {"id":"high_fever","question":"Do you have a high fever?","category":"General"},
    {"id":"mild_fever","question":"Do you have a mild fever?","category":"General"},
    {"id":"fatigue","question":"Do you feel unusually tired or weak?","category":"General"},
    {"id":"malaise","question":"Do you feel generally unwell or sick?","category":"General"},
    {"id":"chills","question":"Do you have chills or shivering?","category":"General"},
    {"id":"sweating","question":"Do you have sweating episodes?","category":"General"},
    {"id":"headache","question":"Do you have headaches?","category":"General"},
    {"id":"muscle_pain","question":"Do you have muscle pain or body aches?","category":"General"},
    {"id":"joint_pain","question":"Do you have joint pain?","category":"General"},
    {"id":"back_pain","question":"Do you have back pain?","category":"General"},
    {"id":"cough","question":"Do you have a cough?","category":"Respiratory"},
    {"id":"phlegm","question":"Are you coughing up phlegm or mucus?","category":"Respiratory"},
    {"id":"rusty_sputum","question":"Are you coughing up rusty or brown-coloured sputum?","category":"Respiratory"},
    {"id":"blood_in_sputum","question":"Are you coughing up blood?","category":"Respiratory"},
    {"id":"breathlessness","question":"Do you have difficulty breathing or shortness of breath?","category":"Respiratory"},
    {"id":"chest_pain","question":"Do you have chest pain?","category":"Respiratory"},
    {"id":"runny_nose","question":"Do you have a runny nose?","category":"Respiratory"},
    {"id":"continuous_sneezing","question":"Do you sneeze frequently?","category":"Respiratory"},
    {"id":"throat_irritation","question":"Do you have a sore or irritated throat?","category":"Respiratory"},
    {"id":"sinus_pressure","question":"Do you have sinus pressure or nasal congestion?","category":"Respiratory"},
    {"id":"watering_from_eyes","question":"Do you have watery eyes?","category":"Respiratory"},
    {"id":"loss_of_smell","question":"Have you lost your sense of smell?","category":"Respiratory"},
    {"id":"nausea","question":"Do you have nausea?","category":"Digestive"},
    {"id":"vomiting","question":"Do you have vomiting?","category":"Digestive"},
    {"id":"diarrhoea","question":"Do you have diarrhoea?","category":"Digestive"},
    {"id":"stomach_pain","question":"Do you have stomach pain?","category":"Digestive"},
    {"id":"abdominal_pain","question":"Do you have abdominal or belly pain?","category":"Digestive"},
    {"id":"indigestion","question":"Do you have indigestion or acidity?","category":"Digestive"},
    {"id":"distension_of_abdomen","question":"Do you feel bloated or have a distended abdomen?","category":"Digestive"},
    {"id":"constipation","question":"Do you have constipation?","category":"Digestive"},
    {"id":"passage_of_gases","question":"Do you have excessive gas or passage of gas?","category":"Digestive"},
    {"id":"bloody_stool","question":"Do you have blood in your stool?","category":"Digestive"},
    {"id":"loss_of_appetite","question":"Do you have a loss of appetite?","category":"Digestive"},
    {"id":"stomach_bleeding","question":"Do you have stomach bleeding?","category":"Digestive"},
    {"id":"yellowish_skin","question":"Is your skin yellowish or pale?","category":"Liver"},
    {"id":"yellowing_of_eyes","question":"Are your eyes yellow?","category":"Liver"},
    {"id":"dark_urine","question":"Is your urine dark or tea-coloured?","category":"Liver"},
    {"id":"yellow_urine","question":"Is your urine yellow-coloured?","category":"Liver"},
    {"id":"internal_itching","question":"Do you have internal itching?","category":"Liver"},
    {"id":"acute_liver_failure","question":"Do you have signs of acute liver failure?","category":"Liver"},
    {"id":"fluid_overload","question":"Do you have fluid overload or swelling in the body?","category":"Liver"},
    {"id":"itching","question":"Do you have itching on your skin?","category":"Skin"},
    {"id":"skin_rash","question":"Do you have a skin rash?","category":"Skin"},
    {"id":"red_spots_over_body","question":"Do you have red spots on your body?","category":"Skin"},
    {"id":"nodal_skin_eruptions","question":"Do you have nodules or skin eruptions?","category":"Skin"},
    {"id":"dischromic_patches","question":"Do you have discoloured patches on your skin?","category":"Skin"},
    {"id":"redness_of_eyes","question":"Do you have redness in your eyes?","category":"Eyes"},
    {"id":"blurred_vision","question":"Do you have blurred or distorted vision?","category":"Eyes"},
    {"id":"pain_behind_eyes","question":"Do you have pain behind your eyes?","category":"Eyes"},
    {"id":"burning_micturition","question":"Do you feel a burning sensation when urinating?","category":"Urinary"},
    {"id":"urinating_frequently","question":"Do you urinate very frequently?","category":"Urinary"},
    {"id":"continuous_feel_of_urine","question":"Do you have a continuous urge to urinate?","category":"Urinary"},
    {"id":"bladder_discomfort","question":"Do you have discomfort in your bladder?","category":"Urinary"},
    {"id":"foul_smell_of_urine","question":"Does your urine have a foul smell?","category":"Urinary"},
    {"id":"spotting_urination","question":"Do you have spotting during urination?","category":"Urinary"},
    {"id":"pain_anal_region","question":"Do you have pain in your anal region?","category":"Rectal"},
    {"id":"pain_bowel_movements","question":"Do you have pain during bowel movements?","category":"Rectal"},
    {"id":"irritation_anus","question":"Do you have irritation around the anus?","category":"Rectal"},
    {"id":"restlessness","question":"Do you feel restless or agitated?","category":"Neurological"},
    {"id":"mood_swings","question":"Do you have mood swings?","category":"Neurological"},
    {"id":"confusion","question":"Do you feel confused or disoriented?","category":"Neurological"},
    {"id":"coma","question":"Have you lost consciousness or fallen into a coma?","category":"Neurological"},
    {"id":"excessive_hunger","question":"Are you excessively hungry?","category":"Metabolic"},
    {"id":"increased_appetite","question":"Has your appetite increased significantly?","category":"Metabolic"},
    {"id":"irregular_sugar_level","question":"Do you have an irregular blood sugar level?","category":"Metabolic"},
    {"id":"polyuria","question":"Do you urinate in very large amounts?","category":"Metabolic"},
    {"id":"dehydration","question":"Do you feel severely dehydrated?","category":"Metabolic"},
    {"id":"weight_loss","question":"Do you have unexplained weight loss?","category":"Metabolic"},
    {"id":"obesity","question":"Are you obese or significantly overweight?","category":"Metabolic"},
    {"id":"swelled_lymph_nodes","question":"Do you have swollen lymph nodes?","category":"Infection"},
    {"id":"swelling_stomach","question":"Do you have swelling of your stomach area?","category":"Infection"},
    {"id":"fast_heart_rate","question":"Do you have a fast or irregular heart rate?","category":"Infection"},
    {"id":"toxic_look","question":"Do you look severely ill or toxic-looking?","category":"Infection"},
    {"id":"swollen_lymph_neck","question":"Do you have swollen lymph nodes in the neck or armpit?","category":"Infection"},
    {"id":"loss_of_appetite_fever","question":"Do you have a loss of appetite alongside fever?","category":"Infection"},
    {"id":"family_history","question":"Do you have a family history of this condition?","category":"History"},
    {"id":"blood_transfusion","question":"Have you recently received a blood transfusion?","category":"History"},
    {"id":"unsterile_injections","question":"Have you received injections with unsterile equipment?","category":"History"},
    {"id":"alcohol_history","question":"Do you have a history of heavy alcohol consumption?","category":"History"},
]

Q_INDEX: Dict[str, Dict] = {q["id"]: q for q in ALL_QUESTIONS}

DEFAULT_RECS: Dict[str, Dict[str, str]] = {
    "Malaria":                {"home_care":"Rest and drink plenty of fluids","test":"Malaria RDT or blood smear","doctor":"Go to clinic immediately for antimalarial treatment","safety":"Do not delay — malaria can become severe quickly"},
    "Typhoid":                {"home_care":"Rest, eat soft foods, drink clean water only","test":"Widal test or blood culture","doctor":"See a doctor for antibiotic prescription","safety":"Avoid spreading infection — wash hands frequently"},
    "Dengue":                 {"home_care":"Rest and drink fluids — avoid aspirin or ibuprofen","test":"Dengue NS1 antigen test","doctor":"Seek care immediately if you notice bleeding or severe pain","safety":"Aspirin can worsen bleeding in dengue"},
    "Tuberculosis":           {"home_care":"Rest, isolate yourself, keep room well-ventilated","test":"Chest X-ray and sputum test","doctor":"Visit a TB clinic immediately","safety":"TB is contagious — wear a mask and avoid crowded places"},
    "Hepatitis B":            {"home_care":"Rest and avoid alcohol completely","test":"Hepatitis B surface antigen (HBsAg) test","doctor":"See a doctor for antiviral medication evaluation","safety":"Hepatitis B is contagious — avoid sharing needles or razors"},
    "Hepatitis C":            {"home_care":"Rest and avoid alcohol","test":"Hepatitis C antibody test","doctor":"See a specialist for antiviral treatment","safety":"Avoid sharing sharp objects with others"},
    "Hepatitis D":            {"home_care":"Rest and stop alcohol completely","test":"Hepatitis D antibody and liver function tests","doctor":"Seek specialist care urgently","safety":"Hepatitis D only occurs with hepatitis B — urgent care needed"},
    "Pneumonia":              {"home_care":"Rest, keep warm, drink warm fluids","test":"Chest X-ray","doctor":"Visit clinic immediately for antibiotic treatment","safety":"Pneumonia can worsen quickly — do not wait"},
    "Hepatitis A":            {"home_care":"Rest and drink clean water — eat lightly","test":"Hepatitis A IgM antibody test","doctor":"See a doctor if symptoms worsen","safety":"Avoid sharing food or drinks with others"},
    "Hepatitis E":            {"home_care":"Rest and drink clean water only","test":"Hepatitis E IgM antibody test","doctor":"See a doctor — especially important if pregnant","safety":"Very dangerous during pregnancy — seek care urgently if pregnant"},
    "Alcoholic Hepatitis":    {"home_care":"Stop alcohol completely and eat well","test":"Liver function tests (LFTs)","doctor":"Seek medical care urgently","safety":"Continued alcohol use can be fatal with this condition"},
    "Jaundice":               {"home_care":"Rest and drink clean water","test":"Liver function tests and bilirubin level","doctor":"See a doctor to find the underlying cause","safety":"Jaundice is a sign of another condition — do not ignore it"},
    "Chicken Pox":            {"home_care":"Rest, avoid scratching, apply calamine lotion","test":"No test usually needed","doctor":"See a doctor if blisters become infected or fever is very high","safety":"Highly contagious — stay home and avoid contact with others"},
    "Bronchial Asthma":       {"home_care":"Avoid triggers and use your prescribed inhaler","test":"Peak flow measurement or spirometry","doctor":"See a doctor for long-term management plan","safety":"Carry your inhaler at all times"},
    "Urinary Tract Infection":{"home_care":"Drink plenty of water and avoid spicy food","test":"Urine culture and sensitivity test","doctor":"See a doctor for antibiotic prescription","safety":"Do not hold urine — empty your bladder regularly"},
    "Dimorphic Haemorrhoids": {"home_care":"Eat high-fibre foods and avoid straining on the toilet","test":"No test usually needed","doctor":"See a doctor if bleeding continues or worsens","safety":"Avoid sitting for long periods"},
    "Peptic Ulcer Disease":   {"home_care":"Avoid spicy food, alcohol and pain tablets like aspirin","test":"H. pylori breath test or endoscopy if needed","doctor":"See a doctor for antacid or antibiotic treatment","safety":"Avoid aspirin and ibuprofen — they worsen ulcers"},
    "Diabetes":               {"home_care":"Reduce sugar and refined carbohydrates in your diet","test":"Fasting blood glucose and HbA1c test","doctor":"See a doctor for a diabetes management plan","safety":"Monitor your blood sugar regularly if you have a glucometer"},
    "Fungal Infection":       {"home_care":"Keep the affected area dry and clean","test":"No test usually needed","doctor":"Visit a pharmacy for antifungal cream","safety":"Avoid sharing personal items like socks or towels"},
    "Allergy":                {"home_care":"Avoid known triggers and stay indoors during high pollen periods","test":"Allergy skin prick test if symptoms are recurrent","doctor":"See a doctor for antihistamine prescription","safety":"If you have throat swelling or difficulty breathing — go to emergency immediately"},
    "Common Cold":            {"home_care":"Rest and drink warm fluids","test":"No test needed","doctor":"Visit clinic if symptoms persist beyond 7 days","safety":"Wash hands frequently to avoid spreading"},
    "Drug Reaction":          {"home_care":"Stop the suspected medication immediately","test":"No test usually needed","doctor":"See a doctor immediately if rash spreads or breathing is affected","safety":"Seek emergency care if you have throat swelling or difficulty breathing"},
}


# -----------------------------------------------------------------
# ADAPTIVE ENGINE
# -----------------------------------------------------------------
def score_disease(disease: str, answers: dict) -> float:
    score = 0.0
    for symptom in DISEASE_SYMPTOM_MAP.get(disease, []):
        if answers.get(symptom) is True:
            score += 3.0
        elif answers.get(symptom) is False:
            score -= 1.0
    return score


def get_next_question(answers: dict, asked: list) -> Optional[dict]:
    ranked = sorted(DISEASE_SYMPTOM_MAP.keys(), key=lambda d: score_disease(d, answers), reverse=True)
    for disease in ranked[:6]:
        for sym in DISEASE_SYMPTOM_MAP[disease]:
            if sym not in asked:
                q = Q_INDEX.get(sym)
                if q:
                    return q
    for q in ALL_QUESTIONS:
        if q["id"] not in asked:
            return q
    return None


def predict_with_ml(answers: dict) -> dict:
    ensemble = LOADED_MODELS.get("sctd_ensemble")
    le       = LOADED_MODELS.get("sctd_label_encoder")
    cols     = LOADED_MODELS.get("sctd_feature_columns")
    risk_map = LOADED_MODELS.get("sctd_risk_classification") or RISK_MAP

    if ensemble is not None and le is not None and cols is not None:
        try:
            feature_cols: List[str] = list(cols)
            vec = np.array(
                [1.0 if answers.get(c) is True else 0.0 for c in feature_cols],
                dtype=np.float32,
            ).reshape(1, -1)

            proba      = ensemble.predict_proba(vec)[0]
            idx        = int(np.argmax(proba))
            disease    = str(le.inverse_transform([idx])[0])
            confidence = float(proba[idx])

            all_probs: Dict[str, float] = {
                str(le.inverse_transform([i])[0]): round(float(p), 4)
                for i, p in enumerate(proba)
            }
            logger.info("ML prediction: disease=%s confidence=%.3f method=ensemble", disease, confidence)
            return {
                "disease":    disease,
                "confidence": confidence,
                "risk":       risk_map.get(disease, RISK_MAP.get(disease, "Medium")),
                "all_scores": dict(sorted(all_probs.items(), key=lambda x: x[1], reverse=True)),
                "method":     "ml-ensemble",
            }
        except Exception as exc:
            logger.error("ML ensemble failed (%s) — falling back to scoring engine.", exc)

    logger.info("Using scoring engine (ML model unavailable or failed).")
    scores        = {d: score_disease(d, answers) for d in DISEASE_SYMPTOM_MAP}
    sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    best_disease, _ = sorted_scores[0]

    syms       = DISEASE_SYMPTOM_MAP.get(best_disease, [])
    yes_count  = sum(1 for s in syms if answers.get(s) is True)
    confidence = min(0.95, max(0.35, yes_count / max(len(syms), 1)))

    all_scores: Dict[str, float] = {}
    for d, _ in sorted_scores[:8]:
        yc = sum(1 for s in DISEASE_SYMPTOM_MAP.get(d, []) if answers.get(s) is True)
        tc = max(len(DISEASE_SYMPTOM_MAP.get(d, [])), 1)
        all_scores[d] = round(min(0.95, max(0.01, yc / tc)), 4)

    return {
        "disease":    best_disease,
        "confidence": confidence,
        "risk":       RISK_MAP.get(best_disease, "Medium"),
        "all_scores": all_scores,
        "method":     "scoring-engine",
    }


# -----------------------------------------------------------------
# OPENROUTER AI
# -----------------------------------------------------------------
_http_session: Optional[aiohttp.ClientSession] = None
_REQUIRED_AI_KEYS = ("explanation", "home_care", "test", "doctor", "safety")


def _get_http_session() -> aiohttp.ClientSession:
    global _http_session
    if _http_session is None or _http_session.closed:
        connector = aiohttp.TCPConnector(
            limit=100,
            limit_per_host=20,
            ttl_dns_cache=300,
            use_dns_cache=True,
            keepalive_timeout=60,
        )
        _http_session = aiohttp.ClientSession(connector=connector)
    return _http_session


async def call_openrouter(
    disease: str,
    risk: str,
    active_syms: List[str],
    confidence: float,
) -> Optional[dict]:
    if not OPENROUTER_API_KEY:
        logger.info("OPENROUTER_API_KEY not configured — using default recommendations.")
        return None

    sym_text = ", ".join(s.replace("_", " ") for s in active_syms[:14]) or "general symptoms"
    urgency  = {
        "High":   "URGENT — the patient must visit a hospital or clinic today without delay",
        "Medium": "advise the patient to visit a clinic within 1 to 2 days if symptoms persist",
        "Low":    "advise the patient to rest at home and visit a clinic only if symptoms worsen",
    }.get(risk, "advise a clinic visit")

    prompt = (
        "You are a health assistant helping patients in Ghana and West Africa.\n\n"
        "Patient reported symptoms: {sym_text}\n"
        "Most likely condition: {disease} (confidence {confidence_pct}%)\n"
        "Risk level: {risk} — {urgency}\n\n"
        "Reply ONLY with a valid JSON object. No markdown, no code fences, no extra text.\n"
        "Use exactly this format:\n"
        "{{\n"
        '  "explanation": "One clear sentence explaining why these symptoms suggest {disease}.",\n'
        '  "home_care": "One or two simple things the patient can do at home right now.",\n'
        '  "test": "One specific test to confirm the condition, or No test needed if not required.",\n'
        '  "doctor": "One clear instruction about when and where to seek care.",\n'
        '  "safety": "One brief safety warning for High risk, or empty string for Low or Medium."\n'
        "}}\n\n"
        "Rules:\n"
        "- Use plain language. No medical jargon.\n"
        "- Keep every field to one sentence.\n"
        "- For High risk always tell the patient to visit a hospital or clinic immediately.\n"
        "- Never name specific drug brands or dosages."
    ).format(
        sym_text=sym_text,
        disease=disease,
        confidence_pct=round(confidence * 100),
        risk=risk,
        urgency=urgency,
    )

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type":  "application/json",
        "HTTP-Referer":  SITE_URL,
        "X-Title":       SITE_NAME,
    }
    payload = {
        "model": OPENROUTER_MODEL,
        "messages": [
            {
                "role":    "system",
                "content": (
                    "You are a responsible clinical AI assistant for a tropical disease symptom checker. "
                    "Always respond with a valid JSON object only — no markdown, no code fences. "
                    "Never prescribe specific drugs or dosages."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "max_tokens":  400,
        "temperature": 0.15,
        "top_p":       0.9,
    }

    timeout = aiohttp.ClientTimeout(
        connect=OPENROUTER_CONNECT_TIMEOUT,
        sock_read=OPENROUTER_READ_TIMEOUT,
        total=OPENROUTER_TOTAL_TIMEOUT,
    )
    session = _get_http_session()
    raw     = ""

    for attempt in range(1, OPENROUTER_MAX_RETRIES + 1):
        try:
            t0 = time.monotonic()
            async with session.post(
                OPENROUTER_URL,
                headers=headers,
                json=payload,
                timeout=timeout,
            ) as resp:
                elapsed = time.monotonic() - t0

                if resp.status == 429:
                    retry_after = float(resp.headers.get("Retry-After", OPENROUTER_RETRY_DELAY * attempt))
                    logger.warning(
                        "OpenRouter rate-limited (attempt %d/%d). Waiting %.1fs.",
                        attempt, OPENROUTER_MAX_RETRIES, retry_after,
                    )
                    await asyncio.sleep(retry_after)
                    continue

                if resp.status >= 500:
                    body = await resp.text()
                    logger.warning(
                        "OpenRouter server error %d (attempt %d/%d, %.1fs): %s",
                        resp.status, attempt, OPENROUTER_MAX_RETRIES, elapsed, body[:300],
                    )
                    if attempt < OPENROUTER_MAX_RETRIES:
                        await asyncio.sleep(OPENROUTER_RETRY_DELAY * attempt)
                    continue

                if resp.status != 200:
                    body = await resp.text()
                    logger.warning(
                        "OpenRouter HTTP %d (attempt %d/%d, %.1fs): %s",
                        resp.status, attempt, OPENROUTER_MAX_RETRIES, elapsed, body[:300],
                    )
                    return None

                data = await resp.json(content_type=None)
                raw  = data["choices"][0]["message"]["content"].strip()

                if raw.startswith("```"):
                    parts = raw.split("```")
                    raw   = parts[1] if len(parts) > 1 else raw
                    if raw.startswith("json"):
                        raw = raw[4:]
                raw = raw.strip()

                result: dict = json.loads(raw)

                for key in _REQUIRED_AI_KEYS:
                    if key not in result or not isinstance(result[key], str):
                        result[key] = ""

                logger.info(
                    "OpenRouter OK (attempt %d/%d, %.1fs) disease=%s model=%s",
                    attempt, OPENROUTER_MAX_RETRIES, elapsed, disease, OPENROUTER_MODEL,
                )
                return result

        except json.JSONDecodeError as exc:
            logger.warning(
                "OpenRouter JSON parse error (attempt %d/%d): %s | raw=%r",
                attempt, OPENROUTER_MAX_RETRIES, exc, raw[:200],
            )
            if attempt < OPENROUTER_MAX_RETRIES:
                await asyncio.sleep(OPENROUTER_RETRY_DELAY)

        except asyncio.TimeoutError:
            logger.warning(
                "OpenRouter timed out (attempt %d/%d, total=%.0fs).",
                attempt, OPENROUTER_MAX_RETRIES, OPENROUTER_TOTAL_TIMEOUT,
            )
            if attempt < OPENROUTER_MAX_RETRIES:
                await asyncio.sleep(OPENROUTER_RETRY_DELAY)

        except aiohttp.ClientError as exc:
            logger.warning(
                "OpenRouter connection error (attempt %d/%d): %s",
                attempt, OPENROUTER_MAX_RETRIES, exc,
            )
            if attempt < OPENROUTER_MAX_RETRIES:
                await asyncio.sleep(OPENROUTER_RETRY_DELAY * attempt)

        except Exception as exc:
            logger.error(
                "OpenRouter unexpected error (attempt %d/%d): %s",
                attempt, OPENROUTER_MAX_RETRIES, exc,
            )
            break

    logger.warning(
        "All %d OpenRouter attempts failed for disease=%s — using default recommendations.",
        OPENROUTER_MAX_RETRIES, disease,
    )
    return None


def build_recommendation(disease: str, risk: str, ai_result: Optional[dict]) -> dict:
    default = DEFAULT_RECS.get(disease, {
        "home_care": "Rest and stay well hydrated.",
        "test":      "Consult a healthcare provider for appropriate tests.",
        "doctor":    "Visit a clinic if symptoms persist or worsen.",
        "safety":    "Seek emergency care if symptoms become severe." if risk == "High" else "",
    })

    if ai_result:
        return {
            "home_care":   (ai_result.get("home_care")   or "").strip() or default.get("home_care", ""),
            "test":        (ai_result.get("test")        or "").strip() or default.get("test", ""),
            "doctor":      (ai_result.get("doctor")      or "").strip() or default.get("doctor", ""),
            "safety":      (ai_result.get("safety")      or "").strip() or default.get("safety", ""),
            "explanation": (ai_result.get("explanation") or "").strip() or f"Your symptoms are consistent with {disease}.",
        }

    return {**default, "explanation": f"Your symptoms are consistent with {disease}."}


# -----------------------------------------------------------------
# PYDANTIC SCHEMAS
# -----------------------------------------------------------------
class RegisterRequest(BaseModel):
    email:    str
    password: str
    name:     str
    age:      Optional[str] = None
    gender:   Optional[str] = None

    @validator("email")
    def _email(cls, v): return v.strip().lower()

    @validator("password")
    def _pw(cls, v):
        if len(v) < 6:
            raise ValueError("Password must be at least 6 characters.")
        return v

    @validator("name")
    def _name(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("Name must not be empty.")
        return v


class LoginRequest(BaseModel):
    email:    str
    password: str

    @validator("email")
    def _email(cls, v): return v.strip().lower()


class AnswerRequest(BaseModel):
    question_id: str
    answer:      bool


class ProfileUpdate(BaseModel):
    name:   Optional[str] = None
    age:    Optional[str] = None
    gender: Optional[str] = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password:     str

    @validator("new_password")
    def _pw(cls, v):
        if len(v) < 8:
            raise ValueError("New password must be at least 8 characters.")
        return v


# -----------------------------------------------------------------
# AUTH HELPERS
# -----------------------------------------------------------------
security = HTTPBearer()


def create_token(user_id: int) -> str:
    exp = datetime.utcnow() + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": str(user_id), "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)


def verify_token(creds: HTTPAuthorizationCredentials = Depends(security)) -> int:
    try:
        payload = jwt.decode(creds.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        sub = payload.get("sub")
        if sub is None:
            raise HTTPException(status_code=401, detail="Invalid token payload.")
        return int(sub)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")


def hash_pw(pw: str) -> str:
    salt   = secrets.token_hex(16)
    hashed = hashlib.sha256((salt + pw).encode()).hexdigest()
    return f"{salt}:{hashed}"


def verify_pw(pw: str, stored: str) -> bool:
    try:
        salt, hashed = stored.split(":", 1)
        return secrets.compare_digest(hashlib.sha256((salt + pw).encode()).hexdigest(), hashed)
    except Exception:
        return False


# -----------------------------------------------------------------
# APP STARTUP / SHUTDOWN
# -----------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    load_ml_models()
    _get_http_session()

    ml_status = (
        "ml-ensemble ready"
        if all(k in LOADED_MODELS for k in _REQUIRED_MODEL_KEYS)
        else "scoring-engine (ML models not found)"
    )
    logger.info("TropiCare started | prediction=%s", ml_status)
    logger.info(
        "OpenRouter | enabled=%s | model=%s | total_timeout=%.0fs | retries=%d",
        bool(OPENROUTER_API_KEY), OPENROUTER_MODEL,
        OPENROUTER_TOTAL_TIMEOUT, OPENROUTER_MAX_RETRIES,
    )
    yield

    global _http_session
    if _http_session and not _http_session.closed:
        await _http_session.close()
        logger.info("HTTP session closed.")


# -----------------------------------------------------------------
# FASTAPI APP
# -----------------------------------------------------------------
app = FastAPI(
    title="TropiCare API",
    version="2.0.0",
    description="KNUST Final Year Project — AI Tropical Disease Symptom Checker",
    lifespan=lifespan,
)

ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Process-Time"],
)


@app.middleware("http")
async def _process_time(request: Request, call_next):
    t0       = time.monotonic()
    response = await call_next(request)
    response.headers["X-Process-Time"] = f"{(time.monotonic() - t0) * 1000:.1f}ms"
    return response


@app.exception_handler(Exception)
async def _global_error(request: Request, exc: Exception):
    logger.error("Unhandled exception on %s: %s", request.url, exc, exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "An internal server error occurred."})


# -----------------------------------------------------------------
# ROUTES — Health
# -----------------------------------------------------------------
@app.get("/api/v1/health")
async def health():
    return {
        "status":             "healthy",
        "timestamp":          datetime.utcnow().isoformat(),
        "prediction_engine":  "ml-ensemble" if all(k in LOADED_MODELS for k in _REQUIRED_MODEL_KEYS) else "scoring-engine",
        "ml_models_loaded":   list(LOADED_MODELS.keys()),
        "openrouter_enabled": bool(OPENROUTER_API_KEY),
        "openrouter_model":   OPENROUTER_MODEL,
    }


# -----------------------------------------------------------------
# ROUTES — Auth
# -----------------------------------------------------------------
@app.post("/api/v1/auth/register", status_code=201)
async def register(req: RegisterRequest, db: Session = Depends(get_db)):
    if db.query(UserModel).filter(UserModel.email == req.email).first():
        raise HTTPException(status_code=400, detail="Email already registered.")
    user = UserModel(
        email=req.email, name=req.name,
        pw_hash=hash_pw(req.password), age=req.age, gender=req.gender,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {
        "access_token": create_token(user.id),
        "token_type":   "bearer",
        "user":         {"id": user.id, "email": user.email, "name": user.name},
    }


@app.post("/api/v1/auth/login")
async def login(req: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(UserModel).filter(UserModel.email == req.email).first()
    if not user or not user.pw_hash or not verify_pw(req.password, user.pw_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    return {
        "access_token": create_token(user.id),
        "token_type":   "bearer",
        "user":         {"id": user.id, "email": user.email, "name": user.name},
    }


# -----------------------------------------------------------------
# ROUTES — Assessment
# -----------------------------------------------------------------
@app.post("/api/v1/symptoms/start", status_code=201)
async def start_assessment(user_id: int = Depends(verify_token), db: Session = Depends(get_db)):
    sid     = str(uuid.uuid4())
    session = SessionModel(
        session_id=sid, user_id=user_id,
        answers=_dump_json({}), asked_questions=_dump_json([]),
    )
    db.add(session)
    db.commit()
    return {"session_id": sid, "first_question": ALL_QUESTIONS[0], "total_questions": 15}


@app.post("/api/v1/symptoms/next")
async def next_question(
    session_id: str, req: AnswerRequest,
    user_id: int = Depends(verify_token), db: Session = Depends(get_db),
):
    s = db.query(SessionModel).filter(
        SessionModel.session_id == session_id, SessionModel.user_id == user_id,
    ).first()
    if not s:
        raise HTTPException(status_code=404, detail="Session not found.")

    answers = _load_json(s.answers, {})
    asked   = _load_json(s.asked_questions, [])

    if req.question_id not in Q_INDEX:
        raise HTTPException(status_code=400, detail=f"Unknown question_id: {req.question_id}")

    answers[req.question_id] = req.answer
    if req.question_id not in asked:
        asked.append(req.question_id)

    s.answers         = _dump_json(answers)
    s.asked_questions = _dump_json(asked)
    db.commit()

    if len(asked) >= 15:
        s.completed = True
        db.commit()
        return {"completed": True}

    next_q = get_next_question(answers, asked)
    if not next_q:
        s.completed = True
        db.commit()
        return {"completed": True}

    return {"completed": False, "next_question": next_q}


@app.post("/api/v1/diagnosis/analyze")
async def analyze(
    session_id: str,
    background_tasks: BackgroundTasks,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    s = db.query(SessionModel).filter(
        SessionModel.session_id == session_id, SessionModel.user_id == user_id,
    ).first()
    if not s:
        raise HTTPException(status_code=404, detail="Session not found.")

    answers     = _load_json(s.answers, {})
    pred        = predict_with_ml(answers)
    active_syms = [k for k, v in answers.items() if v is True]

    ai_result: Optional[dict] = await call_openrouter(
        pred["disease"], pred["risk"], active_syms, pred["confidence"]
    )

    rec = build_recommendation(pred["disease"], pred["risk"], ai_result)

    diag = DiagnosisModel(
        user_id         = user_id,
        session_id      = session_id,
        disease         = pred["disease"],
        risk            = pred["risk"],
        confidence      = pred["confidence"],
        answers         = _dump_json(answers),
        active_symptoms = _dump_json(active_syms),
        rec_home_care   = rec["home_care"],
        rec_test        = rec["test"],
        rec_doctor      = rec["doctor"],
        rec_safety      = rec.get("safety", ""),
        ai_explanation  = rec.get("explanation", ""),
        ml_scores       = _dump_json(pred.get("all_scores", {})),
        ai_used         = ai_result is not None,
    )
    db.add(diag)
    db.commit()
    db.refresh(diag)

    return {
        "id":          diag.id,
        "disease":     pred["disease"],
        "confidence":  pred["confidence"],
        "risk":        pred["risk"],
        "explanation": rec.get("explanation", ""),
        "all_scores":  pred.get("all_scores", {}),
        "recommendation": {
            "home_care": rec["home_care"],
            "test":      rec["test"],
            "doctor":    rec["doctor"],
            "safety":    rec.get("safety", ""),
        },
        "method":  pred["method"],
        "ai_used": ai_result is not None,
    }


# -----------------------------------------------------------------
# ROUTES — Patient History
# -----------------------------------------------------------------
@app.get("/api/v1/patient/history")
async def get_history(user_id: int = Depends(verify_token), db: Session = Depends(get_db)):
    rows = (
        db.query(DiagnosisModel)
        .filter(DiagnosisModel.user_id == user_id)
        .order_by(DiagnosisModel.created_at.desc())
        .limit(100)
        .all()
    )
    user         = db.query(UserModel).filter(UserModel.id == user_id).first()
    patient_name = user.name if user else "Unknown"
    return [
        {
            "id":           d.id,
            "disease":      d.disease,
            "risk":         d.risk,
            "confidence":   d.confidence,
            "created_at":   d.created_at.isoformat(),
            "patient_name": patient_name,
            "recommendation": {
                "home_care": d.rec_home_care, "test": d.rec_test,
                "doctor":    d.rec_doctor,    "safety": d.rec_safety,
            },
            "explanation":     d.ai_explanation,
            "active_symptoms": _load_json(d.active_symptoms, []),
        }
        for d in rows
    ]


@app.get("/api/v1/patient/history/{diag_id}")
async def get_diagnosis(diag_id: int, user_id: int = Depends(verify_token), db: Session = Depends(get_db)):
    d = db.query(DiagnosisModel).filter(
        DiagnosisModel.id == diag_id, DiagnosisModel.user_id == user_id,
    ).first()
    if not d:
        raise HTTPException(status_code=404, detail="Not found.")
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    return {
        "id":              d.id,
        "disease":         d.disease,
        "risk":            d.risk,
        "confidence":      d.confidence,
        "created_at":      d.created_at.isoformat(),
        "patient_name":    user.name if user else "Unknown",
        "answers":         _load_json(d.answers, {}),
        "active_symptoms": _load_json(d.active_symptoms, []),
        "recommendation": {
            "home_care": d.rec_home_care, "test": d.rec_test,
            "doctor":    d.rec_doctor,    "safety": d.rec_safety,
        },
        "explanation": d.ai_explanation,
        "ml_scores":   _load_json(d.ml_scores, {}),
    }


# -----------------------------------------------------------------
# ROUTES — User Profile
# -----------------------------------------------------------------
@app.get("/api/v1/user/profile")
async def get_profile(user_id: int = Depends(verify_token), db: Session = Depends(get_db)):
    u = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found.")
    count = db.query(DiagnosisModel).filter(DiagnosisModel.user_id == user_id).count()
    high  = db.query(DiagnosisModel).filter(DiagnosisModel.user_id == user_id, DiagnosisModel.risk == "High").count()
    return {
        "id":               u.id,
        "email":            u.email,
        "name":             u.name,
        "age":              u.age,
        "gender":           u.gender,
        "joined_at":        u.created_at.isoformat(),
        "assessment_count": count,
        "high_risk_count":  high,
    }


@app.put("/api/v1/user/profile")
async def update_profile(req: ProfileUpdate, user_id: int = Depends(verify_token), db: Session = Depends(get_db)):
    u = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found.")
    if req.name   is not None: u.name   = req.name
    if req.age    is not None: u.age    = req.age
    if req.gender is not None: u.gender = req.gender
    db.commit()
    return {"id": u.id, "name": u.name, "age": u.age, "gender": u.gender}


@app.put("/api/v1/user/change-password")
async def change_password(req: ChangePasswordRequest, user_id: int = Depends(verify_token), db: Session = Depends(get_db)):
    u = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found.")
    if not u.pw_hash or not verify_pw(req.current_password, u.pw_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect.")
    u.pw_hash = hash_pw(req.new_password)
    db.commit()
    return {"message": "Password updated successfully."}


@app.delete("/api/v1/user/account")
async def delete_account(user_id: int = Depends(verify_token), db: Session = Depends(get_db)):
    db.query(DiagnosisModel).filter(DiagnosisModel.user_id == user_id).delete()
    db.query(SessionModel).filter(SessionModel.user_id == user_id).delete()
    db.query(UserModel).filter(UserModel.id == user_id).delete()
    db.commit()
    return {"message": "Account deleted."}


# -----------------------------------------------------------------
# ROUTES — Admin
# -----------------------------------------------------------------
@app.get("/api/v1/admin/stats")
async def admin_stats(db: Session = Depends(get_db)):
    return {
        "total_users":     db.query(UserModel).count(),
        "total_diagnoses": db.query(DiagnosisModel).count(),
        "high_risk":       db.query(DiagnosisModel).filter(DiagnosisModel.risk == "High").count(),
        "medium_risk":     db.query(DiagnosisModel).filter(DiagnosisModel.risk == "Medium").count(),
        "low_risk":        db.query(DiagnosisModel).filter(DiagnosisModel.risk == "Low").count(),
    }


@app.get("/api/v1/admin/all-records")
async def all_records(db: Session = Depends(get_db)):
    rows = (
        db.query(DiagnosisModel)
        .order_by(DiagnosisModel.created_at.desc())
        .limit(500)
        .all()
    )
    user_ids = {d.user_id for d in rows}
    users    = {u.id: u.name for u in db.query(UserModel).filter(UserModel.id.in_(user_ids)).all()}
    return [
        {
            "id":           d.id,
            "disease":      d.disease,
            "risk":         d.risk,
            "confidence":   d.confidence,
            "patient_name": users.get(d.user_id, "Unknown"),
            "created_at":   d.created_at.isoformat(),
        }
        for d in rows
    ]


@app.delete("/api/v1/admin/clear-database")
async def clear_database(db: Session = Depends(get_db)):
    deleted = db.query(DiagnosisModel).delete()
    db.query(SessionModel).delete()
    db.commit()
    return {"message": f"Cleared {deleted} diagnosis records."}


@app.delete("/api/v1/admin/record/{diag_id}")
async def delete_record(diag_id: int, db: Session = Depends(get_db)):
    d = db.query(DiagnosisModel).filter(DiagnosisModel.id == diag_id).first()
    if not d:
        raise HTTPException(status_code=404, detail="Not found.")
    db.delete(d)
    db.commit()
    return {"message": "Record deleted."}


# -----------------------------------------------------------------
# ENTRYPOINT
# -----------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", 8000)),
        reload=False,
        workers=int(os.getenv("WORKERS", 1)),
    )
