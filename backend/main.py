# main.py

````python
import os
import json
import uuid
import logging
import asyncio
import hashlib
import secrets
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any, Tuple
from contextlib import asynccontextmanager

import aiohttp
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Depends, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy import (
    create_engine,
    Column,
    Integer,
    String,
    Float,
    Boolean,
    DateTime,
    ForeignKey,
    Text,
)
from sqlalchemy.orm import declarative_base, sessionmaker, Session

try:
    import joblib
    JOBLIB_AVAILABLE = True
except ImportError:
    JOBLIB_AVAILABLE = False

# ============================================================
# CONFIGURATION
# ============================================================

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s"
)

logger = logging.getLogger("tropicare")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

SECRET_KEY = os.getenv(
    "SECRET_KEY",
    "tropicare-production-secret-key"
)

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

SITE_URL = os.getenv("SITE_URL", "http://localhost:8000")
SITE_NAME = os.getenv("SITE_NAME", "TropiCare")

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    f"sqlite:///{os.path.join(BASE_DIR, 'tropicare.db')}"
)

MODELS_DIR = os.path.join(BASE_DIR, "models")

FREE_MODELS = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemma-3-27b-it:free",
    "google/gemma-3-12b-it:free",
    "nousresearch/hermes-3-llama-3.1-405b:free",
    "mistralai/mistral-7b-instruct:free",
]

# ============================================================
# DATABASE
# ============================================================

connect_args = {}

if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,
    pool_recycle=300,
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)

Base = declarative_base()

# ============================================================
# DATABASE MODELS
# ============================================================

class UserModel(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=False)
    pw_hash = Column(String(512), nullable=False)
    age = Column(String(20), nullable=True)
    gender = Column(String(20), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class DiagnosisModel(Base):
    __tablename__ = "diagnoses"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    session_id = Column(String(100), index=True)

    disease = Column(String(100))
    risk = Column(String(50))
    confidence = Column(Float)

    answers = Column(Text)
    active_symptoms = Column(Text)

    rec_home_care = Column(Text)
    rec_test = Column(Text)
    rec_doctor = Column(Text)
    rec_safety = Column(Text)

    ai_explanation = Column(Text)
    ml_scores = Column(Text)
    ai_model_used = Column(String(200))

    created_at = Column(DateTime, default=datetime.utcnow)


class SessionModel(Base):
    __tablename__ = "assessment_sessions"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String(100), unique=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    answers = Column(Text, default="{}")
    asked_questions = Column(Text, default="[]")

    completed = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.utcnow)

# ============================================================
# HELPERS
# ============================================================


def _load_json(value: Optional[str], default):
    if not value:
        return default

    try:
        return json.loads(value)
    except Exception:
        return default



def _dump_json(value) -> str:
    return json.dumps(value)

# ============================================================
# ML MODEL LOADING
# ============================================================

LOADED_MODELS: Dict[str, Any] = {}



def load_ml_models() -> None:
    global LOADED_MODELS

    if not JOBLIB_AVAILABLE:
        logger.warning("joblib not installed. ML disabled.")
        return

    os.makedirs(MODELS_DIR, exist_ok=True)

    files = [f for f in os.listdir(MODELS_DIR) if f.endswith(".pkl")]

    if not files:
        logger.warning("No ML model files found.")
        return

    for file_name in files:
        path = os.path.join(MODELS_DIR, file_name)

        try:
            key = file_name.replace(".pkl", "")
            LOADED_MODELS[key] = joblib.load(path)
            logger.info(f"Loaded ML model: {key}")

        except Exception as exc:
            logger.error(f"Failed loading {file_name}: {exc}")

    required = [
        "sctd_ensemble",
        "sctd_label_encoder",
        "sctd_feature_columns",
    ]

    missing = [m for m in required if m not in LOADED_MODELS]

    if missing:
        logger.warning(f"Missing ML files: {missing}")
    else:
        logger.info("All ML models loaded successfully.")

# ============================================================
# SYMPTOMS
# ============================================================

DISEASE_SYMPTOM_MAP = {
    "Malaria": [
        "high_fever",
        "chills",
        "headache",
        "vomiting",
        "fatigue",
    ],
    "Typhoid": [
        "high_fever",
        "abdominal_pain",
        "vomiting",
        "fatigue",
        "loss_of_appetite",
    ],
    "Pneumonia": [
        "cough",
        "chest_pain",
        "high_fever",
        "breathlessness",
    ],
    "Diabetes": [
        "polyuria",
        "weight_loss",
        "fatigue",
        "blurred_vision",
    ],
}

RISK_MAP = {
    "Malaria": "High",
    "Typhoid": "High",
    "Pneumonia": "High",
    "Diabetes": "Medium",
}

ALL_QUESTIONS = [
    {
        "id": "high_fever",
        "question": "Do you have a high fever?",
        "category": "General",
    },
    {
        "id": "headache",
        "question": "Do you have headaches?",
        "category": "General",
    },
    {
        "id": "fatigue",
        "question": "Do you feel tired or weak?",
        "category": "General",
    },
    {
        "id": "vomiting",
        "question": "Are you vomiting?",
        "category": "Digestive",
    },
    {
        "id": "cough",
        "question": "Do you have a cough?",
        "category": "Respiratory",
    },
    {
        "id": "breathlessness",
        "question": "Do you have difficulty breathing?",
        "category": "Respiratory",
    },
    {
        "id": "abdominal_pain",
        "question": "Do you have abdominal pain?",
        "category": "Digestive",
    },
    {
        "id": "weight_loss",
        "question": "Do you have unexplained weight loss?",
        "category": "Metabolic",
    },
    {
        "id": "blurred_vision",
        "question": "Do you have blurred vision?",
        "category": "Eyes",
    },
    {
        "id": "polyuria",
        "question": "Do you urinate frequently?",
        "category": "Metabolic",
    },
]

Q_INDEX = {q["id"]: q for q in ALL_QUESTIONS}

# ============================================================
# DEFAULT RECOMMENDATIONS
# ============================================================

DEFAULT_RECS = {
    "Malaria": {
        "home_care": "Rest and drink plenty of fluids.",
        "test": "Malaria blood test.",
        "doctor": "Visit a clinic immediately.",
        "safety": "Do not delay treatment.",
    },
    "Typhoid": {
        "home_care": "Drink clean water and rest.",
        "test": "Widal or blood culture test.",
        "doctor": "Visit a doctor for evaluation.",
        "safety": "Maintain good hygiene.",
    },
}

# ============================================================
# ML PREDICTION
# ============================================================


def score_disease(disease: str, answers: dict) -> float:
    score = 0.0

    for symptom in DISEASE_SYMPTOM_MAP.get(disease, []):
        if answers.get(symptom) is True:
            score += 3.0
        elif answers.get(symptom) is False:
            score -= 1.0

    return score



def predict_with_ml(answers: dict) -> dict:
    ensemble = LOADED_MODELS.get("sctd_ensemble")
    encoder = LOADED_MODELS.get("sctd_label_encoder")
    columns = LOADED_MODELS.get("sctd_feature_columns")

    if ensemble and encoder and columns:

        try:
            feature_cols = list(columns)

            vector = np.array([
                1.0 if answers.get(col, False) else 0.0
                for col in feature_cols
            ]).reshape(1, -1)

            probabilities = ensemble.predict_proba(vector)[0]

            index = int(np.argmax(probabilities))

            disease = encoder.inverse_transform([index])[0]
            confidence = float(probabilities[index])

            scores = {
                encoder.inverse_transform([i])[0]: round(float(p), 4)
                for i, p in enumerate(probabilities)
            }

            return {
                "disease": disease,
                "confidence": confidence,
                "risk": RISK_MAP.get(disease, "Medium"),
                "all_scores": scores,
                "method": "ml",
            }

        except Exception as exc:
            logger.error(f"ML prediction failed: {exc}")

    scores = {
        d: score_disease(d, answers)
        for d in DISEASE_SYMPTOM_MAP
    }

    best = max(scores.items(), key=lambda x: x[1])

    disease = best[0]

    confidence = 0.65

    return {
        "disease": disease,
        "confidence": confidence,
        "risk": RISK_MAP.get(disease, "Medium"),
        "all_scores": scores,
        "method": "scoring",
    }

# ============================================================
# OPENROUTER
# ============================================================

_http_session = None



def _get_http_session() -> aiohttp.ClientSession:
    global _http_session

    if _http_session is None or _http_session.closed:
        connector = aiohttp.TCPConnector(
            limit=100,
            limit_per_host=20,
        )

        _http_session = aiohttp.ClientSession(
            connector=connector
        )

    return _http_session



async def call_openrouter(
    disease: str,
    risk: str,
    active_syms: List[str],
    confidence: float,
) -> Tuple[Optional[dict], Optional[str]]:

    if not OPENROUTER_API_KEY:
        logger.warning("OpenRouter API key missing")
        return None, None

    symptoms = ", ".join(
        s.replace("_", " ")
        for s in active_syms[:15]
    )

    prompt = f"""
You are a professional tropical disease clinical assistant.

Patient symptoms:
{symptoms}

Predicted disease:
{disease}

Confidence:
{round(confidence * 100)}%

Risk:
{risk}

Return ONLY valid JSON:

{{
  "explanation": "...",
  "home_care": "...",
  "test": "...",
  "doctor": "...",
  "safety": "..."
}}

Rules:
- No markdown
- No code block
- No extra text
- Professional tone
- No medication dosages
"""

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": SITE_URL,
        "X-Title": SITE_NAME,
    }

    session = _get_http_session()

    for model in FREE_MODELS:

        for attempt in range(3):

            try:
                payload = {
                    "model": model,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You are a medical AI assistant. "
                                "Always return valid JSON only."
                            )
                        },
                        {
                            "role": "user",
                            "content": prompt,
                        }
                    ],
                    "temperature": 0.1,
                    "max_tokens": 300,
                    "response_format": {
                        "type": "json_object"
                    }
                }

                async with session.post(
                    OPENROUTER_URL,
                    headers=headers,
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=45),
                ) as response:

                    if response.status == 429:
                        await asyncio.sleep(2)
                        continue

                    if response.status >= 500:
                        await asyncio.sleep(2)
                        continue

                    if response.status != 200:
                        logger.warning(
                            f"Model {model} failed with status {response.status}"
                        )
                        continue

                    data = await response.json(content_type=None)

                    raw = (
                        data["choices"][0]
                        ["message"]["content"]
                        .strip()
                    )

                    raw = raw.replace("```json", "")
                    raw = raw.replace("```", "")
                    raw = raw.strip()

                    result = json.loads(raw)

                    required = [
                        "explanation",
                        "home_care",
                        "test",
                        "doctor",
                        "safety",
                    ]

                    if not all(k in result for k in required):
                        continue

                    logger.info(f"OpenRouter success using {model}")

                    return result, model

            except asyncio.TimeoutError:
                logger.warning(f"Timeout using model {model}")

            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON from model {model}")

            except Exception as exc:
                logger.warning(f"OpenRouter error: {exc}")

    logger.warning("All OpenRouter models failed")

    return None, None

# ============================================================
# RECOMMENDATION BUILDER
# ============================================================


def build_recommendation(
    disease: str,
    risk: str,
    ai_result: Optional[dict],
) -> dict:

    default = DEFAULT_RECS.get(
        disease,
        {
            "home_care": "Rest and stay hydrated.",
            "test": "Visit a healthcare facility for tests.",
            "doctor": "Consult a doctor.",
            "safety": "Seek emergency care if symptoms worsen.",
        }
    )

    if ai_result:
        return {
            "home_care": ai_result.get(
                "home_care",
                default["home_care"]
            ),
            "test": ai_result.get(
                "test",
                default["test"]
            ),
            "doctor": ai_result.get(
                "doctor",
                default["doctor"]
            ),
            "safety": ai_result.get(
                "safety",
                default["safety"]
            ),
            "explanation": ai_result.get(
                "explanation",
                f"Symptoms suggest {disease}."
            ),
        }

    return {
        **default,
        "explanation": f"Symptoms suggest {disease}."
    }

# ============================================================
# PYDANTIC SCHEMAS
# ============================================================

class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str
    age: Optional[str] = None
    gender: Optional[str] = None


class LoginRequest(BaseModel):
    email: str
    password: str


class AnswerRequest(BaseModel):
    question_id: str
    answer: bool

# ============================================================
# AUTH
# ============================================================

security = HTTPBearer()



def create_token(user_id: int) -> str:
    expire = datetime.utcnow() + timedelta(
        days=ACCESS_TOKEN_EXPIRE_DAYS
    )

    payload = {
        "sub": str(user_id),
        "exp": expire,
    }

    return jwt.encode(
        payload,
        SECRET_KEY,
        algorithm=ALGORITHM,
    )



def verify_token(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> int:

    try:
        payload = jwt.decode(
            credentials.credentials,
            SECRET_KEY,
            algorithms=[ALGORITHM],
        )

        user_id = payload.get("sub")

        if not user_id:
            raise HTTPException(
                status_code=401,
                detail="Invalid token",
            )

        return int(user_id)

    except JWTError:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired token",
        )



def hash_pw(password: str) -> str:
    salt = secrets.token_hex(16)

    hashed = hashlib.sha256(
        (salt + password).encode()
    ).hexdigest()

    return f"{salt}:{hashed}"



def verify_pw(password: str, stored: str) -> bool:

    try:
        salt, hashed = stored.split(":", 1)

        check = hashlib.sha256(
            (salt + password).encode()
        ).hexdigest()

        return secrets.compare_digest(check, hashed)

    except Exception:
        return False

# ============================================================
# DATABASE SESSION
# ============================================================


def get_db():
    db = SessionLocal()

    try:
        yield db
    finally:
        db.close()

# ============================================================
# FASTAPI STARTUP
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):

    Base.metadata.create_all(bind=engine)

    with engine.connect() as conn:
        logger.info("Database connected successfully")

    load_ml_models()

    _get_http_session()

    logger.info("TropiCare backend started")

    yield

    global _http_session

    if _http_session and not _http_session.closed:
        await _http_session.close()


app = FastAPI(
    title="TropiCare API",
    version="1.0.0",
    lifespan=lifespan,
)

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "*"
    ).split(",")
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# HEALTH ROUTE
# ============================================================

@app.get("/api/v1/health")
async def health():

    return {
        "status": "healthy",
        "database": DATABASE_URL,
        "ml_models": list(LOADED_MODELS.keys()),
        "openrouter_enabled": bool(OPENROUTER_API_KEY),
        "timestamp": datetime.utcnow().isoformat(),
    }

# ============================================================
# AUTH ROUTES
# ============================================================

@app.post("/api/v1/auth/register")
async def register(
    req: RegisterRequest,
    db: Session = Depends(get_db),
):

    existing = db.query(UserModel).filter(
        UserModel.email == req.email
    ).first()

    if existing:
        raise HTTPException(
            status_code=400,
            detail="Email already exists",
        )

    user = UserModel(
        email=req.email,
        name=req.name,
        pw_hash=hash_pw(req.password),
        age=req.age,
        gender=req.gender,
    )

    db.add(user)
    db.commit()
    db.refresh(user)

    return {
        "access_token": create_token(user.id),
        "token_type": "bearer",
        "user": {
            "id": user.id,
            "email": user.email,
            "name": user.name,
        }
    }


@app.post("/api/v1/auth/login")
async def login(
    req: LoginRequest,
    db: Session = Depends(get_db),
):

    user = db.query(UserModel).filter(
        UserModel.email == req.email
    ).first()

    if not user:
        raise HTTPException(
            status_code=401,
            detail="Invalid credentials",
        )

    if not verify_pw(req.password, user.pw_hash):
        raise HTTPException(
            status_code=401,
            detail="Invalid credentials",
        )

    return {
        "access_token": create_token(user.id),
        "token_type": "bearer",
        "user": {
            "id": user.id,
            "email": user.email,
            "name": user.name,
        }
    }

# ============================================================
# ASSESSMENT ROUTES
# ============================================================

@app.post("/api/v1/symptoms/start")
async def start_assessment(
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):

    existing = db.query(SessionModel).filter(
        SessionModel.user_id == user_id,
        SessionModel.completed == False,
    ).first()

    if existing:
        return {
            "session_id": existing.session_id,
            "first_question": ALL_QUESTIONS[0],
            "total_questions": 10,
        }

    session = SessionModel(
        session_id=str(uuid.uuid4()),
        user_id=user_id,
        answers=_dump_json({}),
        asked_questions=_dump_json([]),
    )

    db.add(session)
    db.commit()

    return {
        "session_id": session.session_id,
        "first_question": ALL_QUESTIONS[0],
        "total_questions": 10,
    }


@app.post("/api/v1/symptoms/next")
async def next_question(
    session_id: str,
    req: AnswerRequest,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):

    session = db.query(SessionModel).filter(
        SessionModel.session_id == session_id,
        SessionModel.user_id == user_id,
    ).first()

    if not session:
        raise HTTPException(
            status_code=404,
            detail="Session not found",
        )

    answers = _load_json(session.answers, {})
    asked = _load_json(session.asked_questions, [])

    answers[req.question_id] = req.answer

    if req.question_id not in asked:
        asked.append(req.question_id)

    session.answers = _dump_json(answers)
    session.asked_questions = _dump_json(asked)

    db.commit()

    if len(asked) >= len(ALL_QUESTIONS):
        session.completed = True
        db.commit()

        return {
            "completed": True
        }

    next_q = None

    for q in ALL_QUESTIONS:
        if q["id"] not in asked:
            next_q = q
            break

    if not next_q:
        return {
            "completed": True
        }

    return {
        "completed": False,
        "next_question": next_q,
    }

# ============================================================
# DIAGNOSIS ROUTE
# ============================================================

@app.post("/api/v1/diagnosis/analyze")
async def analyze(
    session_id: str,
    background_tasks: BackgroundTasks,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):

    try:
        session = db.query(SessionModel).filter(
            SessionModel.session_id == session_id,
            SessionModel.user_id == user_id,
        ).first()

        if not session:
            raise HTTPException(
                status_code=404,
                detail="Session not found",
            )

        answers = _load_json(session.answers, {})

        prediction = predict_with_ml(answers)

        active_symptoms = [
            k for k, v in answers.items()
            if v is True
        ]

        ai_result = None
        ai_model = None

        try:
            ai_result, ai_model = await asyncio.wait_for(
                call_openrouter(
                    prediction["disease"],
                    prediction["risk"],
                    active_symptoms,
                    prediction["confidence"],
                ),
                timeout=90,
            )

        except Exception as exc:
            logger.warning(f"OpenRouter failed: {exc}")

        recommendation = build_recommendation(
            prediction["disease"],
            prediction["risk"],
            ai_result,
        )

        diagnosis = DiagnosisModel(
            user_id=user_id,
            session_id=session_id,
            disease=prediction["disease"],
            risk=prediction["risk"],
            confidence=prediction["confidence"],
            answers=_dump_json(answers),
            active_symptoms=_dump_json(active_symptoms),
            rec_home_care=recommendation["home_care"],
            rec_test=recommendation["test"],
            rec_doctor=recommendation["doctor"],
            rec_safety=recommendation["safety"],
            ai_explanation=recommendation["explanation"],
            ml_scores=_dump_json(prediction["all_scores"]),
            ai_model_used=ai_model,
        )

        db.add(diagnosis)
        db.commit()
        db.refresh(diagnosis)

        return {
            "id": diagnosis.id,
            "disease": prediction["disease"],
            "risk": prediction["risk"],
            "confidence": prediction["confidence"],
            "method": prediction["method"],
            "ai_used": ai_result is not None,
            "ai_model_used": ai_model,
            "all_scores": prediction["all_scores"],
            "recommendation": recommendation,
        }

    except Exception as exc:
        logger.exception(exc)

        raise HTTPException(
            status_code=500,
            detail="Diagnosis engine failed",
        )

# ============================================================
# HISTORY ROUTE
# ============================================================

@app.get("/api/v1/patient/history")
async def patient_history(
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):

    rows = db.query(DiagnosisModel).filter(
        DiagnosisModel.user_id == user_id
    ).order_by(
        DiagnosisModel.created_at.desc()
    ).all()

    return [
        {
            "id": row.id,
            "disease": row.disease,
            "risk": row.risk,
            "confidence": row.confidence,
            "created_at": row.created_at.isoformat(),
            "ai_model_used": row.ai_model_used,
        }
        for row in rows
    ]

# ============================================================
# RUN SERVER
# ============================================================

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", 8000)),
        reload=False,
    )

