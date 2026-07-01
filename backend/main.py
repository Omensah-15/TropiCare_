"""
TropiCare API
"""

from __future__ import annotations

# -----------------------------------------------------------------
# STDLIB
# -----------------------------------------------------------------
import asyncio
import hashlib
import json
import logging
import math
import os
import re
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

# -----------------------------------------------------------------
# THIRD-PARTY
# -----------------------------------------------------------------
import aiohttp
import numpy as np
from dotenv import load_dotenv
from jose import JWTError, jwt
from pythonjsonlogger import jsonlogger

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    create_engine,
    event,
    inspect,
    text,
)
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from prometheus_fastapi_instrumentator import Instrumentator
from prometheus_client import Counter, Gauge, Histogram

from apscheduler.schedulers.asyncio import AsyncIOScheduler

import pybreaker

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileModifiedEvent

try:
    import joblib
    JOBLIB_AVAILABLE = True
except ImportError:
    JOBLIB_AVAILABLE = False

try:
    import aioredis
    AIOREDIS_AVAILABLE = True
except ImportError:
    AIOREDIS_AVAILABLE = False

load_dotenv()

# -----------------------------------------------------------------
# CONFIG
# -----------------------------------------------------------------

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    secret_key: str               = "tropicare-fallback-secret-2024"
    algorithm: str                = "HS256"
    access_token_expire_days: int = 7
    database_url: str             = "sqlite:///./tropicare.db"
    allowed_origins: str          = "*"
    port: int                     = 8000

    admin_user_id: int = 1

    openrouter_api_key: str = ""
    openrouter_url: str     = "https://openrouter.ai/api/v1/chat/completions"
    openrouter_model: str   = "mistralai/mistral-7b-instruct:free"
    site_url: str           = "http://localhost:8000"
    site_name: str          = "TropiCare"

    redis_url: str = "redis://localhost:6379/0"

    enable_ai_cache: bool      = True
    enable_rate_limiting: bool = True
    async_mode: bool           = True

    db_pool_min: int = 5
    db_pool_max: int = 20

    max_body_size: int = 5 * 1024 * 1024

    @property
    def origins_list(self) -> list[str]:
        raw = self.allowed_origins.strip()
        if raw == "*":
            return ["*"]
        return [o.strip() for o in raw.split(",") if o.strip()]


settings = Settings()
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

# -----------------------------------------------------------------
# LOGGING
# -----------------------------------------------------------------

def _build_logger(name: str) -> logging.Logger:
    handler = logging.StreamHandler()
    formatter = jsonlogger.JsonFormatter(
        fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    handler.setFormatter(formatter)
    log = logging.getLogger(name)
    log.setLevel(logging.INFO)
    log.handlers = [handler]
    log.propagate = False
    return log


logger = _build_logger("tropicare")

# -----------------------------------------------------------------
# PROMETHEUS METRICS
# -----------------------------------------------------------------

OPENROUTER_LATENCY = Histogram(
    "tropicare_openrouter_latency_seconds",
    "OpenRouter call duration",
    buckets=[0.1, 0.5, 1, 2, 5, 10, 15],
)
OPENROUTER_ERRORS = Counter(
    "tropicare_openrouter_errors_total",
    "OpenRouter error count",
    ["reason"],
)
CACHE_HITS   = Counter("tropicare_cache_hits_total",   "Redis cache hits",   ["key_type"])
CACHE_MISSES = Counter("tropicare_cache_misses_total",  "Redis cache misses", ["key_type"])
CB_STATE     = Gauge("tropicare_circuit_breaker_open",  "Circuit breaker open (1=open)")
DB_POOL_ACTIVE = Gauge("tropicare_db_pool_active", "DB pool active connections")
DB_POOL_IDLE   = Gauge("tropicare_db_pool_idle",   "DB pool idle connections")
SESSION_CLEANUP_RUNS = Counter("tropicare_session_cleanup_runs_total", "Session cleanup scheduler runs")
SCHEMA_MIGRATIONS_APPLIED = Counter(
    "tropicare_schema_migrations_applied_total",
    "Columns added to existing tables at startup",
    ["table", "column"],
)
CLINIC_SOURCE_ERRORS = Counter(
    "tropicare_clinic_source_errors_total",
    "Clinic data source failures",
    ["source", "reason"],
)

# -----------------------------------------------------------------
# REDIS
# -----------------------------------------------------------------

_redis: Optional[Any] = None


async def get_redis() -> Optional[Any]:
    global _redis
    if not AIOREDIS_AVAILABLE or not settings.enable_ai_cache:
        return None
    if _redis is None:
        try:
            _redis = await aioredis.from_url(
                settings.redis_url,
                encoding="utf-8",
                decode_responses=True,
                max_connections=20,
            )
            await _redis.ping()
        except Exception as e:
            logger.warning({"event": "redis_connect_failed", "error": str(e)})
            _redis = None
    return _redis


async def cache_get(key: str, key_type: str = "generic") -> Optional[str]:
    r = await get_redis()
    if r is None:
        return None
    try:
        val = await r.get(key)
        if val is not None:
            CACHE_HITS.labels(key_type=key_type).inc()
        else:
            CACHE_MISSES.labels(key_type=key_type).inc()
        return val
    except Exception:
        return None


async def cache_set(key: str, value: str, ttl: int) -> None:
    r = await get_redis()
    if r is None:
        return
    try:
        await r.setex(key, ttl, value)
    except Exception:
        pass


async def cache_delete(key: str) -> None:
    r = await get_redis()
    if r is None:
        return
    try:
        await r.delete(key)
    except Exception:
        pass


# -----------------------------------------------------------------
# DATABASE
# -----------------------------------------------------------------

_connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}

_pool_kwargs: dict = {}
if not settings.database_url.startswith("sqlite"):
    _pool_kwargs = {
        "pool_size":     settings.db_pool_min,
        "max_overflow":  settings.db_pool_max - settings.db_pool_min,
        "pool_pre_ping": True,
    }

engine = create_engine(
    settings.database_url,
    connect_args=_connect_args,
    **_pool_kwargs,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


@event.listens_for(engine, "checkout")
def _on_checkout(dbapi_conn, conn_record, conn_proxy):
    try:
        pool = engine.pool
        DB_POOL_ACTIVE.set(getattr(pool, "_checked_out", 0))
        idle_queue = getattr(pool, "_pool", None)
        DB_POOL_IDLE.set(idle_queue.qsize() if idle_queue is not None else 0)
    except Exception:
        # Pool internals vary by SQLAlchemy pool implementation (e.g. SQLite's
        # StaticPool/NullPool do not expose the same attributes as QueuePool).
        # Metrics are best-effort and must never break a real DB checkout.
        pass


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

    id                    = Column(Integer, primary_key=True, index=True)
    user_id               = Column(Integer, ForeignKey("users.id"), nullable=False)
    session_id            = Column(String(64), index=True)
    disease               = Column(String(100))
    risk                  = Column(String(20))
    confidence            = Column(Float)
    answers               = Column(Text)
    active_symptoms       = Column(Text)
    rec_home_care         = Column(Text, nullable=True)
    rec_test              = Column(Text, nullable=True)
    rec_doctor            = Column(Text, nullable=True)
    rec_safety            = Column(Text, nullable=True)
    ai_explanation        = Column(Text, nullable=True)
    ml_scores             = Column(Text, nullable=True)
    confidence_trajectory = Column(Text, nullable=True)
    created_at            = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_diagnoses_user_created", "user_id", "created_at"),
        Index("ix_diagnoses_user_risk",    "user_id", "risk"),
    )


class SessionModel(Base):
    __tablename__ = "assessment_sessions"

    id              = Column(Integer, primary_key=True, index=True)
    session_id      = Column(String(64), unique=True, index=True)
    user_id         = Column(Integer, ForeignKey("users.id"), nullable=False)
    answers         = Column(Text, default="{}")
    asked_questions = Column(Text, default="[]")
    trajectory      = Column(Text, default="[]")
    completed       = Column(Boolean, default=False)
    created_at      = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_sessions_user_completed", "user_id", "completed"),
    )


# -----------------------------------------------------------------
# SCHEMA AUTO-MIGRATION
#
# This project does not use Alembic. Base.metadata.create_all() only creates
# tables that do not exist yet -- it silently does NOT add new columns to
# tables that already exist in the live database. That mismatch is exactly
# what caused `trajectory` (assessment_sessions) and `confidence_trajectory`
# (diagnoses) to be missing on Render/Neon after being added to the ORM
# models here, which made every INSERT touching those columns fail and get
# swallowed by the frontend's offline fallback -- so results displayed
# correctly in the UI but were never actually persisted, and history/records
# stayed empty.
#
# This function inspects the live table definitions at startup and adds any
# column that exists on the ORM model but not in the actual table, so future
# column additions can never silently break persistence again. It is
# defensive: each column is added in its own try/except so one failure does
# not block startup or other migrations.
# -----------------------------------------------------------------

def run_schema_migrations() -> None:
    try:
        inspector = inspect(engine)
        existing_tables = set(inspector.get_table_names())
    except Exception as e:
        logger.error({"event": "schema_migration_inspect_failed", "error": str(e)})
        return

    for model in (UserModel, SessionModel, DiagnosisModel):
        table = model.__table__
        if table.name not in existing_tables:
            # Brand-new table: Base.metadata.create_all() already created it
            # with every current column, so there is nothing to migrate.
            continue

        try:
            existing_cols = {c["name"] for c in inspector.get_columns(table.name)}
        except Exception as e:
            logger.error({
                "event": "schema_migration_columns_failed",
                "table": table.name,
                "error": str(e),
            })
            continue

        for column in table.columns:
            if column.name in existing_cols:
                continue

            try:
                col_type = column.type.compile(dialect=engine.dialect)
                default_clause = ""
                if column.default is not None and getattr(column.default, "is_scalar", False):
                    default_value = column.default.arg
                    if isinstance(default_value, str):
                        default_clause = f" DEFAULT '{default_value}'"
                    elif isinstance(default_value, bool):
                        default_clause = f" DEFAULT {str(default_value).upper()}"
                    elif isinstance(default_value, (int, float)):
                        default_clause = f" DEFAULT {default_value}"

                ddl = f"ALTER TABLE {table.name} ADD COLUMN {column.name} {col_type}{default_clause}"
                with engine.begin() as conn:
                    conn.execute(text(ddl))

                SCHEMA_MIGRATIONS_APPLIED.labels(table=table.name, column=column.name).inc()
                logger.info({
                    "event": "schema_migration_applied",
                    "table": table.name,
                    "column": column.name,
                    "ddl": ddl,
                })
            except Exception as e:
                logger.error({
                    "event": "schema_migration_failed",
                    "table": table.name,
                    "column": column.name,
                    "error": str(e),
                })


# -----------------------------------------------------------------
# DB HELPERS
# -----------------------------------------------------------------

def _load_json(value: Optional[str], default: Any) -> Any:
    if value is None:
        return default
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


def _dump_json(value: Any) -> str:
    return json.dumps(value)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


async def run_db(func, *args, **kwargs):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: func(*args, **kwargs))


# -----------------------------------------------------------------
# ML MODELS + HOT-RELOAD
# -----------------------------------------------------------------

LOADED_MODELS: Dict[str, Any]      = {}
PREVIOUS_MODELS: Dict[str, Any]    = {}
ML_STARTUP_COMPLETE: asyncio.Event = asyncio.Event()


def _load_single_model(fname: str) -> None:
    key  = fname.replace(".pkl", "")
    path = os.path.join(MODELS_DIR, fname)
    try:
        candidate              = joblib.load(path)
        PREVIOUS_MODELS[key]   = LOADED_MODELS.get(key)
        LOADED_MODELS[key]     = candidate
        logger.info({"event": "model_loaded", "file": fname})
    except Exception as e:
        logger.error({"event": "model_load_failed", "file": fname, "error": str(e)})
        if key in PREVIOUS_MODELS and PREVIOUS_MODELS[key] is not None:
            LOADED_MODELS[key] = PREVIOUS_MODELS[key]
            logger.warning({"event": "model_rollback", "key": key})


def load_ml_models() -> None:
    if not JOBLIB_AVAILABLE:
        logger.info({"event": "ml_skip", "reason": "joblib not available"})
        ML_STARTUP_COMPLETE.set()
        return
    os.makedirs(MODELS_DIR, exist_ok=True)
    pkl_files = [f for f in os.listdir(MODELS_DIR) if f.endswith(".pkl")]
    if not pkl_files:
        logger.info({"event": "ml_skip", "reason": "no .pkl files found"})
        ML_STARTUP_COMPLETE.set()
        return
    for fname in pkl_files:
        _load_single_model(fname)
    ML_STARTUP_COMPLETE.set()


class _ModelFileHandler(FileSystemEventHandler):
    def on_modified(self, event):
        if isinstance(event, FileModifiedEvent) and event.src_path.endswith(".pkl"):
            fname = os.path.basename(event.src_path)
            logger.info({"event": "model_change_detected", "file": fname})
            _load_single_model(fname)


_watchdog_observer: Optional[Observer] = None


def start_model_watcher() -> None:
    global _watchdog_observer
    if not JOBLIB_AVAILABLE:
        return
    os.makedirs(MODELS_DIR, exist_ok=True)
    _watchdog_observer = Observer()
    _watchdog_observer.schedule(_ModelFileHandler(), MODELS_DIR, recursive=False)
    _watchdog_observer.start()
    logger.info({"event": "model_watcher_started", "dir": MODELS_DIR})


def stop_model_watcher() -> None:
    if _watchdog_observer:
        _watchdog_observer.stop()
        _watchdog_observer.join()


# -----------------------------------------------------------------
# DISEASE DATA
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
    "Malaria":                {"home_care":"Rest and drink plenty of fluids","test":"Malaria RDT or blood smear","doctor":"Go to clinic immediately for antimalarial treatment","safety":"Do not delay - malaria can become severe quickly"},
    "Typhoid":                {"home_care":"Rest, eat soft foods, drink clean water only","test":"Widal test or blood culture","doctor":"See a doctor for antibiotic prescription","safety":"Avoid spreading infection - wash hands frequently"},
    "Dengue":                 {"home_care":"Rest and drink fluids - avoid aspirin or ibuprofen","test":"Dengue NS1 antigen test","doctor":"Seek care immediately if you notice bleeding or severe pain","safety":"Aspirin can worsen bleeding in dengue"},
    "Tuberculosis":           {"home_care":"Rest, isolate yourself, keep room well-ventilated","test":"Chest X-ray and sputum test","doctor":"Visit a TB clinic immediately","safety":"TB is contagious - wear a mask and avoid crowded places"},
    "Hepatitis B":            {"home_care":"Rest and avoid alcohol completely","test":"Hepatitis B surface antigen (HBsAg) test","doctor":"See a doctor for antiviral medication evaluation","safety":"Hepatitis B is contagious - avoid sharing needles or razors"},
    "Hepatitis C":            {"home_care":"Rest and avoid alcohol","test":"Hepatitis C antibody test","doctor":"See a specialist for antiviral treatment","safety":"Avoid sharing sharp objects with others"},
    "Hepatitis D":            {"home_care":"Rest and stop alcohol completely","test":"Hepatitis D antibody and liver function tests","doctor":"Seek specialist care urgently","safety":"Hepatitis D only occurs with hepatitis B - urgent care needed"},
    "Pneumonia":              {"home_care":"Rest, keep warm, drink warm fluids","test":"Chest X-ray","doctor":"Visit clinic immediately for antibiotic treatment","safety":"Pneumonia can worsen quickly - do not wait"},
    "Hepatitis A":            {"home_care":"Rest and drink clean water - eat lightly","test":"Hepatitis A IgM antibody test","doctor":"See a doctor if symptoms worsen","safety":"Avoid sharing food or drinks with others"},
    "Hepatitis E":            {"home_care":"Rest and drink clean water only","test":"Hepatitis E IgM antibody test","doctor":"See a doctor - especially important if pregnant","safety":"Very dangerous during pregnancy - seek care urgently if pregnant"},
    "Alcoholic Hepatitis":    {"home_care":"Stop alcohol completely and eat well","test":"Liver function tests (LFTs)","doctor":"Seek medical care urgently","safety":"Continued alcohol use can be fatal with this condition"},
    "Jaundice":               {"home_care":"Rest and drink clean water","test":"Liver function tests and bilirubin level","doctor":"See a doctor to find the underlying cause","safety":"Jaundice is a sign of another condition - do not ignore it"},
    "Chicken Pox":            {"home_care":"Rest, avoid scratching, apply calamine lotion","test":"No test usually needed","doctor":"See a doctor if blisters become infected or fever is very high","safety":"Highly contagious - stay home and avoid contact with others"},
    "Bronchial Asthma":       {"home_care":"Avoid triggers and use your prescribed inhaler","test":"Peak flow measurement or spirometry","doctor":"See a doctor for long-term management plan","safety":"Carry your inhaler at all times"},
    "Urinary Tract Infection":{"home_care":"Drink plenty of water and avoid spicy food","test":"Urine culture and sensitivity test","doctor":"See a doctor for antibiotic prescription","safety":"Do not hold urine - empty your bladder regularly"},
    "Dimorphic Haemorrhoids": {"home_care":"Eat high-fibre foods and avoid straining on the toilet","test":"No test usually needed","doctor":"See a doctor if bleeding continues or worsens","safety":"Avoid sitting for long periods"},
    "Peptic Ulcer Disease":   {"home_care":"Avoid spicy food, alcohol and pain tablets like aspirin","test":"H. pylori breath test or endoscopy if needed","doctor":"See a doctor for antacid or antibiotic treatment","safety":"Avoid aspirin and ibuprofen - they worsen ulcers"},
    "Diabetes":               {"home_care":"Reduce sugar and refined carbohydrates in your diet","test":"Fasting blood glucose and HbA1c test","doctor":"See a doctor for a diabetes management plan","safety":"Monitor your blood sugar regularly if you have a glucometer"},
    "Fungal Infection":       {"home_care":"Keep the affected area dry and clean","test":"No test usually needed","doctor":"Visit a pharmacy for antifungal cream","safety":"Avoid sharing personal items like socks or towels"},
    "Allergy":                {"home_care":"Avoid known triggers and stay indoors during high pollen periods","test":"Allergy skin prick test if symptoms are recurrent","doctor":"See a doctor for antihistamine prescription","safety":"If you have throat swelling or difficulty breathing - go to emergency immediately"},
    "Common Cold":            {"home_care":"Rest and drink warm fluids","test":"No test needed","doctor":"Visit clinic if symptoms persist beyond 7 days","safety":"Wash hands frequently to avoid spreading"},
    "Drug Reaction":          {"home_care":"Stop the suspected medication immediately","test":"No test usually needed","doctor":"See a doctor immediately if rash spreads or breathing is affected","safety":"Seek emergency care if you have throat swelling or difficulty breathing"},
}

# -----------------------------------------------------------------
# CIRCUIT BREAKER
# -----------------------------------------------------------------

class _CBListener(pybreaker.CircuitBreakerListener):
    def state_change(self, cb, old_state, new_state):
        is_open = 1 if str(new_state) == "open" else 0
        CB_STATE.set(is_open)
        logger.warning({"event": "circuit_breaker_state_change", "from": str(old_state), "to": str(new_state)})


_openrouter_cb = pybreaker.CircuitBreaker(
    fail_max=3,
    reset_timeout=60,
    listeners=[_CBListener()],
)

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


def compute_score_snapshot(answers: dict) -> Dict[str, float]:
    ensemble = LOADED_MODELS.get("sctd_ensemble")
    le       = LOADED_MODELS.get("sctd_label_encoder")
    cols     = LOADED_MODELS.get("sctd_feature_columns")

    if ensemble and le and cols:
        try:
            feature_cols = list(cols)
            vec = np.array(
                [1.0 if answers.get(c, False) else 0.0 for c in feature_cols]
            ).reshape(1, -1)
            proba = ensemble.predict_proba(vec)[0]
            return {
                le.inverse_transform([i])[0]: round(float(p), 4)
                for i, p in enumerate(proba)
            }
        except Exception as e:
            logger.warning({"event": "snapshot_ml_failed", "error": str(e)})

    snapshot: Dict[str, float] = {}
    for d, syms in DISEASE_SYMPTOM_MAP.items():
        yc = sum(1 for s in syms if answers.get(s) is True)
        tc = max(len(syms), 1)
        snapshot[d] = round(min(0.95, yc / tc), 4) if yc else 0.0
    return snapshot


def predict_with_ml(answers: dict) -> dict:
    ensemble = LOADED_MODELS.get("sctd_ensemble")
    le       = LOADED_MODELS.get("sctd_label_encoder")
    cols     = LOADED_MODELS.get("sctd_feature_columns")
    risk_map = LOADED_MODELS.get("sctd_risk_classification") or RISK_MAP

    yes_count = sum(1 for v in answers.values() if v is True)

    if yes_count < 2:
        return {
            "disease":    None,
            "confidence": 0.0,
            "risk":       "None",
            "all_scores": {},
            "method":     "insufficient_evidence",
        }

    if ensemble and le and cols:
        try:
            feature_cols = list(cols)
            vec = np.array(
                [1.0 if answers.get(c, False) else 0.0 for c in feature_cols]
            ).reshape(1, -1)
            proba      = ensemble.predict_proba(vec)[0]
            idx        = int(np.argmax(proba))
            confidence = float(proba[idx])

            if confidence < 0.15:
                return {
                    "disease":    None,
                    "confidence": confidence,
                    "risk":       "None",
                    "all_scores": {},
                    "method":     "insufficient_evidence",
                }

            disease   = le.inverse_transform([idx])[0]
            all_probs = {
                le.inverse_transform([i])[0]: round(float(p), 4)
                for i, p in enumerate(proba)
            }
            return {
                "disease":    disease,
                "confidence": confidence,
                "risk":       risk_map.get(disease, "Medium"),
                "all_scores": dict(sorted(all_probs.items(), key=lambda x: x[1], reverse=True)),
                "method":     "ml",
            }
        except Exception as e:
            logger.warning({"event": "ml_predict_failed", "error": str(e)})

    scores        = {d: score_disease(d, answers) for d in DISEASE_SYMPTOM_MAP}
    sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    best_disease, best_score = sorted_scores[0]

    if best_score <= 0:
        return {
            "disease":    None,
            "confidence": 0.0,
            "risk":       "None",
            "all_scores": {},
            "method":     "insufficient_evidence",
        }

    syms         = DISEASE_SYMPTOM_MAP.get(best_disease, [])
    yes_for_best = sum(1 for s in syms if answers.get(s) is True)
    confidence   = min(0.95, max(0.10, yes_for_best / max(len(syms), 1)))

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
        "method":     "scoring",
    }


# -----------------------------------------------------------------
# OPENROUTER AI
# -----------------------------------------------------------------

_RETRY_BASE  = 1.0
_RETRY_MAX   = 10.0
_RETRY_TIMES = 2


async def _do_openrouter_request(headers: dict, payload: dict) -> Optional[dict]:
    async with aiohttp.ClientSession() as session:
        async with session.post(
            settings.openrouter_url,
            headers=headers,
            json=payload,
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            if resp.status >= 500:
                body = await resp.text()
                OPENROUTER_ERRORS.labels(reason="5xx").inc()
                logger.warning({"event": "openrouter_5xx", "status": resp.status, "body": body[:200]})
                raise aiohttp.ClientResponseError(
                    resp.request_info, resp.history, status=resp.status
                )
            if resp.status != 200:
                logger.warning({"event": "openrouter_non200", "status": resp.status})
                return None
            data   = await resp.json()
            raw    = data["choices"][0]["message"]["content"].strip()
            raw    = raw.replace("```json", "").replace("```", "").strip()
            result = json.loads(raw)
            for key in ("explanation", "home_care", "test", "doctor", "safety"):
                if key not in result:
                    result[key] = ""
            return result


async def _call_openrouter_through_breaker(headers: dict, payload: dict) -> Optional[dict]:
    """
    Routes the actual HTTP call through the module-level circuit breaker so
    repeated OpenRouter failures actually open the breaker (and short-circuit
    further calls until reset_timeout elapses) instead of the breaker object
    sitting unused while every call goes straight to the network.
    """
    if hasattr(_openrouter_cb, "call_async"):
        return await _openrouter_cb.call_async(_do_openrouter_request, headers, payload)
    # Fallback for pybreaker versions without call_async: manually honour
    # breaker state around the async call.
    if _openrouter_cb.current_state == "open":
        raise pybreaker.CircuitBreakerError("Circuit breaker is open")
    try:
        result = await _do_openrouter_request(headers, payload)
    except Exception:
        _openrouter_cb._state_storage.increment_counter()
        raise
    else:
        _openrouter_cb._state_storage.reset_counter()
        return result


async def call_openrouter(
    disease: str,
    risk: str,
    active_syms: List[str],
    confidence: float,
) -> Optional[dict]:
    if not settings.openrouter_api_key:
        logger.info({"event": "openrouter_skip", "reason": "no api key"})
        return None

    cache_key = f"ai_response:{disease}"
    if settings.enable_ai_cache:
        cached = await cache_get(cache_key, key_type="ai_response")
        if cached:
            try:
                return json.loads(cached)
            except Exception:
                pass

    sym_text = ", ".join(s.replace("_", " ") for s in active_syms[:12]) or "general symptoms"
    urgency  = {
        "High":   "URGENT - recommend visiting a hospital or clinic today",
        "Medium": "advise a clinic visit within 1-2 days if symptoms persist",
        "Low":    "advise rest at home and a clinic visit only if symptoms worsen",
    }.get(risk, "advise a clinic visit")

    prompt = f"""You are a health assistant helping patients in Ghana and West Africa.

Patient symptoms: {sym_text}
Likely condition: {disease} (confidence: {round(confidence * 100)}%)
Risk level: {risk} - {urgency}

Reply ONLY with a valid JSON object. No markdown. No extra text. Use this exact format:
{{
  "explanation": "One short sentence on why these symptoms suggest {disease}.",
  "home_care": "1-2 simple things the patient can do at home right now.",
  "test": "One specific lab test or medical test to confirm, or 'No test needed' if not required.",
  "doctor": "One clear instruction - visit hospital, clinic, or pharmacy.",
  "safety": "One brief safety warning if High risk, or empty string if Low/Medium."
}}

Rules:
- Use plain, simple language. No medical jargon.
- Keep each field to one sentence or a short phrase.
- For High risk: always say to visit a hospital or clinic immediately.
- Never invent drug names or dosages."""

    headers = {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type":  "application/json",
        "HTTP-Referer":  settings.site_url,
        "X-Title":       settings.site_name,
    }
    payload = {
        "model": settings.openrouter_model,
        "messages": [
            {
                "role":    "system",
                "content": (
                    "You are a responsible clinical AI assistant for a tropical disease app. "
                    "Always respond with valid JSON only. Never prescribe specific drugs or dosages."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "max_tokens":  350,
        "temperature": 0.2,
    }

    last_error: Optional[Exception] = None
    for attempt in range(_RETRY_TIMES + 1):
        try:
            t0     = time.monotonic()
            result = await _call_openrouter_through_breaker(headers, payload)
            OPENROUTER_LATENCY.observe(time.monotonic() - t0)
            if result and settings.enable_ai_cache:
                await cache_set(cache_key, json.dumps(result), ttl=86400)
            return result
        except pybreaker.CircuitBreakerError:
            OPENROUTER_ERRORS.labels(reason="circuit_open").inc()
            logger.warning({"event": "openrouter_circuit_open"})
            fallback = await cache_get(cache_key, key_type="ai_fallback")
            if fallback:
                try:
                    return json.loads(fallback)
                except Exception:
                    pass
            return None
        except asyncio.TimeoutError:
            OPENROUTER_ERRORS.labels(reason="timeout").inc()
            last_error = asyncio.TimeoutError()
            logger.warning({"event": "openrouter_timeout", "attempt": attempt})
        except json.JSONDecodeError as e:
            OPENROUTER_ERRORS.labels(reason="json_parse").inc()
            logger.warning({"event": "openrouter_json_error", "error": str(e)})
            return None
        except aiohttp.ClientError as e:
            OPENROUTER_ERRORS.labels(reason="client_error").inc()
            last_error = e
            logger.warning({"event": "openrouter_client_error", "error": str(e)})
        except Exception as e:
            OPENROUTER_ERRORS.labels(reason="unexpected").inc()
            logger.warning({"event": "openrouter_unexpected", "error": str(e)})
            return None

        if attempt < _RETRY_TIMES:
            wait = min(_RETRY_BASE * (2 ** attempt), _RETRY_MAX)
            logger.info({"event": "openrouter_retry", "wait_s": wait, "attempt": attempt + 1})
            await asyncio.sleep(wait)

    logger.warning({"event": "openrouter_all_retries_failed", "error": str(last_error)})
    return None


def build_recommendation(disease: str, risk: str, ai_result: Optional[dict]) -> dict:
    default = DEFAULT_RECS.get(disease, {
        "home_care": "Rest and stay hydrated.",
        "test":      "Consult a healthcare provider for appropriate tests.",
        "doctor":    "Visit a clinic if symptoms persist or worsen.",
        "safety":    "Seek emergency care if symptoms become severe." if risk == "High" else "",
    })
    if ai_result:
        return {
            "home_care":   ai_result.get("home_care")   or default["home_care"],
            "test":        ai_result.get("test")        or default["test"],
            "doctor":      ai_result.get("doctor")      or default["doctor"],
            "safety":      ai_result.get("safety")      or default.get("safety", ""),
            "explanation": ai_result.get("explanation") or f"Your symptoms are consistent with {disease}.",
        }
    return {**default, "explanation": f"Your symptoms are consistent with {disease}."}


# -----------------------------------------------------------------
# CLINIC FINDER (server-side proxy)
#
# The nearby-clinics feature was originally implemented by calling public
# Overpass API mirrors directly from the browser. In production this proved
# unreliable: overpass-api.de intermittently omits CORS headers on its GET
# endpoint (the browser reports this as a CORS failure even though the
# underlying cause is server-side, often rate limiting), and the remaining
# free mirrors vary widely in latency and uptime. None of that is fixable
# from client-side code.
#
# Routing the request through this backend removes the problem entirely:
# server-to-server HTTP calls are not subject to CORS at all, and this
# server controls its own timeouts, retries, and caching. Results are
# cached in Redis per rounded coordinate so repeat lookups near the same
# location do not re-hit the upstream data source.
# -----------------------------------------------------------------

CLINIC_DATA_SOURCES: List[str] = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]
CLINIC_SEARCH_RADIUS_M = 6000
CLINIC_SOURCE_TIMEOUT_S = 12
CLINIC_CACHE_TTL_S = 21600  # 6 hours


def _build_clinic_query(lat: float, lon: float, radius_m: int) -> str:
    return (
        f'[out:json][timeout:20];('
        f'node["amenity"="hospital"](around:{radius_m},{lat},{lon});'
        f'way["amenity"="hospital"](around:{radius_m},{lat},{lon});'
        f'node["amenity"="clinic"](around:{radius_m},{lat},{lon});'
        f'way["amenity"="clinic"](around:{radius_m},{lat},{lon});'
        f'node["amenity"="doctors"](around:{radius_m},{lat},{lon});'
        f'node["amenity"="pharmacy"](around:{radius_m},{lat},{lon});'
        f'node["healthcare"="pharmacy"](around:{radius_m},{lat},{lon});'
        f');out center 40;'
    )


async def _query_clinic_source(
    session: aiohttp.ClientSession, source: str, query: str
) -> Optional[List[dict]]:
    try:
        async with session.post(
            source,
            data=query,
            headers={"Content-Type": "text/plain"},
            timeout=aiohttp.ClientTimeout(total=CLINIC_SOURCE_TIMEOUT_S),
        ) as resp:
            if resp.status != 200:
                CLINIC_SOURCE_ERRORS.labels(source=source, reason=f"http_{resp.status}").inc()
                logger.warning({"event": "clinic_source_bad_status", "source": source, "status": resp.status})
                return None
            data = await resp.json()
            elements = data.get("elements", [])
            if not elements:
                CLINIC_SOURCE_ERRORS.labels(source=source, reason="empty").inc()
                return None
            return elements
    except asyncio.TimeoutError:
        CLINIC_SOURCE_ERRORS.labels(source=source, reason="timeout").inc()
        logger.warning({"event": "clinic_source_timeout", "source": source})
        return None
    except Exception as e:
        CLINIC_SOURCE_ERRORS.labels(source=source, reason="error").inc()
        logger.warning({"event": "clinic_source_error", "source": source, "error": str(e)})
        return None


async def _fetch_clinic_elements(lat: float, lon: float) -> List[dict]:
    query = _build_clinic_query(lat, lon, CLINIC_SEARCH_RADIUS_M)
    async with aiohttp.ClientSession() as session:
        for source in CLINIC_DATA_SOURCES:
            elements = await _query_clinic_source(session, source, query)
            if elements:
                return elements
    return []


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _extract_clinic_places(elements: List[dict], user_lat: float, user_lon: float) -> List[dict]:
    places: List[dict] = []
    seen: set = set()

    for el in elements:
        lat = el.get("lat")
        lon = el.get("lon")
        if lat is None or lon is None:
            center = el.get("center") or {}
            lat = center.get("lat")
            lon = center.get("lon")
        if lat is None or lon is None:
            continue

        tags = el.get("tags", {})
        name = tags.get("name") or tags.get("name:en") or "Unnamed facility"
        amenity = tags.get("amenity")
        healthcare = tags.get("healthcare")

        if amenity == "hospital":
            facility_type = "Hospital"
        elif amenity == "clinic":
            facility_type = "Clinic"
        elif amenity == "doctors":
            facility_type = "Doctor's Office"
        elif amenity == "pharmacy" or healthcare == "pharmacy":
            facility_type = "Pharmacy"
        else:
            facility_type = "Health Facility"

        address = ", ".join(
            p for p in (tags.get("addr:street"), tags.get("addr:city") or tags.get("addr:suburb")) if p
        )

        dedupe_key = f"{name}-{round(lat, 3)}-{round(lon, 3)}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        places.append({
            "id":           f"{el.get('type')}/{el.get('id')}",
            "name":         name,
            "type":         facility_type,
            "address":      address,
            "lat":          lat,
            "lon":          lon,
            "distance_km":  round(_haversine_km(user_lat, user_lon, lat, lon), 2),
        })

    places.sort(key=lambda p: p["distance_km"])
    return places[:15]


# -----------------------------------------------------------------
# PYDANTIC SCHEMAS
# -----------------------------------------------------------------

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


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password:     str


# -----------------------------------------------------------------
# AUTH HELPERS
# -----------------------------------------------------------------

security = HTTPBearer()


def create_token(user_id: int) -> str:
    exp = datetime.utcnow() + timedelta(days=settings.access_token_expire_days)
    return jwt.encode({"sub": str(user_id), "exp": exp}, settings.secret_key, algorithm=settings.algorithm)


def verify_token(creds: HTTPAuthorizationCredentials = Depends(security)) -> int:
    try:
        payload = jwt.decode(creds.credentials, settings.secret_key, algorithms=[settings.algorithm])
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid token payload")
        return int(user_id)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def verify_admin(user_id: int = Depends(verify_token)) -> int:
    if user_id != settings.admin_user_id:
        raise HTTPException(status_code=403, detail="Admin access only")
    return user_id


def hash_pw(pw: str) -> str:
    salt   = secrets.token_hex(16)
    hashed = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 260_000).hex()
    return f"{salt}:{hashed}"


def verify_pw(pw: str, stored: str) -> bool:
    try:
        parts = stored.split(":", 1)
        if len(parts) != 2:
            return False
        salt, hashed = parts
        pbkdf2_result = hashlib.pbkdf2_hmac(
            "sha256", pw.encode(), salt.encode(), 260_000
        ).hex()
        if pbkdf2_result == hashed:
            return True
        legacy_result = hashlib.sha256((salt + pw).encode()).hexdigest()
        if legacy_result == hashed:
            return True
        return False
    except Exception:
        return False


# -----------------------------------------------------------------
# RATE LIMITER
# -----------------------------------------------------------------

limiter = Limiter(key_func=get_remote_address, enabled=settings.enable_rate_limiting)


# -----------------------------------------------------------------
# BACKGROUND SCHEDULER
# -----------------------------------------------------------------

_scheduler = AsyncIOScheduler()


async def _cleanup_stale_sessions() -> None:
    cutoff = datetime.utcnow() - timedelta(hours=2)
    db = SessionLocal()
    try:
        deleted = (
            db.query(SessionModel)
            .filter(
                SessionModel.completed == False,
                SessionModel.created_at < cutoff,
            )
            .delete(synchronize_session=False)
        )
        db.commit()
        SESSION_CLEANUP_RUNS.inc()
        logger.info({"event": "session_cleanup", "deleted": deleted})
    except Exception as e:
        logger.error({"event": "session_cleanup_error", "error": str(e)})
        db.rollback()
    finally:
        db.close()


# -----------------------------------------------------------------
# LIFESPAN
# -----------------------------------------------------------------

_pending_requests: int = 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    run_schema_migrations()
    load_ml_models()
    start_model_watcher()

    await get_redis()

    _scheduler.add_job(_cleanup_stale_sessions, "interval", hours=1, id="session_cleanup")
    _scheduler.start()

    model_keys = list(LOADED_MODELS.keys()) or ["none - using scoring engine"]
    logger.info({"event": "startup", "ml_models": model_keys, "openrouter": bool(settings.openrouter_api_key)})

    yield

    logger.info({"event": "shutdown_initiated"})
    deadline = asyncio.get_event_loop().time() + 30
    while _pending_requests > 0 and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.5)

    _scheduler.shutdown(wait=False)
    stop_model_watcher()
    r = await get_redis()
    if r:
        await r.close()
    engine.dispose()
    logger.info({"event": "shutdown_complete"})


# -----------------------------------------------------------------
# APP
# -----------------------------------------------------------------

app = FastAPI(
    title="TropiCare API",
    version="1.0.0",
    description="KNUST Final Year Project - AI Tropical Disease Checker",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(GZipMiddleware, minimum_size=1024)

# -----------------------------------------------------------------
# FIX: CORS — allow_credentials=True is incompatible with origins=["*"].
# When a specific origin list is provided via ALLOWED_ORIGINS env var,
# use it with credentials. When it is literally "*", switch to
# allow_credentials=False so browsers do not reject the preflight.
# -----------------------------------------------------------------
_origins = settings.origins_list
if _origins == ["*"]:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

Instrumentator().instrument(app).expose(app, endpoint="/metrics")

# -----------------------------------------------------------------
# MIDDLEWARE
# -----------------------------------------------------------------

_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _sanitize(value: str) -> str:
    return _CONTROL_CHAR_RE.sub("", value)


@app.middleware("http")
async def request_middleware(request: Request, call_next):
    global _pending_requests  # noqa: F824 - mutated below via += / -=

    if request.method == "OPTIONS":
        return await call_next(request)

    req_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    request.state.request_id = req_id

    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > settings.max_body_size:
        return JSONResponse(
            status_code=413,
            content={"detail": "Request body too large"},
            headers={"X-Request-ID": req_id},
        )

    if request.method in ("POST", "PUT", "PATCH"):
        ct = request.headers.get("content-type", "")
        if ct and "application/json" not in ct and "multipart" not in ct:
            return JSONResponse(
                status_code=415,
                content={"detail": "Content-Type must be application/json"},
                headers={"X-Request-ID": req_id},
            )

    start = time.monotonic()
    _pending_requests += 1

    user_id_log: Optional[int] = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        try:
            token = auth_header[7:]
            payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
            user_id_log = int(payload.get("sub", 0)) or None
        except Exception:
            pass

    try:
        response: Response = await asyncio.wait_for(call_next(request), timeout=30)
    except asyncio.TimeoutError:
        _pending_requests -= 1
        return JSONResponse(
            status_code=504,
            content={"detail": "Request timed out"},
            headers={"X-Request-ID": req_id},
        )
    finally:
        _pending_requests -= 1

    duration_ms = round((time.monotonic() - start) * 1000, 2)

    response.headers["X-Request-ID"]           = req_id
    response.headers["X-Content-Type-Options"]  = "nosniff"
    response.headers["X-Frame-Options"]         = "DENY"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

    # FIX: replaced "default-src 'none'" which blocked every browser request
    # from the Vercel frontend. The policy now allows:
    #   - API calls back to this server and the Vercel frontend origin
    #   - Inline scripts/styles that React injects
    #   - Google Fonts used by the frontend
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "connect-src 'self' https://tropicare.onrender.com https://*.vercel.app; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: blob:; "
        "frame-ancestors 'none';"
    )

    if user_id_log:
        response.headers["Cache-Control"] = "no-store"

    logger.info({
        "event":       "request",
        "request_id":  req_id,
        "method":      request.method,
        "path":        request.url.path,
        "status":      response.status_code,
        "duration_ms": duration_ms,
        "user_id":     user_id_log,
    })

    return response


# -----------------------------------------------------------------
# PASSWORD RATE LIMITING
# -----------------------------------------------------------------

async def _check_password_rate_limit(email: str) -> None:
    r = await get_redis()
    if r is None:
        return
    key = f"pw_attempts:{email}"
    try:
        count = await r.incr(key)
        if count == 1:
            await r.expire(key, 60)
        if count > 3:
            raise HTTPException(
                status_code=429,
                detail="Too many login attempts. Try again in a minute.",
                headers={"Retry-After": "60"},
            )
    except HTTPException:
        raise
    except Exception:
        pass


# -----------------------------------------------------------------
# HEALTH ENDPOINTS
# -----------------------------------------------------------------

@app.get("/api/v1/health")
async def health():
    return {
        "status":             "healthy",
        "timestamp":          datetime.utcnow().isoformat(),
        "ml_models":          list(LOADED_MODELS.keys()),
        "openrouter_enabled": bool(settings.openrouter_api_key),
        "openrouter_model":   settings.openrouter_model,
    }


@app.get("/health/live")
async def health_live():
    return {"status": "alive", "timestamp": datetime.utcnow().isoformat()}


@app.get("/health/ready")
async def health_ready():
    checks: Dict[str, str] = {}

    try:
        await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(
                None,
                lambda: SessionLocal().execute(text("SELECT 1"))
            ),
            timeout=5,
        )
        checks["db"] = "ok"
    except Exception as e:
        checks["db"] = f"fail: {e}"

    try:
        r = await asyncio.wait_for(get_redis(), timeout=5)
        if r:
            await asyncio.wait_for(r.ping(), timeout=5)
            checks["redis"] = "ok"
        else:
            checks["redis"] = "disabled"
    except Exception as e:
        checks["redis"] = f"fail: {e}"

    if settings.openrouter_api_key:
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get("https://openrouter.ai", timeout=aiohttp.ClientTimeout(total=5)) as resp:
                    checks["openrouter"] = "ok" if resp.status < 500 else f"fail: {resp.status}"
        except Exception as e:
            checks["openrouter"] = f"fail: {e}"
    else:
        checks["openrouter"] = "not_configured"

    all_ok = all(v in ("ok", "disabled", "not_configured") for v in checks.values())
    return JSONResponse(
        status_code=200 if all_ok else 503,
        content={"status": "ready" if all_ok else "not_ready", "checks": checks},
    )


@app.get("/health/startup")
async def health_startup():
    if ML_STARTUP_COMPLETE.is_set():
        return {"status": "started", "models": list(LOADED_MODELS.keys())}
    return JSONResponse(status_code=503, content={"status": "loading"})


# -----------------------------------------------------------------
# ROUTES - Auth
# -----------------------------------------------------------------

@app.post("/api/v1/auth/register", status_code=201)
@limiter.limit("100/hour")
async def register(request: Request, req: RegisterRequest, db: Session = Depends(get_db)):
    if db.query(UserModel).filter(UserModel.email == req.email).first():
        raise HTTPException(status_code=400, detail="Email already registered")
    user = UserModel(
        email=_sanitize(req.email),
        name=_sanitize(req.name),
        pw_hash=hash_pw(req.password),
        age=req.age,
        gender=req.gender,
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
@limiter.limit("100/hour")
async def login(request: Request, req: LoginRequest, db: Session = Depends(get_db)):
    await _check_password_rate_limit(req.email)
    user = db.query(UserModel).filter(UserModel.email == req.email).first()
    if not user or not user.pw_hash or not verify_pw(req.password, user.pw_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {
        "access_token": create_token(user.id),
        "token_type":   "bearer",
        "user":         {"id": user.id, "email": user.email, "name": user.name},
    }


# -----------------------------------------------------------------
# ROUTES - Assessment
# -----------------------------------------------------------------

@app.post("/api/v1/symptoms/start", status_code=201)
@limiter.limit("5/second")
async def start_assessment(
    request: Request,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    sid     = str(uuid.uuid4())
    session = SessionModel(
        session_id=sid,
        user_id=user_id,
        answers=_dump_json({}),
        asked_questions=_dump_json([]),
        trajectory=_dump_json([]),
    )
    db.add(session)
    db.commit()
    await cache_set(
        f"session:{sid}",
        _dump_json({"answers": {}, "asked": [], "completed": False}),
        ttl=3600,
    )
    return {
        "session_id":      sid,
        "first_question":  ALL_QUESTIONS[0],
        "total_questions": 15,
    }


@app.post("/api/v1/symptoms/next")
@limiter.limit("5/second")
async def next_question(
    request: Request,
    session_id: str,
    req: AnswerRequest,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    s = db.query(SessionModel).filter(
        SessionModel.session_id == session_id,
        SessionModel.user_id == user_id,
    ).first()
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    answers = _load_json(s.answers, {})
    asked   = _load_json(s.asked_questions, [])

    if req.question_id not in Q_INDEX:
        raise HTTPException(status_code=400, detail=f"Unknown question_id: {req.question_id}")

    answers[req.question_id] = req.answer
    if req.question_id not in asked:
        asked.append(req.question_id)

    trajectory = _load_json(s.trajectory, [])
    snapshot   = compute_score_snapshot(answers)
    top_scores = dict(sorted(snapshot.items(), key=lambda x: x[1], reverse=True)[:6])
    trajectory.append({
        "step":    len(asked),
        "symptom": req.question_id,
        "answer":  req.answer,
        "scores":  top_scores,
    })
    s.trajectory      = _dump_json(trajectory)
    s.answers         = _dump_json(answers)
    s.asked_questions = _dump_json(asked)
    db.commit()

    await cache_set(
        f"session:{session_id}",
        _dump_json({"answers": answers, "asked": asked, "completed": s.completed}),
        ttl=3600,
    )

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


# -----------------------------------------------------------------
# ROUTES - Diagnosis
# -----------------------------------------------------------------

@app.post("/api/v1/diagnosis/analyze")
@limiter.limit("5/second")
async def analyze(
    request: Request,
    session_id: str,
    background_tasks: BackgroundTasks,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    idem_key = request.headers.get("Idempotency-Key")
    if idem_key:
        cached_resp = await cache_get(f"idem:{idem_key}", key_type="idempotency")
        if cached_resp:
            return JSONResponse(content=json.loads(cached_resp))

    s = db.query(SessionModel).filter(
        SessionModel.session_id == session_id,
        SessionModel.user_id == user_id,
    ).first()
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    answers    = _load_json(s.answers, {})
    trajectory = _load_json(s.trajectory, [])
    pred       = predict_with_ml(answers)

    if pred["disease"] is None:
        response_body = {
            "id":          None,
            "disease":     None,
            "confidence":  0.0,
            "risk":        "None",
            "explanation": (
                "No significant symptoms were reported. Based on your answers, "
                "there are no indicators of the conditions this system screens for."
            ),
            "all_scores":  {},
            "recommendation": {
                "home_care": "You appear to be in good health based on your responses.",
                "test":      "No tests are indicated at this time.",
                "doctor":    "See a doctor if you develop symptoms or feel unwell.",
                "safety":    "",
            },
            "method":                pred["method"],
            "ai_used":               False,
            "confidence_trajectory": trajectory,
        }
        if idem_key:
            await cache_set(f"idem:{idem_key}", json.dumps(response_body), ttl=86400)
        return response_body

    active_syms = [k for k, v in answers.items() if v is True]

    ai_result: Optional[dict] = None
    try:
        ai_result = await asyncio.wait_for(
            call_openrouter(pred["disease"], pred["risk"], active_syms, pred["confidence"]),
            timeout=12.0,
        )
    except asyncio.TimeoutError:
        logger.warning({"event": "openrouter_timeout", "context": "analyze"})
    except Exception as e:
        logger.warning({"event": "openrouter_failed", "error": str(e)})

    rec = build_recommendation(pred["disease"], pred["risk"], ai_result)

    diag = DiagnosisModel(
        user_id               = user_id,
        session_id            = session_id,
        disease               = pred["disease"],
        risk                  = pred["risk"],
        confidence            = pred["confidence"],
        answers               = _dump_json(answers),
        active_symptoms       = _dump_json(active_syms),
        rec_home_care         = rec["home_care"],
        rec_test              = rec["test"],
        rec_doctor            = rec["doctor"],
        rec_safety            = rec.get("safety", ""),
        ai_explanation        = rec.get("explanation", ""),
        ml_scores             = _dump_json(pred.get("all_scores", {})),
        confidence_trajectory = _dump_json(trajectory),
    )
    db.add(diag)
    db.commit()
    db.refresh(diag)

    await cache_delete(f"profile:{user_id}")

    response_body = {
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
        "method":                pred["method"],
        "ai_used":               ai_result is not None,
        "confidence_trajectory": trajectory,
    }

    if idem_key:
        await cache_set(f"idem:{idem_key}", json.dumps(response_body), ttl=86400)

    return response_body


# -----------------------------------------------------------------
# ROUTES - Clinics
#
# See the "CLINIC FINDER (server-side proxy)" section above for why this
# proxies to the upstream data source rather than the frontend calling it
# directly.
# -----------------------------------------------------------------

@app.get("/api/v1/clinics/nearby")
@limiter.limit("20/minute")
async def clinics_nearby(
    request: Request,
    lat: float,
    lon: float,
    user_id: int = Depends(verify_token),
):
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        raise HTTPException(status_code=400, detail="Invalid coordinates")

    cache_key = f"clinics:{round(lat, 2)}:{round(lon, 2)}"
    cached = await cache_get(cache_key, key_type="clinics")
    if cached:
        try:
            return json.loads(cached)
        except Exception:
            pass

    elements = await _fetch_clinic_elements(lat, lon)
    places = _extract_clinic_places(elements, lat, lon)

    if not places:
        raise HTTPException(
            status_code=404,
            detail="No hospitals, clinics, or pharmacies were found within 6 km of this location.",
        )

    response_body = {"places": places}
    await cache_set(cache_key, json.dumps(response_body), ttl=CLINIC_CACHE_TTL_S)
    return response_body


# -----------------------------------------------------------------
# ROUTES - Patient History
# FIX: removed `request: Request` parameter — it was unused and caused
# FastAPI to bind it incorrectly on some versions. The rate-limiter
# decorator is also removed from GET history routes since they are
# already protected by JWT and do not need per-IP throttling.
# -----------------------------------------------------------------

@app.get("/api/v1/patient/history")
async def get_history(
    cursor: Optional[int] = None,
    limit: int = 20,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    limit = min(limit, 100)
    query = db.query(DiagnosisModel).filter(DiagnosisModel.user_id == user_id)
    if cursor is not None:
        query = query.filter(DiagnosisModel.id < cursor)

    rows = query.order_by(DiagnosisModel.id.desc()).limit(limit).all()

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
                "home_care": d.rec_home_care,
                "test":      d.rec_test,
                "doctor":    d.rec_doctor,
                "safety":    d.rec_safety,
            },
            "explanation":     d.ai_explanation,
            "active_symptoms": _load_json(d.active_symptoms, []),
        }
        for d in rows
    ]


@app.get("/api/v1/patient/history/{diag_id}")
async def get_diagnosis(
    diag_id: int,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    d = db.query(DiagnosisModel).filter(
        DiagnosisModel.id == diag_id,
        DiagnosisModel.user_id == user_id,
    ).first()
    if not d:
        raise HTTPException(status_code=404, detail="Not found")

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
            "home_care": d.rec_home_care,
            "test":      d.rec_test,
            "doctor":    d.rec_doctor,
            "safety":    d.rec_safety,
        },
        "explanation":            d.ai_explanation,
        "ml_scores":              _load_json(d.ml_scores, {}),
        "confidence_trajectory":  _load_json(d.confidence_trajectory, []),
    }


@app.delete("/api/v1/patient/history/{diag_id}")
async def delete_diagnosis(
    diag_id: int,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    d = db.query(DiagnosisModel).filter(
        DiagnosisModel.id == diag_id,
        DiagnosisModel.user_id == user_id,
    ).first()
    if not d:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(d)
    db.commit()
    await cache_delete(f"profile:{user_id}")
    return {"message": "Record deleted"}


# -----------------------------------------------------------------
# ROUTES - User Profile
# -----------------------------------------------------------------

@app.get("/api/v1/user/profile")
async def get_profile(
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    cache_key = f"profile:{user_id}"
    cached    = await cache_get(cache_key, key_type="profile")
    if cached:
        return json.loads(cached)

    u = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")

    count = db.query(DiagnosisModel).filter(DiagnosisModel.user_id == user_id).count()
    high  = db.query(DiagnosisModel).filter(
        DiagnosisModel.user_id == user_id,
        DiagnosisModel.risk == "High",
    ).count()

    result = {
        "id":               u.id,
        "email":            u.email,
        "name":             u.name,
        "age":              u.age,
        "gender":           u.gender,
        "joined_at":        u.created_at.isoformat(),
        "assessment_count": count,
        "high_risk_count":  high,
    }
    await cache_set(cache_key, json.dumps(result), ttl=300)
    return result


@app.put("/api/v1/user/profile")
async def update_profile(
    req: ProfileUpdate,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    u = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    if req.name   is not None: u.name   = _sanitize(req.name)
    if req.age    is not None: u.age    = req.age
    if req.gender is not None: u.gender = req.gender
    db.commit()
    await cache_delete(f"profile:{user_id}")
    return {"id": u.id, "name": u.name, "age": u.age, "gender": u.gender}


@app.put("/api/v1/user/change-password")
async def change_password(
    req: ChangePasswordRequest,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    u = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    if not u.pw_hash or not verify_pw(req.current_password, u.pw_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")
    u.pw_hash = hash_pw(req.new_password)
    db.commit()
    return {"message": "Password updated successfully"}


@app.delete("/api/v1/user/account")
async def delete_account(
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    db.query(DiagnosisModel).filter(DiagnosisModel.user_id == user_id).delete()
    db.query(SessionModel).filter(SessionModel.user_id == user_id).delete()
    db.query(UserModel).filter(UserModel.id == user_id).delete()
    db.commit()
    await cache_delete(f"profile:{user_id}")
    return {"message": "Account deleted"}


# -----------------------------------------------------------------
# ROUTES - Admin
# -----------------------------------------------------------------

@app.get("/api/v1/admin/stats")
async def admin_stats(
    admin_id: int = Depends(verify_admin),
    db: Session = Depends(get_db),
):
    cache_key = "admin:stats"
    cached    = await cache_get(cache_key, key_type="admin_stats")
    if cached:
        return json.loads(cached)
    result = {
        "total_users":     db.query(UserModel).count(),
        "total_diagnoses": db.query(DiagnosisModel).count(),
        "high_risk":       db.query(DiagnosisModel).filter(DiagnosisModel.risk == "High").count(),
        "medium_risk":     db.query(DiagnosisModel).filter(DiagnosisModel.risk == "Medium").count(),
        "low_risk":        db.query(DiagnosisModel).filter(DiagnosisModel.risk == "Low").count(),
    }
    await cache_set(cache_key, json.dumps(result), ttl=30)
    return result


@app.get("/api/v1/admin/all-records")
async def all_records(
    admin_id: int = Depends(verify_admin),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(DiagnosisModel)
        .order_by(DiagnosisModel.created_at.desc())
        .limit(500)
        .all()
    )
    user_ids = {d.user_id for d in rows}
    users    = {
        u.id: u.name
        for u in db.query(UserModel).filter(UserModel.id.in_(user_ids)).all()
    }
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
async def clear_database(
    admin_id: int = Depends(verify_admin),
    db: Session = Depends(get_db),
):
    deleted = db.query(DiagnosisModel).delete()
    db.query(SessionModel).delete()
    db.commit()
    await cache_delete("admin:stats")
    return {"message": f"Cleared {deleted} diagnosis records"}


@app.delete("/api/v1/admin/record/{diag_id}")
async def delete_record(
    diag_id: int,
    admin_id: int = Depends(verify_admin),
    db: Session = Depends(get_db),
):
    d = db.query(DiagnosisModel).filter(DiagnosisModel.id == diag_id).first()
    if not d:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(d)
    db.commit()
    await cache_delete("admin:stats")
    return {"message": "Record deleted"}


# -----------------------------------------------------------------
# ROUTES - Admin: Model Reload
# -----------------------------------------------------------------

@app.post("/api/v1/admin/models/reload")
async def reload_models(admin_id: int = Depends(verify_admin)):
    if not JOBLIB_AVAILABLE:
        raise HTTPException(status_code=501, detail="joblib not available")
    pkl_files = [f for f in os.listdir(MODELS_DIR) if f.endswith(".pkl")]
    if not pkl_files:
        return {"reloaded": [], "message": "No .pkl files found"}
    loop = asyncio.get_event_loop()
    for fname in pkl_files:
        await loop.run_in_executor(None, _load_single_model, fname)
    return {"reloaded": pkl_files, "models": list(LOADED_MODELS.keys())}


# -----------------------------------------------------------------
# ROUTES - Admin: Schema Migration (manual trigger)
#
# Useful if you want to re-run the column sync on demand (e.g. right after
# deploying a model change) without waiting for the next process restart.
# -----------------------------------------------------------------

@app.post("/api/v1/admin/schema/sync")
async def sync_schema(admin_id: int = Depends(verify_admin)):
    run_schema_migrations()
    inspector = inspect(engine)
    report = {}
    for model in (UserModel, SessionModel, DiagnosisModel):
        table = model.__table__
        try:
            cols = {c["name"] for c in inspector.get_columns(table.name)}
        except Exception:
            cols = set()
        expected = {c.name for c in table.columns}
        report[table.name] = {
            "expected": sorted(expected),
            "present":  sorted(cols),
            "missing":  sorted(expected - cols),
        }
    return {"message": "Schema sync complete", "tables": report}


# -----------------------------------------------------------------
# ENTRYPOINT
# -----------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=False,
    )
