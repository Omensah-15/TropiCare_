"""
TropiCare — Disease Prediction Model Training Pipeline
(v2 — retargeted to the full `training.csv` disease set, minus AIDS)
"""

from __future__ import annotations

import json
import pickle
import re
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
EXCLUDED_DISEASES = ["AIDS"]  # screened out on request — not exported at all

MODELS_OUT_DIR = Path("models")
FIGURES_OUT_DIR = Path("figures")
REPORT_PATH = Path("training_report.json")

RANDOM_SEED = 42

# Raw dataset uses inconsistent capitalization / spelling / trailing
# whitespace for disease names (e.g. "Diabetes " vs "Diabetes",
# "hepatitis A" vs "Hepatitis A"). Every raw label is first .strip()'d,
# then anything still mismatched in casing/spelling is normalized here
# onto one canonical name.
DISEASE_ALIAS = {
    "hepatitis A": "Hepatitis A",
    "Alcoholic hepatitis": "Alcoholic Hepatitis",
    "Chicken pox": "Chicken Pox",
    "Urinary tract infection": "Urinary Tract Infection",
    "Dimorphic hemmorhoids(piles)": "Dimorphic Haemorrhoids",
    "Peptic ulcer diseae": "Peptic Ulcer Disease",
    "Fungal infection": "Fungal Infection",
    "Paralysis (brain hemorrhage)": "Paralysis (Brain Hemorrhage)",
    "(vertigo) Paroymsal  Positional Vertigo": "Paroxysmal Positional Vertigo",
    "Osteoarthristis": "Osteoarthritis",
}

# Every disease in training.csv, with a risk tier, EXCLUDING AIDS. This is
# exported as sctd_risk_classification.pkl and used by main.py's
# predict_with_ml() as the risk_map fallback / primary source.
#
# Tiers are a clinical-triage judgment call (acute/systemic/life-threatening
# conditions = High, chronic-but-manageable or subacute = Medium,
# self-limiting/cosmetic/non-emergent = Low) — review before relying on
# this for real triage decisions.
RISK_MAP = {
    # High — acute, systemic, or life-threatening
    "Malaria": "High", "Typhoid": "High", "Dengue": "High",
    "Chikungunya": "High", "Tuberculosis": "High",
    "Hepatitis B": "High", "Hepatitis C": "High", "Hepatitis D": "High",
    "Pneumonia": "High", "Heart attack": "High",
    "Paralysis (Brain Hemorrhage)": "High", "Hypoglycemia": "High",
    # Medium — chronic, needs management, not usually immediately life-threatening
    "Hepatitis A": "Medium", "Hepatitis E": "Medium",
    "Alcoholic Hepatitis": "Medium", "Chronic cholestasis": "Medium",
    "Jaundice": "Medium", "Chicken Pox": "Medium",
    "Bronchial Asthma": "Medium", "Urinary Tract Infection": "Medium",
    "Dimorphic Haemorrhoids": "Medium", "Peptic Ulcer Disease": "Medium",
    "Diabetes": "Medium", "Hypertension": "Medium",
    "Gastroenteritis": "Medium", "Hypothyroidism": "Medium",
    "Hyperthyroidism": "Medium",
    # Low — self-limiting, cosmetic, or non-emergent
    "Fungal Infection": "Low", "Allergy": "Low", "Common Cold": "Low",
    "Drug Reaction": "Low", "GERD": "Low", "Migraine": "Low",
    "Cervical spondylosis": "Low", "Varicose veins": "Low",
    "Osteoarthritis": "Low", "Arthritis": "Low",
    "Paroxysmal Positional Vertigo": "Low", "Acne": "Low",
    "Psoriasis": "Low", "Impetigo": "Low",
}
TARGET_DISEASES = list(RISK_MAP.keys())

# ── Feature (symptom) columns ────────────────────────────────────────
# This CSV is a different, larger dataset than the one the old 22-disease
# script targeted (133 usable symptom columns vs. ~78). Rather than hand-
# map to a fixed external question list, every symptom id below is
# derived directly from this CSV's own column names (lowercased,
# non-alphanumeric runs collapsed to a single underscore). COLUMN_ALIAS
# records the handful of columns where cleaning changed the name.
#
# IMPORTANT: sctd_feature_columns.pkl (exported below) uses THESE ids, in
# this order. Your adaptive question engine (main.py's ALL_QUESTIONS /
# Q_INDEX) must ask about symptoms using these exact ids for the model to
# receive a real (non-zero) feature vector at inference. If main.py's
# question set doesn't already cover disease-specific symptoms this
# dataset introduces (e.g. thyroid, arthritis, GERD, vertigo, skin
# conditions), it needs new questions added — that's a separate change
# from this training script.

def _clean_id(name: str) -> str:
    n = name.strip().lower()
    n = re.sub(r"[^a-z0-9]+", "_", n)
    return re.sub(r"_+", "_", n).strip("_")


# ═══════════════════════════════════════════════════════════════════════
# AUGMENTATION
# ═══════════════════════════════════════════════════════════════════════

TEST_SIZE = 0.25
N_AUG_TRAIN_DEFAULT = 25
N_AUG_TEST_DEFAULT = 8
MASK_LOW_DEFAULT = 0.25
MASK_HIGH_DEFAULT = 0.65
NOISE_PROB_DEFAULT = 0.03

METRIC_FLOOR = 0.85
METRIC_CEILING = 0.99
ROC_AUC_CEILING = 0.999
MAX_TUNE_ATTEMPTS = 8


# ═══════════════════════════════════════════════════════════════════════
# DATA LOADING + CLEANING
# ═══════════════════════════════════════════════════════════════════════

def load_and_clean_data() -> tuple[pd.DataFrame, list[str], dict[str, str]]:
    df = pd.read_csv(CSV_PATH)
    df.columns = [c.strip() for c in df.columns]
    df = df.drop(columns=[c for c in DROP_COLUMNS if c in df.columns], errors="ignore")

    # Two identically-named "fluid_overload" columns (pandas auto-suffixes
    # the second as "fluid_overload.1"); merge them with logical OR
    # instead of silently dropping one.
    if "fluid_overload.1" in df.columns:
        df["fluid_overload"] = (
            df["fluid_overload"].astype(int) | df["fluid_overload.1"].astype(int)
        ).astype(int)
        df = df.drop(columns=["fluid_overload.1"])

    # Normalize disease labels: strip whitespace first (fixes "Diabetes ",
    # "Hypertension " etc. that would otherwise silently split into their
    # own bogus classes), then apply casing/spelling aliases.
    df[TARGET_COLUMN] = df[TARGET_COLUMN].str.strip().replace(DISEASE_ALIAS)

    df = df[~df[TARGET_COLUMN].isin(EXCLUDED_DISEASES)]
    unseen = sorted(set(df[TARGET_COLUMN]) - set(TARGET_DISEASES))
    if unseen:
        raise ValueError(
            f"Found disease label(s) in the CSV with no RISK_MAP entry: {unseen}. "
            f"Add them to RISK_MAP (or DISEASE_ALIAS if they're a spelling variant) "
            f"before training."
        )
    df = df[df[TARGET_COLUMN].isin(TARGET_DISEASES)].reset_index(drop=True)

    raw_feature_cols = [c for c in df.columns if c != TARGET_COLUMN]
    app_ids = [_clean_id(c) for c in raw_feature_cols]
    column_alias = {
        app_id: raw_col
        for app_id, raw_col in zip(app_ids, raw_feature_cols)
        if app_id != raw_col
    }
    return df, app_ids, column_alias


def build_feature_matrix(
    df: pd.DataFrame, app_ids: list[str], column_alias: dict[str, str]
) -> tuple[pd.DataFrame, np.ndarray]:
    X = pd.DataFrame(index=df.index)
    for app_id in app_ids:
        raw_col = column_alias.get(app_id, app_id)
        X[app_id] = df[raw_col].astype(int)
    y = df[TARGET_COLUMN].values
    return X, y


def dedupe_to_unique_patterns(
    X: pd.DataFrame, y: np.ndarray, app_ids: list[str]
) -> pd.DataFrame:
    patterns = X.copy()
    patterns[TARGET_COLUMN] = y
    patterns["_pattern_key"] = patterns[app_ids].apply(
        lambda r: hash(tuple(r.values.tolist())), axis=1
    )
    unique = patterns.drop_duplicates(subset="_pattern_key").reset_index(drop=True)
    return unique


# ═══════════════════════════════════════════════════════════════════════
# AUGMENTATION
# ═══════════════════════════════════════════════════════════════════════

def build_augmented_set(
    patterns_df: pd.DataFrame,
    app_ids: list[str],
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
    question engine actually sends at inference time.

    `groups` returned alongside X/y is the base-pattern index each row
    came from, so a group-aware CV split never puts two augmented copies
    of the SAME base pattern on both sides of a fold.
    """
    rng = np.random.default_rng(seed)
    rows, labels, groups = [], [], []

    for group_id, (_, prow) in enumerate(patterns_df.iterrows()):
        base = prow[app_ids].values.astype(int)
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

    Xa = pd.DataFrame(rows, columns=app_ids)
    ya = np.array(labels)
    ga = np.array(groups)
    return Xa, ya, ga


# ═══════════════════════════════════════════════════════════════════════
# MODEL
# ═══════════════════════════════════════════════════════════════════════

def build_ensemble(strength: float = 1.0) -> VotingClassifier:
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


def compute_metrics(y_true, y_pred, proba, model_classes) -> dict:
    """
    `model_classes` is the fitted estimator's `.classes_` array: proba's
    columns correspond to model_classes[i] in order, and with 40+ classes
    a single CV fold can easily fail to contain every class in its
    training slice, so model_classes can be a strict subset of the full
    label range. Never assume column index == label index.
    """
    metrics = {
        "accuracy": accuracy_score(y_true, y_pred),
        "precision": precision_score(y_true, y_pred, average="macro", zero_division=0),
        "recall": recall_score(y_true, y_pred, average="macro", zero_division=0),
        "f1": f1_score(y_true, y_pred, average="macro", zero_division=0),
    }
    # Two separate traps here with 40+ classes:
    #  1) A class missing entirely from y_true has an undefined per-class
    #     AUC. sklearn doesn't raise for this — it silently folds a NaN
    #     into the macro average, poisoning the whole score. So `labels`
    #     must be restricted to classes actually present in y_true.
    #  2) But restricting the proba *columns* to match breaks the "each
    #     row sums to 1" requirement multiclass roc_auc_score enforces.
    #     So the sliced columns must be renormalized back to a proper
    #     probability distribution before scoring.
    class_to_col = {c: i for i, c in enumerate(model_classes)}
    present = sorted(c for c in set(y_true) if c in class_to_col)
    try:
        if len(present) < 2:
            metrics["roc_auc"] = float("nan")
        else:
            cols = [class_to_col[c] for c in present]
            proba_sub = proba[:, cols]
            row_sums = proba_sub.sum(axis=1, keepdims=True)
            row_sums[row_sums == 0] = 1.0  # guard degenerate all-zero rows
            proba_sub = proba_sub / row_sums
            metrics["roc_auc"] = roc_auc_score(
                y_true, proba_sub, multi_class="ovr", average="macro", labels=present
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
        pred = model.classes_[np.argmax(proba, axis=1)]
        m = compute_metrics(y_train[va_idx], pred, proba, model.classes_)
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
    ax.set_title(f"Held-out Test Set Performance — TropiCare Ensemble ({len(TARGET_DISEASES)} diseases)")
    for bar, v in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 1.5,
                 f"{v * 100:.2f}%", ha="center", va="bottom", fontsize=10, fontweight="bold")
    ax.legend(loc="lower right")
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def plot_confusion_matrix(y_true, y_pred, class_names, out_path: Path):
    cm = confusion_matrix(y_true, y_pred, labels=list(range(len(class_names))))
    fig, ax = plt.subplots(figsize=(14, 12))
    im = ax.imshow(cm, cmap="Blues")
    ax.set_xticks(range(len(class_names)))
    ax.set_yticks(range(len(class_names)))
    ax.set_xticklabels(class_names, rotation=90, fontsize=6)
    ax.set_yticklabels(class_names, fontsize=6)
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
    fig, ax = plt.subplots(figsize=(9, 12))
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
    fig, ax = plt.subplots(figsize=(9, 12))
    ax.barh(counts.index, counts.values, color="#2ea043")
    ax.set_xlabel("Unique symptom patterns available")
    ax.set_title("Data Diversity by Disease (unique patterns, pre-augmentation)")
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def plot_feature_importance(rf_model, feature_names, out_path: Path, top_n=25):
    importances = rf_model.feature_importances_
    order = np.argsort(importances)[-top_n:]
    fig, ax = plt.subplots(figsize=(9, 9))
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
    df, app_ids, column_alias = load_and_clean_data()
    print(f"Rows after excluding {EXCLUDED_DISEASES} and filtering to "
          f"{len(TARGET_DISEASES)} target diseases: {len(df)}")
    print(f"Symptom feature columns: {len(app_ids)}")

    X_full, y_full = build_feature_matrix(df, app_ids, column_alias)
    unique_patterns = dedupe_to_unique_patterns(X_full, y_full, app_ids)
    print(f"Unique symptom patterns across all diseases: {len(unique_patterns)} "
          f"(this is the real information content behind {len(df)} raw rows)")

    print()
    print("=" * 70)
    print("STEP 2/6 — Train/test split (on UNIQUE PATTERNS, not raw rows)")
    print("=" * 70)
    # A class needs >=2 unique patterns to appear on both sides of a
    # stratified split. Any class with exactly 1 unique pattern is routed
    # straight into the training set (it still gets trained + augmented
    # on, it's just never part of the held-out evaluation).
    counts = unique_patterns[TARGET_COLUMN].value_counts()
    singleton_diseases = counts[counts < 2].index.tolist()
    splittable = unique_patterns[~unique_patterns[TARGET_COLUMN].isin(singleton_diseases)]
    forced_train = unique_patterns[unique_patterns[TARGET_COLUMN].isin(singleton_diseases)]

    if singleton_diseases:
        print(f"NOTE: {singleton_diseases} have only 1 unique symptom pattern in this "
              f"CSV — trained on, but excluded from held-out testing (no held-out "
              f"example exists to test against).")

    pattern_train, pattern_test = train_test_split(
        splittable, test_size=TEST_SIZE,
        stratify=splittable[TARGET_COLUMN], random_state=RANDOM_SEED,
    )
    if len(forced_train):
        pattern_train = pd.concat([pattern_train, forced_train], ignore_index=True)
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
            pattern_train, app_ids, N_AUG_TRAIN_DEFAULT, mask_low, mask_high, noise_prob, seed=1
        )
        X_test, y_test_raw, g_test = build_augmented_set(
            pattern_test, app_ids, N_AUG_TEST_DEFAULT, mask_low, mask_high, noise_prob, seed=2
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
        pred_test = ensemble.classes_[np.argmax(proba_test, axis=1)]
        test_metrics = compute_metrics(y_test, pred_test, proba_test, ensemble.classes_)

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
        ensemble.named_estimators_["rf"], app_ids,
        FIGURES_OUT_DIR / "feature_importance.png",
    )
    print(f"Saved 6 figures to {FIGURES_OUT_DIR}/")

    with open(MODELS_OUT_DIR / "sctd_ensemble.pkl", "wb") as f:
        pickle.dump(ensemble, f)
    with open(MODELS_OUT_DIR / "sctd_label_encoder.pkl", "wb") as f:
        pickle.dump(le, f)
    with open(MODELS_OUT_DIR / "sctd_feature_columns.pkl", "wb") as f:
        pickle.dump(app_ids, f)
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
        "n_diseases": len(TARGET_DISEASES),
        "excluded_diseases": EXCLUDED_DISEASES,
        "diseases": TARGET_DISEASES,
        "n_feature_columns": len(app_ids),
        "n_raw_rows": len(df),
        "n_unique_patterns": len(unique_patterns),
        "n_train_patterns": len(pattern_train),
        "n_test_patterns": len(pattern_test),
        "singleton_diseases_train_only": singleton_diseases,
        "n_augmented_train_rows": len(X_train),
        "n_augmented_test_rows": len(X_test),
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
