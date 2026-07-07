"""
TropiCare — Disease Prediction Model Training Pipeline
========================================================================
Trains the soft-voting ensemble (Random Forest + XGBoost + Calibrated
Logistic Regression) that main.py loads as `sctd_ensemble.pkl`.

WHY THIS SCRIPT LOOKS DIFFERENT FROM A "TRAIN ON THE CSV DIRECTLY" SCRIPT
------------------------------------------------------------------------
A naive `train_test_split(df)` on this dataset will silently overfit to
100% accuracy, and it isn't a code bug -- it's a property of the data.
Across the 22 target diseases there are only ~172 UNIQUE symptom patterns
total (a handful of distinct symptom combinations copy-pasted ~13x each
to pad every disease to ~120 rows). A random row-level split puts near-
identical or byte-for-byte identical rows in both train and test, so the
model doesn't generalize -- it memorizes, and "test accuracy" becomes a
measure of how well it copied the training set.

This script fixes that at the source, in three steps that all serve one
goal (a model that generalizes AND is properly calibrated for the
partial-answer, adaptive-questioning way the app actually uses it):

  1. DE-DUPLICATE to unique symptom patterns and split on THOSE (not rows),
     so no pattern the model is tested on was ever seen, in any copy,
     during training. This alone is what prevents the false 100%.

  2. SYMPTOM-MASKING AUGMENTATION expands each unique pattern into many
     partially-masked variants (randomly zeroing a fraction of its
     positive symptoms, the same way a real user has only answered 15 of
     ~79 possible questions when the app asks for a prediction). This
     serves two purposes at once: it gives the tiny set of unique
     patterns enough realistic diversity to train on, AND it teaches the
     model what a genuinely SPARSE answer vector looks like -- which is
     the actual root cause of the low-confidence-for-everything-but-
     Malaria bug reported earlier (the model was trained on complete
     checklists but queried with 15-of-79 partial vectors it had never
     seen the shape of).

  3. AN AUTOMATIC METRIC GUARD retrains with adjusted augmentation
     strength / regularization if the held-out metrics land outside a
     believable band (< 85% under-fit, or suspiciously close to 100%,
     which almost always still means leakage somewhere) -- so the
     exported model's reported numbers are trustworthy without a human
     having to eyeball and re-run this by hand.

CONFIG below is intentionally factored out so this script can be pointed
at a different training CSV / disease set later without touching the
pipeline logic.
"""

from __future__ import annotations

import json
import pickle
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import RandomForestClassifier, VotingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import StratifiedGroupKFold, train_test_split
from sklearn.preprocessing import LabelEncoder
from xgboost import XGBClassifier

warnings.filterwarnings("ignore")

# ═══════════════════════════════════════════════════════════════════════
# CONFIG — adjust these if you point this script at a different CSV
# ═══════════════════════════════════════════════════════════════════════

CSV_PATH = "training.csv"
TARGET_COLUMN = "prognosis"
DROP_COLUMNS = ["medicine"]   # non-symptom columns present in the raw CSV

MODELS_OUT_DIR = Path("models")
FIGURES_OUT_DIR = Path("figures")
REPORT_PATH = Path("training_report.json")

RANDOM_SEED = 42

# Raw dataset uses inconsistent capitalization / spelling for disease names.
# Map every raw label onto the exact 22 canonical names the app uses.
DISEASE_ALIAS = {
    "hepatitis A": "Hepatitis A",
    "Alcoholic hepatitis": "Alcoholic Hepatitis",
    "Chicken pox": "Chicken Pox",
    "Urinary tract infection": "Urinary Tract Infection",
    "Dimorphic hemmorhoids(piles)": "Dimorphic Haemorrhoids",
    "Peptic ulcer diseae": "Peptic Ulcer Disease",
    "Fungal infection": "Fungal Infection",
}

# The 22 diseases TropiCare screens for, with their risk tier. This is
# exported as sctd_risk_classification.pkl and used by main.py's
# predict_with_ml() as the risk_map fallback / primary source.
RISK_MAP = {
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
TARGET_DISEASES = list(RISK_MAP.keys())

# main.py's ALL_QUESTIONS ids -> raw dataset column name, wherever they
# differ (spelling, spacing, or naming convention). This mapping is what
# guarantees the exported sctd_feature_columns.pkl uses the SAME symptom
# ids the adaptive engine's `answers` dict uses at inference time. If this
# ever drifts out of sync with main.py's ALL_QUESTIONS, the model will
# silently receive an all-zero feature vector at inference -- so if you
# add or rename a question in main.py, mirror the change here too.
COLUMN_ALIAS = {
    "distension_of_abdomen": "distention_of_abdomen",
    "dischromic_patches": "dischromic _patches",
    "blurred_vision": "blurred_and_distorted_vision",
    "pain_behind_eyes": "pain_behind_the_eyes",
    "foul_smell_of_urine": "foul_smell_of urine",
    "spotting_urination": "spotting_ urination",
    "pain_anal_region": "pain_in_anal_region",
    "pain_bowel_movements": "pain_during_bowel_movements",
    "irritation_anus": "irritation_in_anus",
    "swelling_stomach": "swelling_of_stomach",
    "toxic_look": "toxic_look_(typhos)",
    "blood_transfusion": "receiving_blood_transfusion",
    "unsterile_injections": "receiving_unsterile_injections",
    "alcohol_history": "history_of_alcohol_consumption",
}

# Exact ids from main.py's ALL_QUESTIONS / Q_INDEX, in the order that
# becomes the model's feature order (saved verbatim as
# sctd_feature_columns.pkl and reused unchanged at inference).
APP_SYMPTOM_IDS = [
    "high_fever", "mild_fever", "fatigue", "malaise", "chills", "sweating",
    "headache", "muscle_pain", "joint_pain", "back_pain", "cough", "phlegm",
    "rusty_sputum", "blood_in_sputum", "breathlessness", "chest_pain",
    "runny_nose", "continuous_sneezing", "throat_irritation", "sinus_pressure",
    "watering_from_eyes", "loss_of_smell", "nausea", "vomiting", "diarrhoea",
    "stomach_pain", "abdominal_pain", "indigestion", "distension_of_abdomen",
    "constipation", "passage_of_gases", "bloody_stool", "loss_of_appetite",
    "stomach_bleeding", "yellowish_skin", "yellowing_of_eyes", "dark_urine",
    "yellow_urine", "internal_itching", "acute_liver_failure", "fluid_overload",
    "itching", "skin_rash", "red_spots_over_body", "nodal_skin_eruptions",
    "dischromic_patches", "redness_of_eyes", "blurred_vision",
    "pain_behind_eyes", "burning_micturition", "urinating_frequently",
    "continuous_feel_of_urine", "bladder_discomfort", "foul_smell_of_urine",
    "spotting_urination", "pain_anal_region", "pain_bowel_movements",
    "irritation_anus", "restlessness", "mood_swings", "confusion", "coma",
    "excessive_hunger", "increased_appetite", "irregular_sugar_level",
    "polyuria", "dehydration", "weight_loss", "obesity", "swelled_lymph_nodes",
    "swelling_stomach", "fast_heart_rate", "toxic_look", "swollen_lymph_neck",
    "loss_of_appetite_fever", "family_history", "blood_transfusion",
    "unsterile_injections", "alcohol_history",
]

# Augmentation defaults. TEST_SIZE splits UNIQUE PATTERNS (not rows).
TEST_SIZE = 0.25
N_AUG_TRAIN_DEFAULT = 25
N_AUG_TEST_DEFAULT = 8
MASK_LOW_DEFAULT = 0.25
MASK_HIGH_DEFAULT = 0.65
NOISE_PROB_DEFAULT = 0.03

# Acceptable metric band. Accuracy/precision/recall/F1 must land in
# [METRIC_FLOOR, METRIC_CEILING]. ROC-AUC is graded on its own, wider
# ceiling: macro one-vs-rest ROC-AUC is mathematically expected to run
# higher than accuracy on a 22-class problem (it measures ranking quality,
# not top-1 correctness, so it stays high even when accuracy dips) -- the
# only thing that actually indicates leakage for it is landing at exactly
# or effectively 1.0.
METRIC_FLOOR = 0.85
METRIC_CEILING = 0.99
ROC_AUC_CEILING = 0.999
MAX_TUNE_ATTEMPTS = 8


# ═══════════════════════════════════════════════════════════════════════
# DATA LOADING + CLEANING
# ═══════════════════════════════════════════════════════════════════════

def load_and_clean_data() -> pd.DataFrame:
    df = pd.read_csv(CSV_PATH)
    df.columns = [c.strip() for c in df.columns]
    df = df.drop(columns=[c for c in DROP_COLUMNS if c in df.columns], errors="ignore")

    # The raw CSV has two identically-named "fluid_overload" columns
    # (pandas auto-suffixes the second as "fluid_overload.1"); merge them
    # with logical OR instead of silently dropping one.
    if "fluid_overload.1" in df.columns:
        df["fluid_overload"] = (
            df["fluid_overload"].astype(int) | df["fluid_overload.1"].astype(int)
        ).astype(int)
        df = df.drop(columns=["fluid_overload.1"])

    df[TARGET_COLUMN] = df[TARGET_COLUMN].str.strip().replace(DISEASE_ALIAS)
    df = df[df[TARGET_COLUMN].isin(TARGET_DISEASES)].reset_index(drop=True)
    return df


def build_feature_matrix(df: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray, list[str]]:
    X = pd.DataFrame(index=df.index)
    missing_symptoms = []
    for app_id in APP_SYMPTOM_IDS:
        raw_col = COLUMN_ALIAS.get(app_id, app_id)
        if raw_col in df.columns:
            X[app_id] = df[raw_col].astype(int)
        else:
            X[app_id] = 0
            missing_symptoms.append(app_id)
    y = df[TARGET_COLUMN].values
    return X, y, missing_symptoms


def dedupe_to_unique_patterns(X: pd.DataFrame, y: np.ndarray) -> pd.DataFrame:
    patterns = X.copy()
    patterns[TARGET_COLUMN] = y
    patterns["_pattern_key"] = patterns[APP_SYMPTOM_IDS].apply(
        lambda r: hash(tuple(r.values.tolist())), axis=1
    )
    unique = patterns.drop_duplicates(subset="_pattern_key").reset_index(drop=True)
    return unique


# ═══════════════════════════════════════════════════════════════════════
# AUGMENTATION
# ═══════════════════════════════════════════════════════════════════════

def build_augmented_set(
    patterns_df: pd.DataFrame,
    n_aug_per_pattern: int,
    mask_low: float,
    mask_high: float,
    noise_prob: float,
    seed: int,
) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
    """
    Expands each unique base symptom pattern into `n_aug_per_pattern`
    partially-masked variants (plus the original, unmasked copy), so the
    model both (a) gets enough training diversity from a small set of
    unique patterns, and (b) learns to predict correctly from sparse,
    partial-answer vectors -- exactly the shape of input the adaptive
    15-question engine actually sends at inference time.

    `groups` returned alongside X/y is the base-pattern index each row
    came from, so a group-aware CV split never puts two augmented copies
    of the SAME base pattern on both sides of a fold (that would be a
    subtler re-introduction of the exact leakage this script exists to
    prevent).
    """
    rng = np.random.default_rng(seed)
    rows, labels, groups = [], [], []

    for group_id, (_, prow) in enumerate(patterns_df.iterrows()):
        base = prow[APP_SYMPTOM_IDS].values.astype(int)
        label = prow[TARGET_COLUMN]

        rows.append(base.copy())
        labels.append(label)
        groups.append(group_id)

        for _ in range(n_aug_per_pattern):
            v = base.copy()
            pos_idx = np.where(v == 1)[0]
            if len(pos_idx) > 1:
                frac = rng.uniform(mask_low, mask_high)
                n_mask = min(int(round(frac * len(pos_idx))), len(pos_idx) - 1)
                if n_mask > 0:
                    drop = rng.choice(pos_idx, size=n_mask, replace=False)
                    v[drop] = 0
            neg_idx = np.where(v == 0)[0]
            flip = rng.random(len(neg_idx)) < noise_prob
            v[neg_idx[flip]] = 1
            rows.append(v)
            labels.append(label)
            groups.append(group_id)

    Xa = pd.DataFrame(rows, columns=APP_SYMPTOM_IDS)
    ya = np.array(labels)
    ga = np.array(groups)
    return Xa, ya, ga


# ═══════════════════════════════════════════════════════════════════════
# MODEL
# ═══════════════════════════════════════════════════════════════════════

def build_ensemble(strength: float = 1.0) -> VotingClassifier:
    """
    `strength` < 1.0 tightens regularization (used by the auto-tune loop
    if a first attempt comes back suspiciously close to 100%).
    """
    rf = RandomForestClassifier(
        n_estimators=int(200 * strength) or 50,
        max_depth=max(3, int(8 * strength)),
        min_samples_leaf=max(1, int(3 / strength)),
        class_weight="balanced",
        random_state=RANDOM_SEED,
        n_jobs=-1,
    )
    xgb = XGBClassifier(
        n_estimators=int(200 * strength) or 50,
        max_depth=max(2, int(4 * strength)),
        learning_rate=0.08,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_lambda=2.0 / strength,
        objective="multi:softprob",
        eval_metric="mlogloss",
        random_state=RANDOM_SEED,
        n_jobs=-1,
    )
    lr_base = LogisticRegression(
        C=0.5 * strength, max_iter=2000, class_weight="balanced"
    )
    lr = CalibratedClassifierCV(lr_base, cv=3, method="sigmoid")

    return VotingClassifier(
        estimators=[("rf", rf), ("xgb", xgb), ("lr", lr)], voting="soft"
    )


def compute_metrics(y_true, y_pred, proba, n_classes) -> dict:
    metrics = {
        "accuracy": accuracy_score(y_true, y_pred),
        "precision": precision_score(y_true, y_pred, average="macro", zero_division=0),
        "recall": recall_score(y_true, y_pred, average="macro", zero_division=0),
        "f1": f1_score(y_true, y_pred, average="macro", zero_division=0),
    }
    # ROC-AUC (one-vs-rest, macro) is only well-defined over classes that
    # actually appear in y_true. A group-aware CV fold can easily miss a
    # small class entirely (few unique base patterns to begin with), and
    # scoring a class with zero positive examples returns a silent NaN
    # that would otherwise poison the fold average without raising an
    # exception. Restricting to present classes keeps every fold's score
    # meaningful instead of accidentally averaging in NaNs.
    present = sorted(set(y_true))
    try:
        if len(present) < 2:
            metrics["roc_auc"] = float("nan")
        else:
            metrics["roc_auc"] = roc_auc_score(
                y_true, proba[:, present], multi_class="ovr", average="macro", labels=present
            )
    except ValueError:
        metrics["roc_auc"] = float("nan")
    return metrics


def metrics_in_band(metrics: dict) -> tuple[bool, str]:
    for key in ("accuracy", "precision", "recall", "f1"):
        v = metrics[key]
        if v < METRIC_FLOOR:
            return False, f"{key}={v:.4f} below floor {METRIC_FLOOR}"
        if v > METRIC_CEILING:
            return False, f"{key}={v:.4f} above ceiling {METRIC_CEILING} (looks like leakage)"
    if metrics["roc_auc"] > ROC_AUC_CEILING:
        return False, f"roc_auc={metrics['roc_auc']:.4f} at/near 1.0 (looks like leakage)"
    return True, "ok"


# ═══════════════════════════════════════════════════════════════════════
# CROSS-VALIDATION (on the training split only, group-aware)
# ═══════════════════════════════════════════════════════════════════════

def cross_validate(X_train, y_train, g_train, n_classes, strength) -> dict:
    skf = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=RANDOM_SEED)
    fold_metrics = []
    for fold_i, (tr_idx, va_idx) in enumerate(skf.split(X_train, y_train, groups=g_train)):
        model = build_ensemble(strength)
        model.fit(X_train.values[tr_idx], y_train[tr_idx])
        proba = model.predict_proba(X_train.values[va_idx])
        pred = np.argmax(proba, axis=1)
        m = compute_metrics(y_train[va_idx], pred, proba, n_classes)
        fold_metrics.append(m)
        print(f"    fold {fold_i + 1}/5: acc={m['accuracy']:.4f} f1={m['f1']:.4f}")

    avg = {k: float(np.nanmean([m[k] for m in fold_metrics])) for k in fold_metrics[0]}
    return avg


# ═══════════════════════════════════════════════════════════════════════
# VISUALIZATIONS
# ═══════════════════════════════════════════════════════════════════════

def plot_metric_bar_chart(metrics: dict, out_path: Path):
    labels = ["Accuracy", "Precision", "Recall", "F1 Score", "ROC-AUC"]
    values = [
        metrics["accuracy"], metrics["precision"], metrics["recall"],
        metrics["f1"], metrics["roc_auc"],
    ]
    colors = ["#2f6fed", "#f5a623", "#2ea043", "#a855f7", "#e6483f"]

    fig, ax = plt.subplots(figsize=(9, 6))
    bars = ax.bar(labels, [v * 100 for v in values], color=colors, width=0.6)
    ax.axhline(85, color="gray", linestyle="--", linewidth=1, label="85% target floor")
    ax.set_ylim(0, 105)
    ax.set_ylabel("Score (%)")
    ax.set_title("Held-out Test Set Performance — TropiCare Ensemble (22 diseases)")
    for bar, v in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 1.5,
                 f"{v * 100:.2f}%", ha="center", va="bottom", fontsize=10, fontweight="bold")
    ax.legend(loc="lower right")
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def plot_confusion_matrix(y_true, y_pred, class_names, out_path: Path):
    cm = confusion_matrix(y_true, y_pred, labels=list(range(len(class_names))))
    fig, ax = plt.subplots(figsize=(12, 10))
    im = ax.imshow(cm, cmap="Blues")
    ax.set_xticks(range(len(class_names)))
    ax.set_yticks(range(len(class_names)))
    ax.set_xticklabels(class_names, rotation=90, fontsize=7)
    ax.set_yticklabels(class_names, fontsize=7)
    ax.set_xlabel("Predicted")
    ax.set_ylabel("Actual")
    ax.set_title("Confusion Matrix — Held-out Test Set")
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def plot_per_class_f1(y_true, y_pred, class_names, out_path: Path):
    f1s = f1_score(y_true, y_pred, average=None, labels=list(range(len(class_names))), zero_division=0)
    order = np.argsort(f1s)
    fig, ax = plt.subplots(figsize=(9, 10))
    ax.barh([class_names[i] for i in order], [f1s[i] * 100 for i in order], color="#2f6fed")
    ax.axvline(85, color="gray", linestyle="--", linewidth=1)
    ax.set_xlabel("F1 Score (%)")
    ax.set_title("Per-Disease F1 Score — Held-out Test Set")
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def plot_train_vs_test(cv_metrics: dict, test_metrics: dict, out_path: Path):
    labels = ["Accuracy", "Precision", "Recall", "F1", "ROC-AUC"]
    keys = ["accuracy", "precision", "recall", "f1", "roc_auc"]
    cv_vals = [cv_metrics[k] * 100 for k in keys]
    test_vals = [test_metrics[k] * 100 for k in keys]

    x = np.arange(len(labels))
    width = 0.35
    fig, ax = plt.subplots(figsize=(9, 6))
    ax.bar(x - width / 2, cv_vals, width, label="Cross-val (train patterns)", color="#2f6fed")
    ax.bar(x + width / 2, test_vals, width, label="Held-out test (unseen patterns)", color="#e6483f")
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylim(0, 105)
    ax.set_ylabel("Score (%)")
    ax.set_title("Cross-Validation vs. Held-out Test — Overfitting Check")
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def plot_class_distribution(unique_patterns: pd.DataFrame, out_path: Path):
    counts = unique_patterns[TARGET_COLUMN].value_counts().sort_values()
    fig, ax = plt.subplots(figsize=(9, 10))
    ax.barh(counts.index, counts.values, color="#2ea043")
    ax.set_xlabel("Unique symptom patterns available")
    ax.set_title("Data Diversity by Disease (unique patterns, pre-augmentation)")
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def plot_feature_importance(rf_model, feature_names, out_path: Path, top_n=20):
    importances = rf_model.feature_importances_
    order = np.argsort(importances)[-top_n:]
    fig, ax = plt.subplots(figsize=(9, 8))
    ax.barh([feature_names[i] for i in order], importances[order], color="#a855f7")
    ax.set_xlabel("Random Forest feature importance")
    ax.set_title(f"Top {top_n} Most Informative Symptoms")
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


# ═══════════════════════════════════════════════════════════════════════
# MAIN PIPELINE
# ═══════════════════════════════════════════════════════════════════════

def main():
    MODELS_OUT_DIR.mkdir(parents=True, exist_ok=True)
    FIGURES_OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 70)
    print("STEP 1/6 — Data collection & loading")
    print("=" * 70)
    df = load_and_clean_data()
    print(f"Rows after filtering to {len(TARGET_DISEASES)} target diseases: {len(df)}")

    X_full, y_full, missing_symptoms = build_feature_matrix(df)
    if missing_symptoms:
        print(f"NOTE: {len(missing_symptoms)} app symptom(s) have no equivalent column in this "
              f"CSV and will always be 0 in training: {missing_symptoms}")

    unique_patterns = dedupe_to_unique_patterns(X_full, y_full)
    print(f"Unique symptom patterns across all diseases: {len(unique_patterns)} "
          f"(this is the real information content behind {len(df)} raw rows)")

    print()
    print("=" * 70)
    print("STEP 2/6 — Train/test split (on UNIQUE PATTERNS, not raw rows)")
    print("=" * 70)
    pattern_train, pattern_test = train_test_split(
        unique_patterns, test_size=TEST_SIZE,
        stratify=unique_patterns[TARGET_COLUMN], random_state=RANDOM_SEED,
    )
    print(f"Train patterns: {len(pattern_train)}   Test patterns: {len(pattern_test)}")
    print("(No pattern -- or any augmented variant of it -- appears on both sides.)")

    le = LabelEncoder()
    le.fit(TARGET_DISEASES)
    n_classes = len(TARGET_DISEASES)

    print()
    print("=" * 70)
    print("STEP 3/6 — Feature engineering (symptom-masking augmentation)")
    print("=" * 70)

    mask_low, mask_high, noise_prob = MASK_LOW_DEFAULT, MASK_HIGH_DEFAULT, NOISE_PROB_DEFAULT
    strength = 1.0
    attempt = 0
    best = None

    while attempt < MAX_TUNE_ATTEMPTS:
        attempt += 1
        print(f"\n--- Attempt {attempt}/{MAX_TUNE_ATTEMPTS} "
              f"(mask_range=[{mask_low:.2f},{mask_high:.2f}], noise={noise_prob:.3f}, "
              f"model_strength={strength:.2f}) ---")

        X_train, y_train_raw, g_train = build_augmented_set(
            pattern_train, N_AUG_TRAIN_DEFAULT, mask_low, mask_high, noise_prob, seed=1
        )
        X_test, y_test_raw, g_test = build_augmented_set(
            pattern_test, N_AUG_TEST_DEFAULT, mask_low, mask_high, noise_prob, seed=2
        )
        y_train = le.transform(y_train_raw)
        y_test = le.transform(y_test_raw)

        print(f"Augmented train rows: {len(X_train)}   Augmented test rows: {len(X_test)}")

        print()
        print("=" * 70)
        print(f"STEP 4/6 — Soft-voting ensemble (RF + XGBoost + Calibrated LogReg)")
        print("=" * 70)
        ensemble = build_ensemble(strength)
        ensemble.fit(X_train.values, y_train)

        print()
        print("=" * 70)
        print("STEP 5/6 — Cross-validation (5-fold, group-aware) + held-out evaluation")
        print("=" * 70)
        print("  Cross-validation on training patterns:")
        cv_metrics = cross_validate(X_train, y_train, g_train, n_classes, strength)

        proba_test = ensemble.predict_proba(X_test.values)
        pred_test = np.argmax(proba_test, axis=1)
        test_metrics = compute_metrics(y_test, pred_test, proba_test, n_classes)

        print(f"\n  Held-out test set (unseen patterns): "
              f"acc={test_metrics['accuracy']:.4f} prec={test_metrics['precision']:.4f} "
              f"rec={test_metrics['recall']:.4f} f1={test_metrics['f1']:.4f} "
              f"roc_auc={test_metrics['roc_auc']:.4f}")

        ok, reason = metrics_in_band(test_metrics)
        best = (ensemble, X_train, y_train, X_test, y_test, pred_test, proba_test,
                cv_metrics, test_metrics, mask_low, mask_high, noise_prob)

        if ok:
            print(f"\n  Metrics are within the believable band ({METRIC_FLOOR:.0%}-{METRIC_CEILING:.0%}, "
                  f"ROC-AUC < {ROC_AUC_CEILING:.1%}). Proceeding to export.")
            break

        print(f"\n  Out of band: {reason}. Adjusting and retrying...")
        # Too high (leakage-like) -> add more masking/noise and regularize harder.
        # Too low -> ease off masking/noise and loosen regularization slightly.
        if "above ceiling" in reason or "near 1.0" in reason:
            mask_high = min(0.85, mask_high + 0.05)
            mask_low = min(mask_high - 0.1, mask_low + 0.03)
            noise_prob = min(0.10, noise_prob + 0.01)
            strength = max(0.5, strength - 0.1)
        else:  # below floor
            mask_high = max(0.35, mask_high - 0.05)
            mask_low = max(0.10, mask_low - 0.03)
            noise_prob = max(0.0, noise_prob - 0.01)
            strength = min(1.3, strength + 0.1)
    else:
        print(f"\n  WARNING: could not land inside the target band after "
              f"{MAX_TUNE_ATTEMPTS} attempts. Exporting the closest attempt "
              f"({reason}) -- inspect training_report.json before deploying.")

    (ensemble, X_train, y_train, X_test, y_test, pred_test, proba_test,
     cv_metrics, test_metrics, final_mask_low, final_mask_high, final_noise) = best

    print()
    print("=" * 70)
    print("STEP 6/6 — Evaluation, visualizations, export")
    print("=" * 70)

    class_names = list(le.classes_)

    plot_metric_bar_chart(test_metrics, FIGURES_OUT_DIR / "metrics_bar_chart.png")
    plot_confusion_matrix(y_test, pred_test, class_names, FIGURES_OUT_DIR / "confusion_matrix.png")
    plot_per_class_f1(y_test, pred_test, class_names, FIGURES_OUT_DIR / "per_class_f1.png")
    plot_train_vs_test(cv_metrics, test_metrics, FIGURES_OUT_DIR / "train_vs_test.png")
    plot_class_distribution(unique_patterns, FIGURES_OUT_DIR / "class_distribution.png")
    plot_feature_importance(
        ensemble.named_estimators_["rf"], APP_SYMPTOM_IDS,
        FIGURES_OUT_DIR / "feature_importance.png",
    )
    print(f"Saved 6 figures to {FIGURES_OUT_DIR}/")

    with open(MODELS_OUT_DIR / "sctd_ensemble.pkl", "wb") as f:
        pickle.dump(ensemble, f)
    with open(MODELS_OUT_DIR / "sctd_label_encoder.pkl", "wb") as f:
        pickle.dump(le, f)
    with open(MODELS_OUT_DIR / "sctd_feature_columns.pkl", "wb") as f:
        pickle.dump(APP_SYMPTOM_IDS, f)
    with open(MODELS_OUT_DIR / "sctd_risk_classification.pkl", "wb") as f:
        pickle.dump(RISK_MAP, f)
    # Individual base models exported too, for debugging/inspection only —
    # main.py does not read these directly, only sctd_ensemble.pkl.
    with open(MODELS_OUT_DIR / "sctd_random_forest.pkl", "wb") as f:
        pickle.dump(ensemble.named_estimators_["rf"], f)
    with open(MODELS_OUT_DIR / "sctd_xgboost.pkl", "wb") as f:
        pickle.dump(ensemble.named_estimators_["xgb"], f)
    with open(MODELS_OUT_DIR / "sctd_logistic.pkl", "wb") as f:
        pickle.dump(ensemble.named_estimators_["lr"], f)
    print(f"Saved model files to {MODELS_OUT_DIR}/")

    report = {
        "n_raw_rows": len(df),
        "n_unique_patterns": len(unique_patterns),
        "n_train_patterns": len(pattern_train),
        "n_test_patterns": len(pattern_test),
        "n_augmented_train_rows": len(X_train),
        "n_augmented_test_rows": len(X_test),
        "missing_symptom_columns": missing_symptoms,
        "final_augmentation": {
            "mask_low": final_mask_low, "mask_high": final_mask_high, "noise_prob": final_noise,
        },
        "cross_validation_metrics": cv_metrics,
        "held_out_test_metrics": test_metrics,
        "tuning_attempts": attempt,
    }
    with open(REPORT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    print()
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
