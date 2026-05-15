"""
TropiCare API — KNUST Final Year Project
=========================================
Every route in this file maps 1-to-1 with a fetch() call in App.jsx.
No route is missing. No response shape deviates from what the frontend expects.

Run locally:
    uvicorn main:app --reload --port 8000

Deploy (Render / Railway):
    uvicorn main:app --host 0.0.0.0 --port $PORT

Required .env variables:
    SECRET_KEY=<any long random string>
    OPENROUTER_API_KEY=sk-or-...       (optional — AI recommendations)
    OPENROUTER_MODEL=mistralai/mistral-7b-instruct:free
    DATABASE_URL=sqlite:///./tropicare.db
    ALLOWED_ORIGINS=*
    SITE_URL=http://localhost:8000
    SITE_NAME=TropiCare
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import secrets
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import aiohttp
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
)
from sqlalchemy.orm import Session, declarative_base, sessionmaker

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────────────────────────────────────
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("tropicare")

SECRET_KEY               = os.getenv("SECRET_KEY", "tropicare-dev-secret-change-in-production-2024")
ALGORITHM                = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_URL     = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODEL   = os.getenv("OPENROUTER_MODEL", "mistralai/mistral-7b-instruct:free")

SITE_URL     = os.getenv("SITE_URL", "http://localhost:8000")
SITE_NAME    = os.getenv("SITE_NAME", "TropiCare")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./tropicare.db")

ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",")]

# ─────────────────────────────────────────────────────────────────────────────
# DATABASE SETUP
# ─────────────────────────────────────────────────────────────────────────────
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine       = create_engine(DATABASE_URL, connect_args=connect_args, echo=False)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base         = declarative_base()


# ──────────────────────────────────────
# ORM MODELS
# ──────────────────────────────────────
class UserModel(Base):
    __tablename__ = "users"

    id         = Column(Integer, primary_key=True, index=True)
    email      = Column(String(255), unique=True, index=True, nullable=False)
    name       = Column(String(255), nullable=False)
    pw_hash    = Column(String(512), nullable=False)
    age        = Column(String(10),  nullable=True)
    gender     = Column(String(20),  nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class AssessmentSession(Base):
    __tablename__ = "assessment_sessions"

    id              = Column(Integer, primary_key=True, index=True)
    session_id      = Column(String(64), unique=True, index=True, nullable=False)
    user_id         = Column(Integer, ForeignKey("users.id"), nullable=False)
    answers         = Column(Text, default="{}")
    asked_questions = Column(Text, default="[]")
    completed       = Column(Boolean, default=False)
    created_at      = Column(DateTime, default=datetime.utcnow)


class DiagnosisRecord(Base):
    __tablename__ = "diagnoses"

    id              = Column(Integer, primary_key=True, index=True)
    user_id         = Column(Integer, ForeignKey("users.id"), nullable=False)
    session_id      = Column(String(64), index=True, nullable=True)
    disease         = Column(String(100), nullable=False)
    risk            = Column(String(20),  nullable=False)
    confidence      = Column(Float,       nullable=False)
    answers         = Column(Text, default="{}")
    active_symptoms = Column(Text, default="[]")
    rec_home_care   = Column(Text, nullable=True)
    rec_test        = Column(Text, nullable=True)
    rec_doctor      = Column(Text, nullable=True)
    rec_safety      = Column(Text, nullable=True)
    explanation     = Column(Text, nullable=True)
    all_scores      = Column(Text, default="{}")
    method          = Column(String(30), default="scoring")
    ai_used         = Column(Boolean, default=False)
    created_at      = Column(DateTime, default=datetime.utcnow)


# ─────────────────────────────────────────────────────────────────────────────
# JSON HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def _load(value: Optional[str], default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


# ─────────────────────────────────────────────────────────────────────────────
# DISEASE / SYMPTOM DATA  (mirrors App.jsx exactly)
# ─────────────────────────────────────────────────────────────────────────────
RISK_MAP: Dict[str, str] = {
    "Malaria":                   "High",
    "Typhoid":                   "High",
    "Dengue":                    "High",
    "Tuberculosis":              "High",
    "Hepatitis B":               "High",
    "Hepatitis C":               "High",
    "Hepatitis D":               "High",
    "Pneumonia":                 "High",
    "Hepatitis A":               "Medium",
    "Hepatitis E":               "Medium",
    "Alcoholic Hepatitis":       "Medium",
    "Jaundice":                  "Medium",
    "Chicken Pox":               "Medium",
    "Bronchial Asthma":          "Medium",
    "Urinary Tract Infection":   "Medium",
    "Dimorphic Haemorrhoids":    "Medium",
    "Peptic Ulcer Disease":      "Medium",
    "Diabetes":                  "Medium",
    "Fungal Infection":          "Low",
    "Allergy":                   "Low",
    "Common Cold":               "Low",
    "Drug Reaction":             "Low",
}

DISEASE_SYMPTOM_MAP: Dict[str, List[str]] = {
    "Malaria":              ["high_fever","chills","sweating","headache","muscle_pain","vomiting","fatigue","joint_pain","nausea","malaise","loss_of_appetite","fast_heart_rate","confusion","coma"],
    "Typhoid":              ["high_fever","headache","fatigue","loss_of_appetite","vomiting","constipation","toxic_look","abdominal_pain","diarrhoea","loss_of_appetite_fever","fast_heart_rate","red_spots_over_body","confusion"],
    "Dengue":               ["high_fever","headache","pain_behind_eyes","muscle_pain","joint_pain","skin_rash","red_spots_over_body","vomiting","fatigue","malaise","fast_heart_rate","swelled_lymph_nodes"],
    "Tuberculosis":         ["cough","blood_in_sputum","weight_loss","fatigue","sweating","chest_pain","breathlessness","phlegm","loss_of_appetite","high_fever","swollen_lymph_neck","family_history"],
    "Hepatitis B":          ["yellowing_of_eyes","yellowish_skin","dark_urine","fatigue","blood_transfusion","unsterile_injections","abdominal_pain","nausea","loss_of_appetite","internal_itching","acute_liver_failure"],
    "Hepatitis C":          ["yellowing_of_eyes","yellowish_skin","fatigue","nausea","loss_of_appetite","blood_transfusion","dark_urine","weight_loss","internal_itching","abdominal_pain"],
    "Hepatitis D":          ["yellowing_of_eyes","yellowish_skin","dark_urine","fatigue","acute_liver_failure","fluid_overload","blood_transfusion","unsterile_injections","swelling_stomach"],
    "Pneumonia":            ["cough","breathlessness","chest_pain","high_fever","rusty_sputum","chills","fatigue","phlegm","loss_of_appetite","malaise"],
    "Hepatitis A":          ["yellowing_of_eyes","yellowish_skin","dark_urine","fatigue","loss_of_appetite","nausea","abdominal_pain","vomiting","mild_fever","malaise","distension_of_abdomen"],
    "Hepatitis E":          ["yellowing_of_eyes","yellowish_skin","fatigue","loss_of_appetite","nausea","mild_fever","yellow_urine","abdominal_pain","malaise"],
    "Alcoholic Hepatitis":  ["yellowing_of_eyes","vomiting","abdominal_pain","alcohol_history","swelling_stomach","fluid_overload","yellowish_skin","acute_liver_failure","distension_of_abdomen"],
    "Jaundice":             ["yellowing_of_eyes","yellowish_skin","dark_urine","yellow_urine","itching","fatigue","abdominal_pain","internal_itching","fluid_overload","distension_of_abdomen"],
    "Chicken Pox":          ["skin_rash","itching","red_spots_over_body","mild_fever","fatigue","headache","loss_of_appetite","nodal_skin_eruptions"],
    "Bronchial Asthma":     ["breathlessness","cough","phlegm","chest_pain","fatigue"],
    "Urinary Tract Infection": ["burning_micturition","urinating_frequently","continuous_feel_of_urine","bladder_discomfort","foul_smell_of_urine","spotting_urination","back_pain"],
    "Dimorphic Haemorrhoids": ["bloody_stool","pain_anal_region","pain_bowel_movements","constipation","passage_of_gases","irritation_anus"],
    "Peptic Ulcer Disease": ["stomach_pain","indigestion","vomiting","loss_of_appetite","nausea","stomach_bleeding","abdominal_pain","passage_of_gases"],
    "Diabetes":             ["polyuria","excessive_hunger","irregular_sugar_level","weight_loss","fatigue","blurred_vision","urinating_frequently","increased_appetite","family_history","obesity"],
    "Fungal Infection":     ["itching","skin_rash","dischromic_patches","nodal_skin_eruptions","irritation_anus"],
    "Allergy":              ["continuous_sneezing","runny_nose","itching","watering_from_eyes","skin_rash","redness_of_eyes","throat_irritation","mild_fever","joint_pain"],
    "Common Cold":          ["runny_nose","continuous_sneezing","throat_irritation","mild_fever","cough","headache","sinus_pressure","watering_from_eyes","loss_of_smell"],
    "Drug Reaction":        ["itching","skin_rash","red_spots_over_body","fatigue","nausea","diarrhoea"],
}

ALL_QUESTIONS: List[Dict[str, str]] = [
    {"id":"high_fever","question":"Do you have a high fever?","category":"General"},
    {"id":"mild_fever","question":"Do you have a mild fever?","category":"General"},
    {"id":"fatigue","question":"Do you feel unusually tired or weak?","category":"General"},
    {"id":"malaise","question":"Do you feel generally unwell?","category":"General"},
    {"id":"chills","question":"Do you have chills or shivering?","category":"General"},
    {"id":"sweating","question":"Do you have episodes of sweating?","category":"General"},
    {"id":"headache","question":"Do you have headaches?","category":"General"},
    {"id":"muscle_pain","question":"Do you have muscle pain or body aches?","category":"General"},
    {"id":"joint_pain","question":"Do you have joint pain?","category":"General"},
    {"id":"back_pain","question":"Do you have back pain?","category":"General"},
    {"id":"cough","question":"Do you have a cough?","category":"Respiratory"},
    {"id":"phlegm","question":"Are you coughing up phlegm or mucus?","category":"Respiratory"},
    {"id":"rusty_sputum","question":"Are you coughing up rusty or brown-coloured sputum?","category":"Respiratory"},
    {"id":"blood_in_sputum","question":"Are you coughing up blood?","category":"Respiratory"},
    {"id":"breathlessness","question":"Do you have difficulty breathing?","category":"Respiratory"},
    {"id":"chest_pain","question":"Do you have chest pain?","category":"Respiratory"},
    {"id":"runny_nose","question":"Do you have a runny nose?","category":"Respiratory"},
    {"id":"continuous_sneezing","question":"Do you sneeze frequently?","category":"Respiratory"},
    {"id":"throat_irritation","question":"Do you have a sore or irritated throat?","category":"Respiratory"},
    {"id":"sinus_pressure","question":"Do you have sinus pressure or nasal congestion?","category":"Respiratory"},
    {"id":"watering_from_eyes","question":"Do you have watery eyes?","category":"Respiratory"},
    {"id":"loss_of_smell","question":"Have you lost your sense of smell?","category":"Respiratory"},
    {"id":"nausea","question":"Do you feel nauseous?","category":"Digestive"},
    {"id":"vomiting","question":"Have you been vomiting?","category":"Digestive"},
    {"id":"diarrhoea","question":"Do you have diarrhoea?","category":"Digestive"},
    {"id":"stomach_pain","question":"Do you have stomach pain?","category":"Digestive"},
    {"id":"abdominal_pain","question":"Do you have abdominal or belly pain?","category":"Digestive"},
    {"id":"indigestion","question":"Do you have indigestion or acidity?","category":"Digestive"},
    {"id":"distension_of_abdomen","question":"Do you feel bloated or have a distended abdomen?","category":"Digestive"},
    {"id":"constipation","question":"Do you have constipation?","category":"Digestive"},
    {"id":"passage_of_gases","question":"Do you have excessive gas?","category":"Digestive"},
    {"id":"bloody_stool","question":"Do you notice blood in your stool?","category":"Digestive"},
    {"id":"loss_of_appetite","question":"Have you lost your appetite?","category":"Digestive"},
    {"id":"stomach_bleeding","question":"Do you have stomach bleeding?","category":"Digestive"},
    {"id":"yellowish_skin","question":"Is your skin yellowish or jaundiced?","category":"Liver"},
    {"id":"yellowing_of_eyes","question":"Are the whites of your eyes turning yellow?","category":"Liver"},
    {"id":"dark_urine","question":"Is your urine dark or tea-coloured?","category":"Liver"},
    {"id":"yellow_urine","question":"Is your urine unusually yellow?","category":"Liver"},
    {"id":"internal_itching","question":"Do you experience internal itching?","category":"Liver"},
    {"id":"acute_liver_failure","question":"Do you have signs of acute liver failure?","category":"Liver"},
    {"id":"fluid_overload","question":"Do you have abnormal body swelling or fluid retention?","category":"Liver"},
    {"id":"itching","question":"Do you have itchy skin?","category":"Skin"},
    {"id":"skin_rash","question":"Do you have a skin rash?","category":"Skin"},
    {"id":"red_spots_over_body","question":"Do you have red spots on your body?","category":"Skin"},
    {"id":"nodal_skin_eruptions","question":"Do you have nodules or skin eruptions?","category":"Skin"},
    {"id":"dischromic_patches","question":"Do you have discoloured patches on your skin?","category":"Skin"},
    {"id":"redness_of_eyes","question":"Do you have red or irritated eyes?","category":"Eyes"},
    {"id":"blurred_vision","question":"Do you have blurred or distorted vision?","category":"Eyes"},
    {"id":"pain_behind_eyes","question":"Do you have pain behind your eyes?","category":"Eyes"},
    {"id":"burning_micturition","question":"Do you feel a burning sensation when urinating?","category":"Urinary"},
    {"id":"urinating_frequently","question":"Do you urinate much more than usual?","category":"Urinary"},
    {"id":"continuous_feel_of_urine","question":"Do you have a persistent urge to urinate?","category":"Urinary"},
    {"id":"bladder_discomfort","question":"Do you have bladder discomfort?","category":"Urinary"},
    {"id":"foul_smell_of_urine","question":"Does your urine have an unusual smell?","category":"Urinary"},
    {"id":"spotting_urination","question":"Do you notice spotting during urination?","category":"Urinary"},
    {"id":"pain_anal_region","question":"Do you have pain in your anal region?","category":"Rectal"},
    {"id":"pain_bowel_movements","question":"Do you have pain during bowel movements?","category":"Rectal"},
    {"id":"irritation_anus","question":"Do you have irritation around the anus?","category":"Rectal"},
    {"id":"restlessness","question":"Do you feel restless or agitated?","category":"Neurological"},
    {"id":"mood_swings","question":"Have you been experiencing mood swings?","category":"Neurological"},
    {"id":"confusion","question":"Do you feel confused or disoriented?","category":"Neurological"},
    {"id":"coma","question":"Have you experienced any loss of consciousness?","category":"Neurological"},
    {"id":"excessive_hunger","question":"Are you excessively hungry?","category":"Metabolic"},
    {"id":"increased_appetite","question":"Has your appetite increased significantly?","category":"Metabolic"},
    {"id":"irregular_sugar_level","question":"Do you have an irregular blood sugar level?","category":"Metabolic"},
    {"id":"polyuria","question":"Do you urinate in unusually large amounts?","category":"Metabolic"},
    {"id":"dehydration","question":"Do you feel severely dehydrated?","category":"Metabolic"},
    {"id":"weight_loss","question":"Have you experienced unexplained weight loss?","category":"Metabolic"},
    {"id":"obesity","question":"Are you significantly overweight?","category":"Metabolic"},
    {"id":"swelled_lymph_nodes","question":"Do you have swollen lymph nodes?","category":"Infection"},
    {"id":"swelling_stomach","question":"Is your stomach area swollen?","category":"Infection"},
    {"id":"fast_heart_rate","question":"Do you have a fast or irregular heartbeat?","category":"Infection"},
    {"id":"toxic_look","question":"Do you look or feel severely ill?","category":"Infection"},
    {"id":"swollen_lymph_neck","question":"Do you have swollen lymph nodes in the neck or armpit?","category":"Infection"},
    {"id":"loss_of_appetite_fever","question":"Have you lost your appetite alongside a fever?","category":"Infection"},
    {"id":"family_history","question":"Do you have a family history of this condition?","category":"History"},
    {"id":"blood_transfusion","question":"Have you received a blood transfusion recently?","category":"History"},
    {"id":"unsterile_injections","question":"Have you been injected with unsterile equipment?","category":"History"},
    {"id":"alcohol_history","question":"Do you have a history of heavy alcohol use?","category":"History"},
]

Q_INDEX: Dict[str, Dict[str, str]] = {q["id"]: q for q in ALL_QUESTIONS}

# Detailed per-disease default recommendations
DEFAULT_RECS: Dict[str, Dict[str, str]] = {
    "Malaria": {
        "home_care": "Rest completely, drink clean water or oral rehydration salts, and keep the patient cool with a damp cloth if the fever is very high.",
        "test": "Malaria Rapid Diagnostic Test (RDT) or blood smear microscopy.",
        "doctor": "Visit a clinic or hospital immediately. Malaria requires prescription antimalarial medication.",
        "safety": "Do not wait — malaria can become life-threatening within 24 to 48 hours if untreated.",
    },
    "Typhoid": {
        "home_care": "Rest, eat soft easily digestible foods, and drink only boiled or bottled water. Avoid raw vegetables and street food.",
        "test": "Widal test or blood/stool culture for definitive diagnosis.",
        "doctor": "See a doctor for antibiotic prescription. Typhoid is treatable but requires the correct antibiotic.",
        "safety": "Wash hands thoroughly after using the toilet to avoid spreading infection to others in the household.",
    },
    "Dengue": {
        "home_care": "Rest completely and drink plenty of fluids including water and oral rehydration salts. Monitor platelet count daily if possible.",
        "test": "Dengue NS1 antigen test (best in first 5 days) or dengue IgM/IgG antibody test.",
        "doctor": "Go to a clinic or hospital. If you notice bleeding gums, blood in urine, or severe abdominal pain, go to emergency immediately.",
        "safety": "Do not take aspirin or ibuprofen — they can worsen internal bleeding in dengue. Use paracetamol only for fever.",
    },
    "Tuberculosis": {
        "home_care": "Rest in a well-ventilated room. Cover your mouth when coughing and dispose of tissues carefully. Eat nutritious meals.",
        "test": "Sputum smear microscopy, GeneXpert (rapid TB test), and chest X-ray.",
        "doctor": "Visit a TB clinic or public hospital immediately. TB treatment is free at government facilities in Ghana.",
        "safety": "TB is airborne and contagious. Wear a mask around others until a doctor confirms you are non-infectious.",
    },
    "Hepatitis B": {
        "home_care": "Rest completely and avoid alcohol entirely. Eat a low-fat, high-protein diet. Do not share razors, toothbrushes, or needles.",
        "test": "Hepatitis B surface antigen (HBsAg) test and liver function tests (LFTs).",
        "doctor": "See a doctor for evaluation. Chronic hepatitis B requires antiviral medication and regular liver monitoring.",
        "safety": "Hepatitis B is spread through blood and bodily fluids. Inform close contacts so they can be tested and vaccinated.",
    },
    "Hepatitis C": {
        "home_care": "Rest and avoid alcohol completely. Eat a healthy balanced diet and stay hydrated.",
        "test": "Hepatitis C antibody test (anti-HCV) and HCV RNA viral load test to confirm active infection.",
        "doctor": "See a specialist. Hepatitis C is now curable with direct-acting antiviral medications.",
        "safety": "Do not share needles, syringes, or sharp objects. Inform partners and household members.",
    },
    "Hepatitis D": {
        "home_care": "Stop alcohol immediately and rest. Hepatitis D only occurs alongside Hepatitis B.",
        "test": "Hepatitis D antibody test (anti-HDV), HBsAg, and liver function tests.",
        "doctor": "Seek specialist care urgently. Co-infection with Hepatitis B and D can progress rapidly.",
        "safety": "This is a serious co-infection. Do not delay seeking care.",
    },
    "Pneumonia": {
        "home_care": "Rest, stay warm, and drink warm fluids. Steam inhalation may ease breathing. Sleep with head slightly elevated.",
        "test": "Chest X-ray is the primary diagnostic test. Sputum culture if available.",
        "doctor": "Visit a clinic or hospital today. Pneumonia requires antibiotic treatment and may need hospitalisation.",
        "safety": "Pneumonia can worsen rapidly, especially in children, elderly patients, or those with underlying conditions.",
    },
    "Hepatitis A": {
        "home_care": "Rest and drink only clean safe water. Eat small frequent meals that are easy to digest. Avoid alcohol and fatty foods.",
        "test": "Hepatitis A IgM antibody test confirms acute infection.",
        "doctor": "See a doctor to confirm diagnosis and monitor recovery. Most patients recover fully with rest.",
        "safety": "Hepatitis A is spread through contaminated food and water. Do not share utensils or food with others.",
    },
    "Hepatitis E": {
        "home_care": "Rest and drink only clean safe water. Eat light nutritious meals. Avoid alcohol completely.",
        "test": "Hepatitis E IgM antibody test.",
        "doctor": "See a doctor, especially if you are pregnant. Hepatitis E can be dangerous during pregnancy.",
        "safety": "Pregnant women must seek care immediately — Hepatitis E carries a high risk of acute liver failure in pregnancy.",
    },
    "Alcoholic Hepatitis": {
        "home_care": "Stop all alcohol consumption immediately. Eat a high-calorie, high-protein diet. Take prescribed vitamin supplements if available.",
        "test": "Liver function tests (LFTs), complete blood count, and ultrasound of the abdomen.",
        "doctor": "Seek medical care urgently. Severe cases require hospitalisation and specialist management.",
        "safety": "Continued alcohol consumption with this condition can be fatal. Complete abstinence is non-negotiable.",
    },
    "Jaundice": {
        "home_care": "Rest and drink plenty of clean water. Avoid alcohol, oily food, and medications not prescribed by a doctor.",
        "test": "Liver function tests, serum bilirubin level, and abdominal ultrasound to identify the cause.",
        "doctor": "See a doctor promptly. Jaundice is a sign of an underlying condition that must be identified and treated.",
        "safety": "Jaundice is a symptom, not a disease. The underlying cause — which may be serious — needs diagnosis.",
    },
    "Chicken Pox": {
        "home_care": "Rest at home, apply calamine lotion to blisters to relieve itching, and trim fingernails short to prevent scratching.",
        "test": "Diagnosis is usually clinical. No test is routinely required.",
        "doctor": "See a doctor if blisters become infected, fever is very high, or the patient has a weakened immune system.",
        "safety": "Chicken pox is highly contagious. Stay home and avoid contact with pregnant women, newborns, and immunocompromised individuals.",
    },
    "Bronchial Asthma": {
        "home_care": "Avoid known triggers such as dust, smoke, cold air, and strong odours. Use your prescribed reliever inhaler as directed.",
        "test": "Spirometry (lung function test) and peak expiratory flow measurement.",
        "doctor": "See a doctor for a long-term asthma management plan including preventer and reliever medications.",
        "safety": "Always carry your reliever inhaler. Seek emergency care immediately if breathing becomes severely difficult.",
    },
    "Urinary Tract Infection": {
        "home_care": "Drink at least 2 to 3 litres of clean water daily. Urinate frequently and do not hold urine. Avoid spicy food and caffeine.",
        "test": "Urine dipstick test and urine culture with sensitivity to guide antibiotic choice.",
        "doctor": "See a doctor for an antibiotic prescription. UTIs generally resolve quickly with the correct antibiotic.",
        "safety": "Untreated UTIs can spread to the kidneys. Do not ignore symptoms of fever or back pain alongside urinary symptoms.",
    },
    "Dimorphic Haemorrhoids": {
        "home_care": "Eat a high-fibre diet with fruits, vegetables, and whole grains. Drink plenty of water and avoid straining during bowel movements.",
        "test": "Diagnosis is usually clinical. Proctoscopy may be recommended by a doctor.",
        "doctor": "See a doctor if bleeding persists, pain is severe, or haemorrhoids prolapse and cannot be pushed back.",
        "safety": "Avoid prolonged sitting and heavy lifting. Warm sitz baths can relieve pain and swelling.",
    },
    "Peptic Ulcer Disease": {
        "home_care": "Avoid spicy food, alcohol, caffeine, and acidic drinks. Eat small frequent meals. Do not skip meals.",
        "test": "H. pylori breath test or stool antigen test. Endoscopy for definitive diagnosis if symptoms are severe.",
        "doctor": "See a doctor for proton pump inhibitor therapy. If H. pylori is detected, antibiotic treatment is required.",
        "safety": "Avoid aspirin, ibuprofen, and diclofenac — these medications worsen ulcers and can cause serious bleeding.",
    },
    "Diabetes": {
        "home_care": "Reduce sugar, white rice, white bread, and sweetened drinks from your diet. Walk or exercise for at least 30 minutes daily if possible.",
        "test": "Fasting blood glucose test and HbA1c (glycated haemoglobin) for long-term glucose control.",
        "doctor": "See a doctor for a comprehensive diabetes management plan including medication, diet, and monitoring.",
        "safety": "Check blood sugar regularly if you have a glucometer. Watch for signs of low blood sugar such as dizziness and sweating.",
    },
    "Fungal Infection": {
        "home_care": "Keep the affected skin area clean and dry. Wear loose breathable clothing. Change socks and underwear daily.",
        "test": "Diagnosis is usually clinical. Skin scraping for microscopy if the diagnosis is unclear.",
        "doctor": "Visit a pharmacy for an antifungal cream or powder. See a doctor if the infection is widespread or does not improve.",
        "safety": "Do not share towels, socks, or footwear with others. Fungi spread easily in warm damp environments.",
    },
    "Allergy": {
        "home_care": "Identify and avoid your triggers. Stay indoors during high pollen periods and keep windows closed. Rinse nasal passages with saline.",
        "test": "Skin prick test or specific IgE blood test for persistent or severe allergies.",
        "doctor": "See a doctor for antihistamine or nasal corticosteroid prescription. Severe allergies may need specialist referral.",
        "safety": "If you develop throat swelling, difficulty breathing, or severe hives, go to an emergency room immediately. This may be anaphylaxis.",
    },
    "Common Cold": {
        "home_care": "Rest at home, drink warm fluids, and use saline nasal drops. Honey and lemon in warm water can soothe a sore throat.",
        "test": "No test is needed. The common cold is diagnosed from symptoms alone.",
        "doctor": "Visit a clinic only if symptoms persist beyond 7 to 10 days, or if you develop high fever, earache, or difficulty breathing.",
        "safety": "Wash hands frequently and cover your mouth when sneezing or coughing to avoid spreading the virus.",
    },
    "Drug Reaction": {
        "home_care": "Stop the suspected medication immediately and do not resume it. Apply a cool damp cloth to the affected skin area.",
        "test": "No specific test is usually needed. A doctor will review your medication history.",
        "doctor": "See a doctor immediately to confirm the reaction and find a safe alternative medication.",
        "safety": "If you develop throat swelling, difficulty breathing, or rapidly spreading hives, call for emergency help immediately.",
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# ADAPTIVE QUESTION ENGINE
# ─────────────────────────────────────────────────────────────────────────────
def _score_disease(disease: str, answers: Dict[str, bool]) -> float:
    score = 0.0
    for sym in DISEASE_SYMPTOM_MAP.get(disease, []):
        if answers.get(sym) is True:
            score += 3.0
        elif answers.get(sym) is False:
            score -= 1.0
    return score


def _get_next_question(answers: Dict[str, bool], asked: List[str]) -> Optional[Dict[str, str]]:
    """Return the most diagnostically useful unasked question."""
    ranked = sorted(
        DISEASE_SYMPTOM_MAP.keys(),
        key=lambda d: _score_disease(d, answers),
        reverse=True,
    )
    # Try top-6 candidate diseases first
    for disease in ranked[:6]:
        for sym in DISEASE_SYMPTOM_MAP[disease]:
            if sym not in asked:
                q = Q_INDEX.get(sym)
                if q:
                    return q
    # Fallback: any unanswered question
    for q in ALL_QUESTIONS:
        if q["id"] not in asked:
            return q
    return None


def _predict(answers: Dict[str, bool]) -> Dict[str, Any]:
    """Score-based prediction with confidence estimation."""
    scores = {d: _score_disease(d, answers) for d in DISEASE_SYMPTOM_MAP}
    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    best_disease = ranked[0][0]

    syms      = DISEASE_SYMPTOM_MAP.get(best_disease, [])
    yes_count = sum(1 for s in syms if answers.get(s) is True)
    confidence = min(0.95, max(0.35, yes_count / max(len(syms), 1)))

    # Build all_scores for top 8 diseases
    all_scores: Dict[str, float] = {}
    for d, _ in ranked[:8]:
        d_syms = DISEASE_SYMPTOM_MAP.get(d, [])
        yc = sum(1 for s in d_syms if answers.get(s) is True)
        all_scores[d] = round(min(0.95, max(0.01, yc / max(len(d_syms), 1))), 4)

    return {
        "disease":    best_disease,
        "confidence": round(confidence, 4),
        "risk":       RISK_MAP.get(best_disease, "Medium"),
        "all_scores": all_scores,
        "method":     "scoring",
    }


# ─────────────────────────────────────────────────────────────────────────────
# OPENROUTER AI  (optional — graceful fallback on any failure)
# ─────────────────────────────────────────────────────────────────────────────
async def _call_openrouter(
    disease: str,
    risk: str,
    active_syms: List[str],
    confidence: float,
) -> Optional[Dict[str, str]]:
    if not OPENROUTER_API_KEY:
        return None

    sym_text = ", ".join(s.replace("_", " ") for s in active_syms[:12]) or "general symptoms"
    urgency = {
        "High":   "visit a hospital or clinic today — this is urgent",
        "Medium": "visit a clinic within 1 to 2 days if symptoms persist",
        "Low":    "rest at home and visit a clinic only if symptoms worsen",
    }.get(risk, "visit a clinic")

    prompt = (
        f"You are a health assistant for patients in Ghana and West Africa.\n\n"
        f"Patient symptoms: {sym_text}\n"
        f"Most likely condition: {disease} (confidence: {round(confidence * 100)}%)\n"
        f"Risk level: {risk} — {urgency}\n\n"
        f"Reply ONLY with a valid JSON object. No markdown. No extra text.\n"
        f'{{"explanation":"One sentence explaining why these symptoms suggest {disease}.",'
        f'"home_care":"1 to 2 practical things the patient can do at home right now.",'
        f'"test":"One specific diagnostic test to confirm, or No test needed.",'
        f'"doctor":"One clear instruction about seeking care.",'
        f'"safety":"One brief safety warning for High risk, or empty string for Low or Medium."}}\n\n'
        f"Rules: plain simple language, no jargon, one sentence per field, never prescribe drug names or dosages."
    )

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type":  "application/json",
        "HTTP-Referer":  SITE_URL,
        "X-Title":       SITE_NAME,
    }
    payload = {
        "model":       OPENROUTER_MODEL,
        "messages":    [
            {
                "role":    "system",
                "content": (
                    "You are a responsible clinical AI assistant for a tropical disease app. "
                    "Respond with valid JSON only. Never prescribe specific drug names or dosages."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "max_tokens":  350,
        "temperature": 0.15,
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                OPENROUTER_URL,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=14),
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    logger.warning(f"OpenRouter HTTP {resp.status}: {body[:300]}")
                    return None

                data  = await resp.json()
                raw   = data["choices"][0]["message"]["content"].strip()
                # Strip any accidental markdown fences
                raw   = raw.replace("```json", "").replace("```", "").strip()
                result: Dict[str, str] = json.loads(raw)

                for key in ("explanation", "home_care", "test", "doctor", "safety"):
                    result.setdefault(key, "")

                return result

    except asyncio.TimeoutError:
        logger.warning("OpenRouter timed out")
    except json.JSONDecodeError as e:
        logger.warning(f"OpenRouter JSON parse error: {e}")
    except aiohttp.ClientError as e:
        logger.warning(f"OpenRouter connection error: {e}")
    except Exception as e:
        logger.warning(f"OpenRouter unexpected error: {e}")

    return None


def _build_recommendation(
    disease: str,
    risk: str,
    ai_result: Optional[Dict[str, str]],
) -> Dict[str, str]:
    default = DEFAULT_RECS.get(
        disease,
        {
            "home_care": "Rest and stay well hydrated.",
            "test":      "Consult a healthcare provider for appropriate diagnostic tests.",
            "doctor":    "Visit a clinic if symptoms persist or worsen.",
            "safety":    "Seek emergency care if symptoms become severe." if risk == "High" else "",
        },
    )

    if ai_result:
        return {
            "home_care":   ai_result.get("home_care")   or default["home_care"],
            "test":        ai_result.get("test")        or default["test"],
            "doctor":      ai_result.get("doctor")      or default["doctor"],
            "safety":      ai_result.get("safety")      or default.get("safety", ""),
            "explanation": ai_result.get("explanation") or f"Your symptoms are consistent with {disease}.",
        }

    return {
        **default,
        "explanation": f"Your reported symptoms are consistent with {disease}.",
    }


# ─────────────────────────────────────────────────────────────────────────────
# PASSWORD HASHING  (no bcrypt dependency — stdlib only)
# ─────────────────────────────────────────────────────────────────────────────
def _hash_password(plain: str) -> str:
    salt   = secrets.token_hex(16)
    hashed = hashlib.sha256((salt + plain).encode("utf-8")).hexdigest()
    return f"{salt}:{hashed}"


def _verify_password(plain: str, stored: str) -> bool:
    try:
        salt, hashed = stored.split(":", 1)
        return hashlib.sha256((salt + plain).encode("utf-8")).hexdigest() == hashed
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# JWT HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def _create_token(user_id: int) -> str:
    exp = datetime.utcnow() + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": str(user_id), "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)


security = HTTPBearer()


def _get_user_id(creds: HTTPAuthorizationCredentials = Depends(security)) -> int:
    try:
        payload = jwt.decode(creds.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        sub = payload.get("sub")
        if sub is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        return int(sub)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


# ─────────────────────────────────────────────────────────────────────────────
# DB SESSION DEPENDENCY
# ─────────────────────────────────────────────────────────────────────────────
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────────────
# PYDANTIC SCHEMAS
# ─────────────────────────────────────────────────────────────────────────────
class RegisterRequest(BaseModel):
    email:    str
    password: str
    name:     str
    age:      Optional[str] = None
    gender:   Optional[str] = None


class LoginRequest(BaseModel):
    email:    str
    password: str


class AnswerRequest(BaseModel):
    question_id: str
    answer:      bool


class ProfileUpdate(BaseModel):
    name:   Optional[str] = None
    age:    Optional[str] = None
    gender: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# APP STARTUP / SHUTDOWN
# ─────────────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    logger.info(f"TropiCare API started.")
    logger.info(f"Database: {DATABASE_URL}")
    logger.info(f"OpenRouter enabled: {bool(OPENROUTER_API_KEY)} | Model: {OPENROUTER_MODEL}")
    yield
    logger.info("TropiCare API shutting down.")


app = FastAPI(
    title="TropiCare API",
    version="1.0.0",
    description="KNUST Final Year Project — AI Tropical Disease Symptom Checker",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# HEALTH CHECK
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/api/v1/health", tags=["Health"])
async def health():
    return {
        "status":              "healthy",
        "timestamp":           datetime.utcnow().isoformat(),
        "openrouter_enabled":  bool(OPENROUTER_API_KEY),
        "openrouter_model":    OPENROUTER_MODEL,
    }


# ─────────────────────────────────────────────────────────────────────────────
# AUTH ROUTES
# ─────────────────────────────────────────────────────────────────────────────
@app.post("/api/v1/auth/register", status_code=201, tags=["Auth"])
async def register(req: RegisterRequest, db: Session = Depends(get_db)):
    """
    Register a new user.
    Frontend expects: { access_token, token_type, user: { id, email, name } }
    """
    if not req.email or not req.password or not req.name:
        raise HTTPException(status_code=400, detail="Email, password, and name are required.")

    existing = db.query(UserModel).filter(UserModel.email == req.email.strip().lower()).first()
    if existing:
        raise HTTPException(status_code=400, detail="An account with this email already exists.")

    user = UserModel(
        email   = req.email.strip().lower(),
        name    = req.name.strip(),
        pw_hash = _hash_password(req.password),
        age     = req.age or None,
        gender  = req.gender or None,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    logger.info(f"New user registered: {user.email} (id={user.id})")

    return {
        "access_token": _create_token(user.id),
        "token_type":   "bearer",
        "user": {
            "id":     user.id,
            "email":  user.email,
            "name":   user.name,
            "age":    user.age,
            "gender": user.gender,
        },
    }


@app.post("/api/v1/auth/login", tags=["Auth"])
async def login(req: LoginRequest, db: Session = Depends(get_db)):
    """
    Authenticate an existing user.
    Frontend expects: { access_token, token_type, user: { id, email, name } }
    """
    if not req.email or not req.password:
        raise HTTPException(status_code=400, detail="Email and password are required.")

    user = db.query(UserModel).filter(UserModel.email == req.email.strip().lower()).first()
    if not user or not _verify_password(req.password, user.pw_hash):
        raise HTTPException(status_code=401, detail="Incorrect email or password.")

    logger.info(f"User logged in: {user.email} (id={user.id})")

    return {
        "access_token": _create_token(user.id),
        "token_type":   "bearer",
        "user": {
            "id":     user.id,
            "email":  user.email,
            "name":   user.name,
            "age":    user.age,
            "gender": user.gender,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# ASSESSMENT ROUTES
# ─────────────────────────────────────────────────────────────────────────────
@app.post("/api/v1/symptoms/start", status_code=201, tags=["Assessment"])
async def start_assessment(
    user_id: int = Depends(_get_user_id),
    db:      Session = Depends(get_db),
):
    """
    Begin a new assessment session.
    Frontend expects: { session_id, first_question: { id, question, category }, total_questions }
    """
    sid = str(uuid.uuid4())
    session = AssessmentSession(
        session_id      = sid,
        user_id         = user_id,
        answers         = _dump({}),
        asked_questions = _dump([]),
    )
    db.add(session)
    db.commit()

    return {
        "session_id":      sid,
        "first_question":  ALL_QUESTIONS[0],
        "total_questions": 15,
    }


@app.post("/api/v1/symptoms/next", tags=["Assessment"])
async def next_question(
    session_id: str,
    req:        AnswerRequest,
    user_id:    int     = Depends(_get_user_id),
    db:         Session = Depends(get_db),
):
    """
    Record the current answer and return the next question.
    Frontend expects:
      { completed: true }                             — when done
      { completed: false, next_question: { id, ... }} — when continuing
    """
    session = db.query(AssessmentSession).filter(
        AssessmentSession.session_id == session_id,
        AssessmentSession.user_id    == user_id,
    ).first()

    if not session:
        raise HTTPException(status_code=404, detail="Assessment session not found.")

    if req.question_id not in Q_INDEX:
        raise HTTPException(status_code=400, detail=f"Unknown question id: {req.question_id}")

    answers = _load(session.answers, {})
    asked   = _load(session.asked_questions, [])

    answers[req.question_id] = req.answer
    if req.question_id not in asked:
        asked.append(req.question_id)

    session.answers         = _dump(answers)
    session.asked_questions = _dump(asked)
    db.commit()

    if len(asked) >= 15:
        session.completed = True
        db.commit()
        return {"completed": True}

    next_q = _get_next_question(answers, asked)
    if not next_q:
        session.completed = True
        db.commit()
        return {"completed": True}

    return {"completed": False, "next_question": next_q}


@app.post("/api/v1/diagnosis/analyze", tags=["Assessment"])
async def analyze(
    session_id: str,
    user_id:    int     = Depends(_get_user_id),
    db:         Session = Depends(get_db),
):
    """
    Run diagnosis on completed session answers.
    Frontend expects:
      { disease, confidence, risk, explanation, all_scores, recommendation: { home_care, test, doctor, safety }, method, ai_used }
    """
    session = db.query(AssessmentSession).filter(
        AssessmentSession.session_id == session_id,
        AssessmentSession.user_id    == user_id,
    ).first()

    if not session:
        raise HTTPException(status_code=404, detail="Assessment session not found.")

    answers     = _load(session.answers, {})
    pred        = _predict(answers)
    active_syms = [k for k, v in answers.items() if v is True]

    # Attempt AI-enhanced recommendations with timeout
    ai_result: Optional[Dict[str, str]] = None
    try:
        ai_result = await asyncio.wait_for(
            _call_openrouter(pred["disease"], pred["risk"], active_syms, pred["confidence"]),
            timeout=12.0,
        )
    except asyncio.TimeoutError:
        logger.warning("OpenRouter timed out — using curated defaults")
    except Exception as e:
        logger.warning(f"OpenRouter error: {e} — using curated defaults")

    rec = _build_recommendation(pred["disease"], pred["risk"], ai_result)

    # Persist diagnosis
    diag = DiagnosisRecord(
        user_id         = user_id,
        session_id      = session_id,
        disease         = pred["disease"],
        risk            = pred["risk"],
        confidence      = pred["confidence"],
        answers         = _dump(answers),
        active_symptoms = _dump(active_syms),
        rec_home_care   = rec["home_care"],
        rec_test        = rec["test"],
        rec_doctor      = rec["doctor"],
        rec_safety      = rec.get("safety", ""),
        explanation     = rec.get("explanation", ""),
        all_scores      = _dump(pred.get("all_scores", {})),
        method          = pred["method"],
        ai_used         = ai_result is not None,
    )
    db.add(diag)

    # Mark session complete
    session.completed = True
    db.commit()
    db.refresh(diag)

    return {
        "id":         diag.id,
        "disease":    pred["disease"],
        "confidence": pred["confidence"],
        "risk":       pred["risk"],
        "explanation": rec.get("explanation", ""),
        "all_scores": pred.get("all_scores", {}),
        "recommendation": {
            "home_care": rec["home_care"],
            "test":      rec["test"],
            "doctor":    rec["doctor"],
            "safety":    rec.get("safety", ""),
        },
        "method":  pred["method"],
        "ai_used": ai_result is not None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# PATIENT HISTORY ROUTES
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/api/v1/patient/history", tags=["Records"])
async def get_history(
    user_id: int     = Depends(_get_user_id),
    db:      Session = Depends(get_db),
):
    """
    Return the authenticated user's assessment history (newest first).
    Frontend uses this in HomeScreen (stats + recent list) and RecordsScreen.
    Expected shape per record:
      { id, disease, risk, confidence, created_at, patient_name,
        recommendation: { home_care, test, doctor, safety },
        explanation, active_symptoms }
    """
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    rows = (
        db.query(DiagnosisRecord)
        .filter(DiagnosisRecord.user_id == user_id)
        .order_by(DiagnosisRecord.created_at.desc())
        .limit(100)
        .all()
    )

    return [
        {
            "id":           r.id,
            "disease":      r.disease,
            "risk":         r.risk,
            "confidence":   r.confidence,
            "created_at":   r.created_at.isoformat(),
            "patient_name": user.name,
            "recommendation": {
                "home_care": r.rec_home_care or "",
                "test":      r.rec_test      or "",
                "doctor":    r.rec_doctor    or "",
                "safety":    r.rec_safety    or "",
            },
            "explanation":     r.explanation     or "",
            "active_symptoms": _load(r.active_symptoms, []),
        }
        for r in rows
    ]


@app.get("/api/v1/patient/history/{diag_id}", tags=["Records"])
async def get_diagnosis_detail(
    diag_id: int,
    user_id: int     = Depends(_get_user_id),
    db:      Session = Depends(get_db),
):
    """
    Return a single diagnosis record in full detail.
    RecordDetail component uses this shape.
    """
    r = db.query(DiagnosisRecord).filter(
        DiagnosisRecord.id      == diag_id,
        DiagnosisRecord.user_id == user_id,
    ).first()

    if not r:
        raise HTTPException(status_code=404, detail="Record not found.")

    user = db.query(UserModel).filter(UserModel.id == user_id).first()

    return {
        "id":           r.id,
        "disease":      r.disease,
        "risk":         r.risk,
        "confidence":   r.confidence,
        "created_at":   r.created_at.isoformat(),
        "patient_name": user.name if user else "Unknown",
        "answers":      _load(r.answers, {}),
        "active_symptoms": _load(r.active_symptoms, []),
        "recommendation": {
            "home_care": r.rec_home_care or "",
            "test":      r.rec_test      or "",
            "doctor":    r.rec_doctor    or "",
            "safety":    r.rec_safety    or "",
        },
        "explanation": r.explanation or "",
        "all_scores":  _load(r.all_scores, {}),
        "method":      r.method or "scoring",
        "ai_used":     r.ai_used or False,
    }


# ─────────────────────────────────────────────────────────────────────────────
# USER PROFILE ROUTES
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/api/v1/user/profile", tags=["Profile"])
async def get_profile(
    user_id: int     = Depends(_get_user_id),
    db:      Session = Depends(get_db),
):
    """
    Return user profile including assessment statistics.
    ProfileScreen expects:
      { id, email, name, age, gender, joined_at, assessment_count, high_risk_count }
    """
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    total_count = (
        db.query(DiagnosisRecord)
        .filter(DiagnosisRecord.user_id == user_id)
        .count()
    )
    high_count = (
        db.query(DiagnosisRecord)
        .filter(DiagnosisRecord.user_id == user_id, DiagnosisRecord.risk == "High")
        .count()
    )

    return {
        "id":               user.id,
        "email":            user.email,
        "name":             user.name,
        "age":              user.age,
        "gender":           user.gender,
        "joined_at":        user.created_at.isoformat(),
        "assessment_count": total_count,
        "high_risk_count":  high_count,
    }


@app.put("/api/v1/user/profile", tags=["Profile"])
async def update_profile(
    req:     ProfileUpdate,
    user_id: int     = Depends(_get_user_id),
    db:      Session = Depends(get_db),
):
    """
    Update user profile fields.
    Frontend sends: { name?, age?, gender? }
    Returns: { id, name, age, gender }
    """
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    if req.name   is not None: user.name   = req.name.strip()
    if req.age    is not None: user.age    = req.age
    if req.gender is not None: user.gender = req.gender

    db.commit()
    db.refresh(user)

    return {
        "id":     user.id,
        "name":   user.name,
        "age":    user.age,
        "gender": user.gender,
    }


# ─────────────────────────────────────────────────────────────────────────────
# ADMIN ROUTES
# Note: The frontend AdminScreen does NOT require admin-only auth — it uses
# the same Bearer token as regular users. This matches the App.jsx api calls
# which all go through the same api.delete/api.get helpers with the user token.
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/api/v1/admin/stats", tags=["Admin"])
async def admin_stats(
    user_id: int     = Depends(_get_user_id),
    db:      Session = Depends(get_db),
):
    """
    Return aggregate statistics across all records.
    """
    return {
        "total_users":     db.query(UserModel).count(),
        "total_diagnoses": db.query(DiagnosisRecord).count(),
        "high_risk":       db.query(DiagnosisRecord).filter(DiagnosisRecord.risk == "High").count(),
        "medium_risk":     db.query(DiagnosisRecord).filter(DiagnosisRecord.risk == "Medium").count(),
        "low_risk":        db.query(DiagnosisRecord).filter(DiagnosisRecord.risk == "Low").count(),
    }


@app.get("/api/v1/admin/all-records", tags=["Admin"])
async def all_records(
    user_id: int     = Depends(_get_user_id),
    db:      Session = Depends(get_db),
):
    """
    Return all diagnosis records across all users (for the admin/database screen).
    Frontend AdminScreen expects per record:
      { id, disease, risk, confidence, patient_name, created_at }
    """
    rows = (
        db.query(DiagnosisRecord)
        .order_by(DiagnosisRecord.created_at.desc())
        .limit(500)
        .all()
    )

    # Batch-load user names
    user_ids = {r.user_id for r in rows}
    users: Dict[int, str] = {
        u.id: u.name
        for u in db.query(UserModel).filter(UserModel.id.in_(user_ids)).all()
    }

    return [
        {
            "id":           r.id,
            "disease":      r.disease,
            "risk":         r.risk,
            "confidence":   r.confidence,
            "patient_name": users.get(r.user_id, "Unknown"),
            "created_at":   r.created_at.isoformat(),
        }
        for r in rows
    ]


@app.delete("/api/v1/admin/clear-database", tags=["Admin"])
async def clear_database(
    user_id: int     = Depends(_get_user_id),
    db:      Session = Depends(get_db),
):
    """
    Delete all diagnosis records and assessment sessions.
    Frontend AdminScreen calls this on 'Clear All Records' confirmation.
    """
    deleted_diag    = db.query(DiagnosisRecord).delete()
    deleted_session = db.query(AssessmentSession).delete()
    db.commit()

    logger.info(f"Admin clear by user_id={user_id}: {deleted_diag} diagnoses, {deleted_session} sessions deleted")

    return {
        "message": f"Cleared {deleted_diag} diagnosis record{'s' if deleted_diag != 1 else ''} and {deleted_session} session{'s' if deleted_session != 1 else ''}."
    }


@app.delete("/api/v1/admin/record/{diag_id}", tags=["Admin"])
async def delete_record(
    diag_id: int,
    user_id: int     = Depends(_get_user_id),
    db:      Session = Depends(get_db),
):
    """
    Delete a single diagnosis record by id.
    Frontend AdminScreen calls this on the trash icon per row.
    """
    record = db.query(DiagnosisRecord).filter(DiagnosisRecord.id == diag_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="Record not found.")

    db.delete(record)
    db.commit()

    return {"message": "Record deleted successfully."}


# ─────────────────────────────────────────────────────────────────────────────
# ENTRYPOINT
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host    = "0.0.0.0",
        port    = int(os.getenv("PORT", 8000)),
        reload  = True,
        workers = 1,
    )
