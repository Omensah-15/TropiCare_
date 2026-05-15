"""
========================================================================
SCTD - Symptom Checker for Tropical Diseases
Production ML Pipeline

Architecture
------------
Stage 1 - Adaptive Question Engine (Decision Tree)
  The fitted Decision Tree traverses its internal node structure to
  determine the next most informative symptom to ask the patient.
  Each yes/no response narrows the diagnostic space. The tree is
  trained with entropy-based splitting to maximise information gain.

Stage 2 - Probabilistic Prediction Engine (Ensemble)
  A soft-voting ensemble of calibrated classifiers computes
  P(Disease | Symptoms) across all target diseases. Components:
    - Random Forest       : robust, high-variance reduction
    - XGBoost             : gradient-boosted discriminative power
    - Logistic Regression : calibrated linear probability model
  The Decision Tree is kept separate as the question engine only.

Stage 3 - Risk Classification Engine
  A hybrid rule-and-data-driven layer computes risk level from:
    - Clinical severity tier (WHO/CDC literature-backed)
    - Ensemble confidence score
    - Symptom severity weight score
    - Prediction uncertainty (Shannon entropy over class probs)

Dataset
-------
  Source  : training.csv (Kaggle - Disease Symptom Prediction)
  Rows    : ~2,643 after filtering to 22 target diseases
  Per class: ~120 real samples
  Features: 132 binary symptom columns + prognosis

  No duplication or SMOTE is applied. The dataset has ~120 real
  samples per class, which is sufficient for tree-based and logistic
  models. The train/test split is performed on real data only, so the
  held-out test set contains no synthetic samples. This eliminates
  the data leakage that occurs when SMOTE is applied before splitting.

Target diseases (22 of 23 planned; Cholera absent from source data)
--------------------------------------------------------------------
  High   : Malaria, Typhoid, Dengue, Tuberculosis, Hepatitis B,
            Hepatitis C, Hepatitis D, Pneumonia
  Medium : Hepatitis A, Hepatitis E, Alcoholic Hepatitis, Jaundice,
            Chicken Pox, Bronchial Asthma, Urinary Tract Infection,
            Dimorphic Haemorrhoids, Peptic Ulcer Disease, Diabetes
  Low    : Fungal Infection, Allergy, Common Cold, Drug Reaction

Pipeline Steps
--------------
1.  Load training.csv, strip column names, clean prognosis
2.  Filter to 22 target diseases only
3.  Remove zero-variance features
4.  Feature engineering (symptom_count, severity_score, cluster flags)
5.  Label encoding
6.  Stratified 80/20 train/test split on REAL data (no leakage)
7.  Build models
8.  10-fold stratified cross-validation
9.  Final training on training split
10. Probability calibration (sigmoid, cv=5)
11. Held-out test set evaluation
12. SHAP explainability (Random Forest base model)
13. Eight evaluation plots saved to sctd_outputs/
14. All models, encoders, and artifacts saved to sctd_outputs/
========================================================================
"""

import os
import warnings
import json
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns
import joblib
import shap

from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier, VotingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import LabelEncoder, StandardScaler
from sklearn.model_selection import (
    StratifiedKFold, cross_validate, train_test_split
)
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import (
    accuracy_score,
    precision_score,
    recall_score,
    f1_score,
    confusion_matrix,
    classification_report,
    roc_auc_score,
    roc_curve,
    precision_recall_curve,
    average_precision_score,
    brier_score_loss,
    log_loss,
)
from sklearn.feature_selection import VarianceThreshold
from sklearn.pipeline import Pipeline
from collections import Counter

try:
    from xgboost import XGBClassifier
    XGBOOST_AVAILABLE = True
except ImportError:
    XGBClassifier = None
    XGBOOST_AVAILABLE = False
    print("  WARNING: XGBoost not available. Ensemble will use 2 models.")

warnings.filterwarnings("ignore")


# ============================================================
# CONFIGURATION
# ============================================================

RANDOM_STATE = 42
TEST_SIZE    = 0.20
CV_FOLDS     = 10
THRESHOLD    = 0.85

DATASET_CSV = "training.csv"
OUTPUT_DIR  = "sctd_outputs"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# 22 target diseases. Cholera is absent from the source dataset.
# The slide lists 23 diseases; Cholera will be noted as a limitation.
TARGET_DISEASES = [
    # High risk
    "Malaria",
    "Typhoid",
    "Dengue",
    "Tuberculosis",
    "Hepatitis B",
    "Hepatitis C",
    "Hepatitis D",
    "Pneumonia",
    # Medium risk
    "hepatitis A",
    "Hepatitis E",
    "Alcoholic hepatitis",
    "Jaundice",
    "Chicken pox",
    "Bronchial Asthma",
    "Urinary tract infection",
    "Dimorphic hemmorhoids(piles)",
    "Peptic ulcer diseae",
    "Diabetes",
    # Low risk
    "Fungal infection",
    "Allergy",
    "Common Cold",
    "Drug Reaction",
]

# Literature-backed risk tiers (WHO, CDC, Merck Manual)
RISK_CLASSIFICATION = {
    "Malaria":                        "High",
    "Typhoid":                        "High",
    "Dengue":                         "High",
    "Tuberculosis":                   "High",
    "Hepatitis B":                    "High",
    "Hepatitis C":                    "High",
    "Hepatitis D":                    "High",
    "Pneumonia":                      "High",
    "hepatitis A":                    "Medium",
    "Hepatitis E":                    "Medium",
    "Alcoholic hepatitis":            "Medium",
    "Jaundice":                       "Medium",
    "Chicken pox":                    "Medium",
    "Bronchial Asthma":               "Medium",
    "Urinary tract infection":        "Medium",
    "Dimorphic hemmorhoids(piles)":   "Medium",
    "Peptic ulcer diseae":            "Medium",
    "Diabetes":                       "Medium",
    "Fungal infection":               "Low",
    "Allergy":                        "Low",
    "Common Cold":                    "Low",
    "Drug Reaction":                  "Low",
}

# Clinical severity weights per symptom (0.0 - 1.0)
SYMPTOM_SEVERITY_WEIGHTS = {
    "coma":                           1.00,
    "acute_liver_failure":            1.00,
    "stomach_bleeding":               0.95,
    "blood_in_sputum":                0.90,
    "breathlessness":                 0.85,
    "chest_pain":                     0.85,
    "fast_heart_rate":                0.80,
    "yellowing_of_eyes":              0.75,
    "yellowish_skin":                 0.75,
    "dark_urine":                     0.70,
    "high_fever":                     0.70,
    "receiving_blood_transfusion":    0.70,
    "receiving_unsterile_injections": 0.65,
    "toxic_look_(typhos)":            0.65,
    "bloody_stool":                   0.65,
    "weakness_of_one_body_side":      0.65,
    "altered_sensorium":              0.60,
    "loss_of_appetite":               0.50,
    "vomiting":                       0.45,
    "fatigue":                        0.40,
    "nausea":                         0.35,
    "headache":                       0.30,
}

PALETTE = {
    "Decision Tree":  "#5B8C2A",
    "Random Forest":  "#2A5B8C",
    "XGBoost":        "#C47A1E",
    "Log Regression": "#8C2A5B",
    "Ensemble":       "#1E6B6B",
}


# ============================================================
# SECTION 1 - DATA LOADING AND CLEANING
# ============================================================

def load_and_clean(path: str) -> pd.DataFrame:
    """
    Load training.csv, strip column names, clean prognosis values,
    drop the 'medicine' column if present, fill nulls, and filter
    to TARGET_DISEASES only.

    Removing zero-variance features is deferred until after filtering
    so that features with no variance within the target disease subset
    (which may still vary across non-target diseases) are also removed.

    Returns a DataFrame with cleaned binary feature columns + prognosis.
    """
    df = pd.read_csv(path)

    # Strip whitespace from all column names
    df.columns = df.columns.str.strip().str.replace(r"\s+", "_", regex=True)

    # Drop the medicine column (not a feature)
    if "medicine" in df.columns:
        df = df.drop(columns=["medicine"])

    # Strip prognosis values
    df["prognosis"] = df["prognosis"].str.strip()

    # Remove duplicate columns
    df = df.loc[:, ~df.columns.duplicated()]

    # Filter to target diseases only
    df = df[df["prognosis"].isin(TARGET_DISEASES)].copy()
    df = df.reset_index(drop=True)

    # Fill nulls and enforce integer binary values
    feat_cols = [c for c in df.columns if c != "prognosis"]
    df[feat_cols] = df[feat_cols].fillna(0).astype(int)

    # Remove zero-variance features within the filtered subset
    selector = VarianceThreshold(threshold=0.0)
    selector.fit(df[feat_cols].values)
    active_mask  = selector.get_support()
    active_feats = [f for f, m in zip(feat_cols, active_mask) if m]

    removed = len(feat_cols) - len(active_feats)
    print(f"  Original features       : {len(feat_cols)}")
    print(f"  Zero-variance removed   : {removed}")
    print(f"  Active features         : {len(active_feats)}")

    return df[active_feats + ["prognosis"]]


# ============================================================
# SECTION 2 - FEATURE ENGINEERING
# ============================================================

def engineer_features(df: pd.DataFrame) -> tuple:
    """
    Add four composite features on top of the binary symptom vectors.
    All transforms are row-wise with no cross-row statistics, so there
    is no leakage regardless of when this is applied.

    symptom_count      : Total number of active symptoms per row.
    severity_score     : Weighted sum using SYMPTOM_SEVERITY_WEIGHTS.
    hepatitis_cluster  : Flag for co-activation of jaundice symptoms.
    respiratory_cluster: Flag for co-activation of respiratory symptoms.

    These are computed before the train/test split. Because all four
    are deterministic functions of the raw features (no statistics
    derived from the training set), this does not introduce leakage.

    Returns (df_with_features, feature_column_list).
    """
    feat_cols = [c for c in df.columns if c != "prognosis"]
    df = df.copy()

    df["symptom_count"] = df[feat_cols].sum(axis=1)

    sev = np.zeros(len(df))
    for symptom, weight in SYMPTOM_SEVERITY_WEIGHTS.items():
        if symptom in df.columns:
            sev += df[symptom].values * weight
    df["severity_score"] = sev

    hep_syms   = ["yellowish_skin", "dark_urine", "yellowing_of_eyes"]
    active_hep = [s for s in hep_syms if s in df.columns]
    df["hepatitis_cluster"] = (
        (df[active_hep].sum(axis=1) >= 2).astype(int) if active_hep else 0
    )

    resp_syms   = ["cough", "breathlessness", "phlegm", "chest_pain"]
    active_resp = [s for s in resp_syms if s in df.columns]
    df["respiratory_cluster"] = (
        (df[active_resp].sum(axis=1) >= 2).astype(int) if active_resp else 0
    )

    engineered_cols = feat_cols + [
        "symptom_count", "severity_score",
        "hepatitis_cluster", "respiratory_cluster",
    ]
    return df, engineered_cols


# ============================================================
# SECTION 3 - MODEL DEFINITIONS
# ============================================================

def build_question_tree() -> DecisionTreeClassifier:
    """
    Decision Tree used exclusively for the adaptive question-flow
    engine in the Streamlit app. Entropy criterion maximises
    information gain per split.
    Not included in the prediction ensemble.
    """
    return DecisionTreeClassifier(
        criterion="entropy",
        max_depth=20,
        min_samples_split=4,
        min_samples_leaf=2,
        class_weight="balanced",
        random_state=RANDOM_STATE,
    )


def build_random_forest() -> RandomForestClassifier:
    """
    Random Forest ensemble component. 300 trees, balanced_subsample
    weighting, sqrt feature sampling, and OOB scoring.
    """
    return RandomForestClassifier(
        n_estimators=300,
        criterion="entropy",
        max_depth=None,
        min_samples_split=4,
        min_samples_leaf=2,
        max_features="sqrt",
        class_weight="balanced_subsample",
        oob_score=True,
        n_jobs=-1,
        random_state=RANDOM_STATE,
    )


def build_xgboost():
    """
    XGBoost ensemble component. multi:softprob objective gives
    calibrated multi-class probabilities. Returns None if not installed.
    """
    if not XGBOOST_AVAILABLE or XGBClassifier is None:
        return None
    return XGBClassifier(
        n_estimators=300,
        max_depth=6,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        objective="multi:softprob",
        eval_metric="mlogloss",
        n_jobs=-1,
        random_state=RANDOM_STATE,
        verbosity=0,
    )


def build_logistic_regression() -> Pipeline:
    """
    Logistic Regression wrapped in a StandardScaler Pipeline.
    lbfgs handles multinomial problems natively. C=1.0 with
    balanced class weights.

    Note: the multi_class parameter was removed in scikit-learn 1.5.
    lbfgs defaults to multinomial when there are more than two classes,
    so the behaviour is identical to the prior explicit setting.
    """
    return Pipeline([
        ("scaler", StandardScaler()),
        ("lr", LogisticRegression(
            solver="lbfgs",
            max_iter=1000,
            C=1.0,
            class_weight="balanced",
            random_state=RANDOM_STATE,
        )),
    ])


def build_all_models() -> dict:
    """
    Assemble all model components and the soft-voting ensemble.
    The Decision Tree is kept separate (question engine only).
    The ensemble uses Random Forest, XGBoost, and Logistic Regression.
    """
    models = {
        "Decision Tree":  build_question_tree(),
        "Random Forest":  build_random_forest(),
        "Log Regression": build_logistic_regression(),
    }

    xgb = build_xgboost()
    if xgb is not None:
        models["XGBoost"] = xgb

    voting_estimators = [
        (name, mdl)
        for name, mdl in models.items()
        if name != "Decision Tree"
    ]
    models["Ensemble"] = VotingClassifier(
        estimators=voting_estimators,
        voting="soft",
        n_jobs=-1,
    )
    return models


# ============================================================
# SECTION 4 - CALIBRATION
# ============================================================

def calibrate_model(model, x_train: np.ndarray, y_train: np.ndarray):
    """
    Wrap a fitted model in 5-fold sigmoid (Platt) calibration.

    Calibration is applied after the model has been trained on the
    training split. It uses the same training split via internal
    cross-validation (cv=5), not the held-out test set.

    This ensures that a 90% confidence output corresponds to
    approximately 90% empirical accuracy, which is required for the
    hybrid risk scoring layer to produce reliable risk levels.
    """
    calibrated = CalibratedClassifierCV(
        estimator=model,
        method="sigmoid",
        cv=5,
    )
    calibrated.fit(x_train, y_train)
    return calibrated


def compute_calibration_metrics(
    model,
    x_test: np.ndarray,
    y_test: np.ndarray,
    n_classes: int,
) -> dict:
    """Mean Brier score and log loss over all classes. Lower is better."""
    y_prob = model.predict_proba(x_test)
    brier  = []
    for cls_idx in range(n_classes):
        y_bin = (y_test == cls_idx).astype(int)
        brier.append(brier_score_loss(y_bin, y_prob[:, cls_idx]))
    return {
        "brier_score": float(np.mean(brier)),
        "log_loss":    float(log_loss(y_test, y_prob)),
    }


# ============================================================
# SECTION 5 - CROSS-VALIDATION
# ============================================================

def run_cross_validation(
    models: dict,
    x_train: np.ndarray,
    y_train: np.ndarray,
) -> dict:
    """
    10-fold stratified cross-validation on the training split.

    Cross-validation is run only on the training split (x_train,
    y_train). The held-out test set (x_test, y_test) is never seen
    during this step. The Ensemble is excluded to avoid nested
    VotingClassifier fit errors in cross_validate.

    Returns per-model CV and train metrics with overfit gap.
    """
    skf = StratifiedKFold(
        n_splits=CV_FOLDS, shuffle=True, random_state=RANDOM_STATE
    )
    scoring = ["accuracy", "precision_macro", "recall_macro", "f1_macro"]
    results = {}

    for name, model in models.items():
        if name == "Ensemble":
            continue
        scores = cross_validate(
            model, x_train, y_train,
            cv=skf,
            scoring=scoring,
            return_train_score=True,
            n_jobs=-1,
        )
        results[name] = {
            "CV Accuracy":     float(scores["test_accuracy"].mean()),
            "CV Precision":    float(scores["test_precision_macro"].mean()),
            "CV Recall":       float(scores["test_recall_macro"].mean()),
            "CV F1 Score":     float(scores["test_f1_macro"].mean()),
            "CV Accuracy Std": float(scores["test_accuracy"].std()),
            "CV F1 Std":       float(scores["test_f1_macro"].std()),
            "Train Accuracy":  float(scores["train_accuracy"].mean()),
            "Train F1":        float(scores["train_f1_macro"].mean()),
            "Overfit Gap":     float(
                scores["train_f1_macro"].mean() - scores["test_f1_macro"].mean()
            ),
        }
    return results


# ============================================================
# SECTION 6 - TRAINING AND EVALUATION
# ============================================================

def train_and_evaluate(
    models: dict,
    x_train: np.ndarray,
    y_train: np.ndarray,
    x_test: np.ndarray,
    y_test: np.ndarray,
    le: LabelEncoder,
) -> dict:
    """
    Fit all models on x_train/y_train only. Apply calibration to
    tree-based and XGBoost models using the training split (cv=5
    internal folds). Evaluate on x_test/y_test (genuinely held out).

    The test set is never used during fitting or calibration.
    """
    results   = {}
    n_classes = len(le.classes_)

    for name, model in models.items():
        print(f"    Training: {name} ...")
        model.fit(x_train, y_train)

        # Apply calibration to models that benefit from it.
        # Logistic Regression and the Ensemble already produce
        # calibrated probabilities via their internal mechanisms.
        if name in ("Decision Tree", "Random Forest", "XGBoost"):
            model = calibrate_model(model, x_train, y_train)

        y_pred = model.predict(x_test)
        y_prob = model.predict_proba(x_test)

        acc       = accuracy_score(y_test, y_pred)
        precision = precision_score(
            y_test, y_pred, average="macro", zero_division=0
        )
        recall    = recall_score(
            y_test, y_pred, average="macro", zero_division=0
        )
        f1        = f1_score(
            y_test, y_pred, average="macro", zero_division=0
        )

        try:
            auc = roc_auc_score(
                y_test, y_prob, multi_class="ovr", average="macro"
            )
        except ValueError:
            auc = float("nan")

        cal = compute_calibration_metrics(model, x_test, y_test, n_classes)

        results[name] = {
            "model":       model,
            "y_pred":      y_pred,
            "y_prob":      y_prob,
            "Accuracy":    acc,
            "Precision":   precision,
            "Recall":      recall,
            "F1 Score":    f1,
            "AUC":         auc,
            "Brier Score": cal["brier_score"],
            "Log Loss":    cal["log_loss"],
            "report":      classification_report(
                y_test, y_pred,
                target_names=le.classes_,
                zero_division=0,
            ),
            "cm": confusion_matrix(y_test, y_pred),
        }

        print(
            f"      Acc={acc:.4f}  Prec={precision:.4f}  "
            f"Rec={recall:.4f}  F1={f1:.4f}  AUC={auc:.4f}"
        )

    return results


# ============================================================
# SECTION 7 - SHAP EXPLAINABILITY
# ============================================================

def compute_shap_values(
    rf_calibrated_model,
    x_train: np.ndarray,
    x_test: np.ndarray,
    feature_names: list,
    output_dir: str,
) -> tuple:
    """
    Compute SHAP TreeExplainer values for the Random Forest base model.

    SHAP (SHapley Additive exPlanations) assigns each symptom a
    contribution score grounded in cooperative game theory, providing:
      - Global feature importance: which symptoms matter most overall
      - Per-prediction explanations for use in the Streamlit app

    The base RandomForestClassifier is extracted from the calibrated
    wrapper before passing to TreeExplainer, because SHAP's
    TreeExplainer only supports native tree models.

    Outputs: SHAP bar plot, feature importance CSV, raw .npy file.
    """
    print("  Computing SHAP values (Tree Explainer)...")

    # Extract the base RandomForestClassifier from the calibration wrapper
    base_model = rf_calibrated_model
    if hasattr(rf_calibrated_model, "calibrated_classifiers_"):
        base_model = rf_calibrated_model.calibrated_classifiers_[0].estimator
    elif hasattr(rf_calibrated_model, "estimator"):
        base_model = rf_calibrated_model.estimator

    bg_size    = min(100, len(x_train))
    background = x_train[:bg_size]

    try:
        explainer   = shap.TreeExplainer(base_model, data=background)
        shap_values = explainer.shap_values(x_test)

        if isinstance(shap_values, list):
            shap_abs = np.mean([np.abs(sv) for sv in shap_values], axis=0)
        else:
            shap_arr = np.array(shap_values)
            if shap_arr.ndim == 3:
                shap_abs = np.abs(shap_arr).mean(axis=2)
            else:
                shap_abs = np.abs(shap_arr)

        global_importance = shap_abs.mean(axis=0)
        np.save(os.path.join(output_dir, "shap_values.npy"), shap_abs)

        top_n     = min(20, len(feature_names))
        top_idx   = np.argsort(global_importance)[::-1][:top_n]
        top_names = [feature_names[i] for i in top_idx]
        top_vals  = [float(global_importance[i]) for i in top_idx]

        fig, ax = plt.subplots(figsize=(10, 7))
        fig.patch.set_facecolor("white")
        ax.set_facecolor("#F7F9F4")
        sorted_top = sorted(top_vals, reverse=True)
        cutoff     = sorted_top[4] if len(sorted_top) > 4 else sorted_top[-1]
        colors     = ["#5B8C2A" if v >= cutoff else "#2A5B8C" for v in top_vals]
        ax.barh(
            range(len(top_names)), top_vals[::-1],
            color=colors[::-1], alpha=0.88, edgecolor="white",
        )
        ax.set_yticks(range(len(top_names)))
        ax.set_yticklabels(
            [n.replace("_", " ") for n in top_names[::-1]], fontsize=9
        )
        ax.set_xlabel(
            "Mean |SHAP value| (average impact on model output)", fontsize=10
        )
        ax.set_title(
            "SHAP Global Feature Importance\n"
            "Random Forest  |  SCTD  |  Top Symptoms",
            fontsize=12, fontweight="bold",
        )
        ax.xaxis.grid(True, linestyle="--", alpha=0.5, color="#CCCCCC")
        ax.set_axisbelow(True)
        for spine in ax.spines.values():
            spine.set_visible(False)
        plt.tight_layout()
        path = os.path.join(output_dir, "08_shap_feature_importance.png")
        plt.savefig(path, dpi=180, bbox_inches="tight")
        plt.close()
        print(f"  Saved: {path}")

        pd.DataFrame({
            "symptom":         feature_names,
            "shap_importance": list(global_importance),
        }).sort_values("shap_importance", ascending=False).to_csv(
            os.path.join(output_dir, "shap_feature_importance.csv"), index=False
        )
        print(f"  Saved: {os.path.join(output_dir, 'shap_feature_importance.csv')}")

        return shap_abs, explainer

    except Exception as exc:
        print(f"  SHAP computation failed: {exc}")
        print("  Skipping SHAP plot.")
        return None, None


def explain_single_prediction(
    rf_calibrated_model,
    feature_vector: np.ndarray,
    feature_names: list,
    top_n: int = 8,
) -> list:
    """
    Return the top_n symptoms driving a single patient prediction.
    Used by the Streamlit app for per-prediction explanations.
    Falls back to severity-weighted active symptoms if SHAP fails.
    """
    try:
        base_model = rf_calibrated_model
        if hasattr(rf_calibrated_model, "calibrated_classifiers_"):
            base_model = rf_calibrated_model.calibrated_classifiers_[0].estimator
        elif hasattr(rf_calibrated_model, "estimator"):
            base_model = rf_calibrated_model.estimator

        explainer   = shap.TreeExplainer(base_model)
        shap_values = explainer.shap_values(feature_vector.reshape(1, -1))
        if isinstance(shap_values, list):
            combined = np.mean([np.abs(sv[0]) for sv in shap_values], axis=0)
        else:
            arr = np.array(shap_values)
            combined = (
                np.abs(arr[0]).mean(axis=-1) if arr.ndim == 3 else np.abs(arr[0])
            )
        top_idx = np.argsort(combined)[::-1][:top_n]
        return [(feature_names[i], float(combined[i])) for i in top_idx]

    except Exception:
        active = [
            (feature_names[i], SYMPTOM_SEVERITY_WEIGHTS.get(feature_names[i], 0.1))
            for i in range(len(feature_names))
            if feature_vector[i] >= 0.5
        ]
        return sorted(active, key=lambda x: x[1], reverse=True)[:top_n]


# ============================================================
# SECTION 8 - RISK SCORING
# ============================================================

def compute_symptom_severity_score(
    feature_vector: np.ndarray,
    feature_names: list,
) -> float:
    """Weighted sum of active symptoms, normalised to [0, 1]."""
    total = sum(SYMPTOM_SEVERITY_WEIGHTS.values())
    score = sum(
        SYMPTOM_SEVERITY_WEIGHTS.get(feature_names[i], 0.05)
        for i in range(len(feature_names))
        if feature_vector[i] >= 0.5
    )
    return min(score / total, 1.0)


def compute_prediction_entropy(probabilities: np.ndarray) -> float:
    """
    Shannon entropy of the predicted probability distribution,
    normalised to [0, 1] by log(n_classes).
    High value = uncertain prediction.
    """
    probs   = np.clip(probabilities, 1e-10, 1.0)
    entropy = -np.sum(probs * np.log(probs))
    return float(entropy / np.log(len(probs)))


def compute_risk_level(
    disease: str,
    confidence: float,
    feature_vector: np.ndarray,
    feature_names: list,
    probabilities: np.ndarray,
) -> tuple:
    """
    Hybrid risk scoring:
      composite = 0.50 * base_severity
                + 0.30 * symptom_score
                + 0.20 * confidence * (1 - 0.5 * entropy)

    Thresholds: >= 0.65 -> High, >= 0.40 -> Medium, else Low.
    Returns (risk_level, composite_score, entropy).
    """
    base_map  = {"High": 1.0, "Medium": 0.6, "Low": 0.3}
    base_tier = RISK_CLASSIFICATION.get(disease, "Medium")
    base_sev  = base_map[base_tier]

    sym_score = compute_symptom_severity_score(feature_vector, feature_names)
    entropy   = compute_prediction_entropy(probabilities)
    conf_adj  = confidence * (1.0 - entropy * 0.5)

    composite = 0.50 * base_sev + 0.30 * sym_score + 0.20 * conf_adj

    if composite >= 0.65:
        level = "High"
    elif composite >= 0.40:
        level = "Medium"
    else:
        level = "Low"

    return level, round(composite, 4), round(entropy, 4)


def predict_with_risk(
    ensemble_model,
    le: LabelEncoder,
    feature_names: list,
    feature_vector: np.ndarray,
) -> dict:
    """
    Full single-patient prediction pipeline. Called by the Streamlit app.

    Returns dict with: disease, confidence, risk_level, composite_score,
    entropy, all_probabilities (sorted descending by probability).
    """
    v2d      = feature_vector.reshape(1, -1)
    pred_enc = ensemble_model.predict(v2d)[0]
    proba    = ensemble_model.predict_proba(v2d)[0]
    disease  = le.inverse_transform([pred_enc])[0]
    confidence = float(proba[pred_enc])

    risk_level, composite, entropy = compute_risk_level(
        disease, confidence, feature_vector, feature_names, proba,
    )

    all_probs = dict(sorted(
        {
            le.inverse_transform([i])[0]: round(float(p), 4)
            for i, p in enumerate(proba)
        }.items(),
        key=lambda x: x[1], reverse=True,
    ))

    return {
        "disease":           disease,
        "confidence":        round(confidence, 4),
        "risk_level":        risk_level,
        "composite_score":   composite,
        "entropy":           entropy,
        "all_probabilities": all_probs,
    }


def get_next_question(
    dt_model,
    feature_vector: np.ndarray,
    feature_names: list,
    asked: list,
):
    """
    Navigate the fitted Decision Tree to find the next unanswered
    diagnostic question. Returns None at leaf nodes.
    Used by the Streamlit app for the adaptive question flow.
    """
    base = dt_model
    if hasattr(dt_model, "calibrated_classifiers_"):
        base = dt_model.calibrated_classifiers_[0].estimator
    elif hasattr(dt_model, "estimator"):
        base = dt_model.estimator

    if not hasattr(base, "tree_"):
        return None

    tree = base.tree_
    node = 0
    while tree.feature[node] >= 0:
        feat_idx  = int(tree.feature[node])
        if feat_idx >= len(feature_names):
            break
        feat_name = feature_names[feat_idx]
        if feat_name not in asked:
            return feat_name
        node = (
            tree.children_left[node]
            if feature_vector[feat_idx] <= tree.threshold[node]
            else tree.children_right[node]
        )
    return None


# ============================================================
# SECTION 9 - VISUALIZATION
# ============================================================

def _style_axis(ax) -> None:
    ax.set_facecolor("#F7F9F4")
    ax.xaxis.grid(True, linestyle="--", alpha=0.4, color="#CCCCCC")
    ax.yaxis.grid(True, linestyle="--", alpha=0.4, color="#CCCCCC")
    ax.set_axisbelow(True)
    for spine in ax.spines.values():
        spine.set_visible(False)


def plot_metrics_comparison(eval_results: dict, save_path: str) -> None:
    """Grouped bar chart of Accuracy, Precision, Recall, F1 per model."""
    model_names = [k for k in eval_results if not k.startswith("_")]
    metrics     = ["Accuracy", "Precision", "Recall", "F1 Score"]
    x           = np.arange(len(metrics))
    width       = 0.15
    n           = len(model_names)

    fig, ax = plt.subplots(figsize=(13, 6))
    fig.patch.set_facecolor("white")
    _style_axis(ax)

    for i, name in enumerate(model_names):
        vals   = [eval_results[name][m] for m in metrics]
        offset = (i - n / 2 + 0.5) * width
        bars   = ax.bar(
            x + offset, vals, width,
            label=name,
            color=PALETTE.get(name, "#888888"),
            alpha=0.85,
            edgecolor="white",
        )
        for bar, val in zip(bars, vals):
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                bar.get_height() + 0.008,
                f"{val:.3f}",
                ha="center", va="bottom",
                fontsize=6.5, fontweight="bold",
            )

    ax.axhline(
        THRESHOLD, color="#CC3333", linestyle="--", linewidth=1.3,
        label=f"{int(THRESHOLD * 100)}% threshold",
    )
    ax.set_xticks(x + width * (n - 1) / 2)
    ax.set_xticklabels(metrics, fontsize=11)
    ax.set_ylim(0, 1.14)
    ax.set_ylabel("Score", fontsize=11)
    ax.set_title(
        "SCTD Model Performance Comparison\nHeld-Out Test Set",
        fontsize=13, fontweight="bold", pad=14,
    )
    ax.legend(fontsize=9, framealpha=0.9, ncol=2)
    plt.tight_layout()
    plt.savefig(save_path, dpi=180, bbox_inches="tight")
    plt.close()
    print(f"  Saved: {save_path}")


def plot_confusion_matrix(
    eval_results: dict,
    le: LabelEncoder,
    model_name: str,
    save_path: str,
) -> None:
    """Normalised confusion matrix for the specified model."""
    short   = [d[:18] for d in le.classes_]
    cm      = eval_results[model_name]["cm"].astype(float)
    rs      = cm.sum(axis=1, keepdims=True)
    cm_norm = np.where(rs == 0, 0.0, cm / rs)

    fig, ax = plt.subplots(figsize=(14, 11))
    fig.patch.set_facecolor("white")
    cmap = sns.light_palette(PALETTE.get(model_name, "#2A5B8C"), as_cmap=True)
    sns.heatmap(
        cm_norm, ax=ax,
        xticklabels=short, yticklabels=short,
        cmap=cmap, vmin=0, vmax=1,
        annot=True, fmt=".2f", annot_kws={"size": 7},
        linewidths=0.4, linecolor="#EEEEEE",
        cbar_kws={"shrink": 0.7},
    )
    ax.set_title(
        f"Normalised Confusion Matrix  |  {model_name}\nSCTD",
        fontsize=12, fontweight="bold", pad=10,
    )
    ax.set_xlabel("Predicted Label", fontsize=9)
    ax.set_ylabel("True Label", fontsize=9)
    ax.tick_params(axis="x", rotation=45, labelsize=7)
    ax.tick_params(axis="y", rotation=0,  labelsize=7)
    plt.tight_layout()
    plt.savefig(save_path, dpi=180, bbox_inches="tight")
    plt.close()
    print(f"  Saved: {save_path}")


def plot_cv_comparison(cv_results: dict, save_path: str) -> None:
    """Train vs CV F1 bar chart and overfit gap chart side by side."""
    model_names = list(cv_results.keys())
    cv_f1s = [cv_results[n]["CV F1 Score"] for n in model_names]
    tr_f1s = [cv_results[n]["Train F1"]    for n in model_names]
    gaps   = [cv_results[n]["Overfit Gap"] for n in model_names]
    stds   = [cv_results[n]["CV F1 Std"]   for n in model_names]
    x = np.arange(len(model_names))
    w = 0.35

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))
    fig.patch.set_facecolor("white")

    _style_axis(ax1)
    b1 = ax1.bar(
        x - w / 2, tr_f1s, w, label="Train F1",
        color="#5B8C2A", alpha=0.85, edgecolor="white",
    )
    b2 = ax1.bar(
        x + w / 2, cv_f1s, w, label="CV F1",
        color="#2A5B8C", alpha=0.85, edgecolor="white",
        yerr=stds, capsize=5,
        error_kw={"elinewidth": 1.2, "ecolor": "#555"},
    )
    for bar, val in list(zip(b1, tr_f1s)) + list(zip(b2, cv_f1s)):
        ax1.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 0.012,
            f"{val:.3f}", ha="center", va="bottom",
            fontsize=8, fontweight="bold",
        )
    ax1.axhline(THRESHOLD, color="#CC3333", linestyle="--", linewidth=1.2,
                label=f"{int(THRESHOLD * 100)}% threshold")
    ax1.set_xticks(x)
    ax1.set_xticklabels(model_names, fontsize=9, rotation=15)
    ax1.set_ylim(0, 1.15)
    ax1.set_ylabel("F1 Score", fontsize=10)
    ax1.set_title("Train vs CV F1 Score\n(Overfit Detection)",
                  fontsize=11, fontweight="bold")
    ax1.legend(fontsize=9)

    _style_axis(ax2)
    bar_colors = ["#CC3333" if g > 0.10 else "#5B8C2A" for g in gaps]
    ax2.bar(x, gaps, color=bar_colors, alpha=0.85, edgecolor="white")
    ax2.axhline(0.10, color="#CC3333", linestyle="--", linewidth=1.2,
                label="10% overfit threshold")
    ax2.axhline(0, color="#555", linewidth=0.8)
    for xi, g in zip(x, gaps):
        ax2.text(xi, g + 0.003, f"{g:.3f}",
                 ha="center", va="bottom", fontsize=9, fontweight="bold")
    ax2.set_xticks(x)
    ax2.set_xticklabels(model_names, fontsize=9, rotation=15)
    ax2.set_ylabel("Train F1 - CV F1", fontsize=10)
    ax2.set_title("Generalisation Gap per Model\n(Lower is Better)",
                  fontsize=11, fontweight="bold")
    ax2.legend(fontsize=9)
    ax2.xaxis.grid(False)

    plt.suptitle("Overfitting Analysis  |  SCTD", fontsize=13, fontweight="bold")
    plt.tight_layout()
    plt.savefig(save_path, dpi=180, bbox_inches="tight")
    plt.close()
    print(f"  Saved: {save_path}")


def plot_roc_curves(
    eval_results: dict,
    le: LabelEncoder,
    model_name: str,
    y_test: np.ndarray,
    save_path: str,
) -> None:
    """One-vs-Rest ROC curves for all disease classes."""
    y_prob = eval_results[model_name]["y_prob"]
    n_cls  = len(le.classes_)

    y_bin = np.zeros((len(y_test), n_cls))
    for i, c in enumerate(y_test):
        y_bin[i, c] = 1

    fig, ax = plt.subplots(figsize=(12, 8))
    fig.patch.set_facecolor("white")
    ax.set_facecolor("#F7F9F4")
    colors = plt.cm.tab20(np.linspace(0, 1, n_cls))

    for i, (cls_name, color) in enumerate(zip(le.classes_, colors)):
        if y_bin[:, i].sum() == 0:
            continue
        try:
            fpr, tpr, _ = roc_curve(y_bin[:, i], y_prob[:, i])
            auc_val     = roc_auc_score(y_bin[:, i], y_prob[:, i])
            ax.plot(fpr, tpr, color=color, linewidth=1.2,
                    label=f"{cls_name[:22]} ({auc_val:.2f})")
        except ValueError:
            pass

    ax.plot([0, 1], [0, 1], "k--", linewidth=1.0, label="Random")
    ax.set_xlim([0, 1])
    ax.set_ylim([0, 1.02])
    ax.set_xlabel("False Positive Rate", fontsize=11)
    ax.set_ylabel("True Positive Rate", fontsize=11)
    ax.set_title(
        f"ROC Curves (One-vs-Rest)  |  {model_name}\nSCTD",
        fontsize=12, fontweight="bold",
    )
    ax.legend(fontsize=6.5, loc="lower right", ncol=2, framealpha=0.9)
    ax.xaxis.grid(True, linestyle="--", alpha=0.4)
    ax.yaxis.grid(True, linestyle="--", alpha=0.4)
    for spine in ax.spines.values():
        spine.set_visible(False)
    plt.tight_layout()
    plt.savefig(save_path, dpi=180, bbox_inches="tight")
    plt.close()
    print(f"  Saved: {save_path}")


def plot_precision_recall_curves(
    eval_results: dict,
    le: LabelEncoder,
    model_name: str,
    y_test: np.ndarray,
    save_path: str,
) -> None:
    """Precision-Recall curves per disease class."""
    y_prob = eval_results[model_name]["y_prob"]
    n_cls  = len(le.classes_)

    y_bin = np.zeros((len(y_test), n_cls))
    for i, c in enumerate(y_test):
        y_bin[i, c] = 1

    fig, ax = plt.subplots(figsize=(12, 8))
    fig.patch.set_facecolor("white")
    ax.set_facecolor("#F7F9F4")
    colors = plt.cm.tab20(np.linspace(0, 1, n_cls))

    for i, (cls_name, color) in enumerate(zip(le.classes_, colors)):
        if y_bin[:, i].sum() == 0:
            continue
        try:
            prec, rec, _ = precision_recall_curve(y_bin[:, i], y_prob[:, i])
            ap = average_precision_score(y_bin[:, i], y_prob[:, i])
            ax.plot(rec, prec, color=color, linewidth=1.2,
                    label=f"{cls_name[:22]} (AP={ap:.2f})")
        except ValueError:
            pass

    ax.set_xlim([0, 1])
    ax.set_ylim([0, 1.02])
    ax.set_xlabel("Recall", fontsize=11)
    ax.set_ylabel("Precision", fontsize=11)
    ax.set_title(
        f"Precision-Recall Curves  |  {model_name}\nSCTD",
        fontsize=12, fontweight="bold",
    )
    ax.legend(fontsize=6.5, loc="lower left", ncol=2, framealpha=0.9)
    ax.xaxis.grid(True, linestyle="--", alpha=0.4)
    ax.yaxis.grid(True, linestyle="--", alpha=0.4)
    for spine in ax.spines.values():
        spine.set_visible(False)
    plt.tight_layout()
    plt.savefig(save_path, dpi=180, bbox_inches="tight")
    plt.close()
    print(f"  Saved: {save_path}")


def plot_per_class_metrics(
    eval_results: dict,
    le: LabelEncoder,
    model_name: str,
    y_test: np.ndarray,
    save_path: str,
) -> None:
    """Per-class Precision, Recall, and F1 for the best model."""
    y_pred  = eval_results[model_name]["y_pred"]
    classes = le.classes_

    rep        = classification_report(
        y_test, y_pred, target_names=classes,
        output_dict=True, zero_division=0,
    )
    precisions = [rep[c]["precision"] if isinstance(rep.get(c), dict) else 0.0 for c in classes]
    recalls    = [rep[c]["recall"]    if isinstance(rep.get(c), dict) else 0.0 for c in classes]
    f1s        = [rep[c]["f1-score"]  if isinstance(rep.get(c), dict) else 0.0 for c in classes]

    x = np.arange(len(classes))
    w = 0.25

    fig, ax = plt.subplots(figsize=(20, 6))
    fig.patch.set_facecolor("white")
    _style_axis(ax)

    ax.bar(x - w, precisions, w, label="Precision", color="#5B8C2A", alpha=0.85, edgecolor="white")
    ax.bar(x,     recalls,    w, label="Recall",    color="#2A5B8C", alpha=0.85, edgecolor="white")
    ax.bar(x + w, f1s,        w, label="F1 Score",  color="#C47A1E", alpha=0.85, edgecolor="white")
    ax.axhline(THRESHOLD, color="#CC3333", linestyle="--", linewidth=1.2,
               label=f"{int(THRESHOLD * 100)}% threshold")
    ax.set_xticks(x)
    ax.set_xticklabels([c[:24] for c in classes], rotation=45, ha="right", fontsize=7.5)
    ax.set_ylim(0, 1.15)
    ax.set_ylabel("Score", fontsize=11)
    ax.set_title(
        f"Per-Class Metrics  |  {model_name}  |  SCTD",
        fontsize=13, fontweight="bold",
    )
    ax.legend(fontsize=10, framealpha=0.9)
    plt.tight_layout()
    plt.savefig(save_path, dpi=180, bbox_inches="tight")
    plt.close()
    print(f"  Saved: {save_path}")


def plot_calibration_metrics(eval_results: dict, save_path: str) -> None:
    """Brier score and log loss comparison across all models."""
    model_names  = [k for k in eval_results if not k.startswith("_")]
    brier_scores = [eval_results[n]["Brier Score"] for n in model_names]
    log_losses   = [eval_results[n]["Log Loss"]    for n in model_names]
    x = np.arange(len(model_names))
    w = 0.35

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 5))
    fig.patch.set_facecolor("white")

    _style_axis(ax1)
    bars1 = ax1.bar(x, brier_scores, w, color="#2A5B8C", alpha=0.85, edgecolor="white")
    for bar, val in zip(bars1, brier_scores):
        ax1.text(
            bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.0005,
            f"{val:.4f}", ha="center", va="bottom", fontsize=9, fontweight="bold",
        )
    ax1.set_xticks(x)
    ax1.set_xticklabels(model_names, fontsize=9, rotation=15)
    ax1.set_ylabel("Brier Score (lower = better)", fontsize=10)
    ax1.set_title("Probability Calibration\nBrier Score", fontsize=11, fontweight="bold")

    _style_axis(ax2)
    bars2 = ax2.bar(x, log_losses, w, color="#5B8C2A", alpha=0.85, edgecolor="white")
    for bar, val in zip(bars2, log_losses):
        ax2.text(
            bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.005,
            f"{val:.4f}", ha="center", va="bottom", fontsize=9, fontweight="bold",
        )
    ax2.set_xticks(x)
    ax2.set_xticklabels(model_names, fontsize=9, rotation=15)
    ax2.set_ylabel("Log Loss (lower = better)", fontsize=10)
    ax2.set_title("Probability Calibration\nLog Loss", fontsize=11, fontweight="bold")

    plt.suptitle("Calibration Quality  |  SCTD Models", fontsize=13, fontweight="bold")
    plt.tight_layout()
    plt.savefig(save_path, dpi=180, bbox_inches="tight")
    plt.close()
    print(f"  Saved: {save_path}")


# ============================================================
# SECTION 10 - REPORTING
# ============================================================

def print_section(title: str) -> None:
    line = "=" * 72
    print(f"\n{line}")
    print(f"  {title}")
    print(line)


def print_metrics_table(eval_results: dict, cv_results: dict) -> None:
    print_section("HELD-OUT TEST SET METRICS")
    hdr = (
        f"  {'Model':<18} {'Acc':>8} {'Prec':>8} {'Rec':>8}"
        f" {'F1':>8} {'AUC':>8} {'Brier':>8} {'LogLoss':>9}"
    )
    print(hdr)
    print("  " + "-" * 78)
    for name, res in eval_results.items():
        if name.startswith("_"):
            continue
        auc_s = f"{res['AUC']:.4f}" if not np.isnan(res["AUC"]) else "   N/A"
        print(
            f"  {name:<18}"
            f" {res['Accuracy']:>8.4f}"
            f" {res['Precision']:>8.4f}"
            f" {res['Recall']:>8.4f}"
            f" {res['F1 Score']:>8.4f}"
            f" {auc_s:>8}"
            f" {res['Brier Score']:>8.4f}"
            f" {res['Log Loss']:>9.4f}"
        )

    if cv_results:
        print_section(f"{CV_FOLDS}-FOLD CROSS-VALIDATION METRICS")
        hdr2 = (
            f"  {'Model':<18} {'CV Acc':>9} {'CV F1':>9}"
            f" {'F1 Std':>9} {'Train F1':>10} {'Overfit':>9}"
        )
        print(hdr2)
        print("  " + "-" * 68)
        for name, res in cv_results.items():
            print(
                f"  {name:<18}"
                f" {res['CV Accuracy']:>9.4f}"
                f" {res['CV F1 Score']:>9.4f}"
                f" {res['CV F1 Std']:>9.4f}"
                f" {res['Train F1']:>10.4f}"
                f" {res['Overfit Gap']:>9.4f}"
            )

    print_section(f"THRESHOLD CHECK  (target >= {int(THRESHOLD * 100)}%)")
    all_pass = True
    for name, res in eval_results.items():
        if name.startswith("_"):
            continue
        for metric in ["Accuracy", "Precision", "Recall", "F1 Score"]:
            val    = res[metric]
            passed = val >= THRESHOLD
            status = "PASS" if passed else "FAIL"
            note   = "" if passed else "  <-- below threshold"
            if not passed:
                all_pass = False
            print(f"  {name:<18} {metric:<12} {val:.4f}   [{status}]{note}")
    print()
    if all_pass:
        print(f"  All metrics passed the {int(THRESHOLD * 100)}% threshold.")
    else:
        print(f"  WARNING: One or more metrics below {int(THRESHOLD * 100)}%.")


def save_reports(eval_results: dict, output_dir: str) -> None:
    for name, res in eval_results.items():
        if name.startswith("_"):
            continue
        fname = name.lower().replace(" ", "_") + "_report.txt"
        fpath = os.path.join(output_dir, fname)
        with open(fpath, "w") as f:
            f.write("SCTD - Symptom Checker for Tropical Diseases\n")
            f.write(f"Model: {name}\n")
            f.write("KNUST Final Year Project\n")
            f.write("=" * 60 + "\n\n")
            f.write(res["report"])
        print(f"  Saved: {fpath}")


def save_config(feature_names: list, n_classes: int, output_dir: str) -> None:
    config = {
        "random_state":        RANDOM_STATE,
        "test_size":           TEST_SIZE,
        "cv_folds":            CV_FOLDS,
        "threshold":           THRESHOLD,
        "n_features":          len(feature_names),
        "n_classes":           n_classes,
        "target_diseases":     TARGET_DISEASES,
        "risk_classification": RISK_CLASSIFICATION,
        "note": (
            "Cholera was listed as a target disease but is absent from the "
            "source dataset (training.csv). 22 of 23 target diseases are covered."
        ),
    }
    path = os.path.join(output_dir, "pipeline_config.json")
    with open(path, "w") as f:
        json.dump(config, f, indent=2)
    print(f"  Saved: {path}")


# ============================================================
# MAIN PIPELINE
# ============================================================

def main() -> None:
    print_section("SCTD PRODUCTION ML PIPELINE")
    print("  Project   : Symptom Checker for Tropical Diseases")
    print("  Institute : KNUST Final Year Project")
    print("  Supervisor: Prof. J.J. Kponyo")
    print("  Dataset   : training.csv (Kaggle - real samples, no synthesis)")
    print("  Models    : Decision Tree (question engine)")
    print("              Random Forest, XGBoost, Logistic Regression")
    print("              Soft-Voting Ensemble (prediction engine)")
    print(f"  Threshold : {int(THRESHOLD * 100)}% on all metrics")
    print(f"  XGBoost   : {'Available' if XGBOOST_AVAILABLE else 'Not available'}")
    print(f"  Target    : {len(TARGET_DISEASES)} diseases")
    print("  Note      : Cholera absent from source dataset (22/23 covered)")

    # --------------------------------------------------
    # STEP 1: Load and clean
    # --------------------------------------------------
    print_section("STEP 1: Loading and Cleaning Dataset")
    df = load_and_clean(DATASET_CSV)
    print(f"  Rows loaded  : {len(df)}")
    print(f"  Classes      : {df['prognosis'].nunique()}")
    print()
    print("  Class distribution:")
    for disease, count in df["prognosis"].value_counts().sort_index().items():
        risk = RISK_CLASSIFICATION.get(disease, "Unknown")
        print(f"    {disease:<46} {count:>3} sample(s)  [{risk} Risk]")

    # --------------------------------------------------
    # STEP 2: Feature engineering
    # --------------------------------------------------
    print_section("STEP 2: Feature Engineering")
    df, feature_cols = engineer_features(df)
    print(f"  Features after engineering : {len(feature_cols)}")
    print("  Added: symptom_count, severity_score, hepatitis_cluster, respiratory_cluster")

    # --------------------------------------------------
    # STEP 3: Label encoding
    # --------------------------------------------------
    x_all = df[feature_cols].values.astype(float)
    y_all = df["prognosis"].values

    le    = LabelEncoder()
    y_enc = le.fit_transform(y_all)
    n_classes = len(le.classes_)
    print(f"\n  Label encoder fitted: {n_classes} classes")

    # --------------------------------------------------
    # STEP 4: Stratified train/test split on REAL data
    # --------------------------------------------------
    print_section("STEP 4: Stratified Train/Test Split (80/20)")
    print("  Split is performed on real data only.")
    print("  No SMOTE or duplication. Test set is fully held out.")
    x_train, x_test, y_train, y_test = train_test_split(
        x_all, y_enc,
        test_size=TEST_SIZE,
        stratify=y_enc,
        random_state=RANDOM_STATE,
    )
    print(f"  Training samples : {len(y_train)}")
    print(f"  Test samples     : {len(y_test)}")
    print(f"  Approx per class (train): {len(y_train) // n_classes}")
    print(f"  Approx per class (test) : {len(y_test)  // n_classes}")

    # --------------------------------------------------
    # STEP 5: Build models
    # --------------------------------------------------
    print_section("STEP 5: Building Model Ensemble")
    models = build_all_models()
    print(f"  Models built: {list(models.keys())}")

    # --------------------------------------------------
    # STEP 6: Cross-validation (on training split only)
    # --------------------------------------------------
    print_section(f"STEP 6: {CV_FOLDS}-Fold Stratified Cross-Validation")
    print("  CV is performed on the training split only.")
    cv_results = run_cross_validation(models, x_train, y_train)
    for name, res in cv_results.items():
        print(
            f"  {name:<18}  CV F1={res['CV F1 Score']:.4f}"
            f"  Train F1={res['Train F1']:.4f}"
            f"  Gap={res['Overfit Gap']:.4f}"
            f"  (+/- {res['CV F1 Std']:.4f})"
        )

    # --------------------------------------------------
    # STEP 7: Final training and test set evaluation
    # --------------------------------------------------
    print_section("STEP 7: Final Training and Test Set Evaluation")
    eval_results = train_and_evaluate(
        models, x_train, y_train, x_test, y_test, le,
    )

    print_metrics_table(eval_results, cv_results)

    best = max(
        [k for k in eval_results if not k.startswith("_")],
        key=lambda k: eval_results[k]["F1 Score"],
    )
    print_section(f"BEST MODEL: {best.upper()}  |  CLASSIFICATION REPORT")
    print(eval_results[best]["report"])

    # --------------------------------------------------
    # STEP 8: SHAP explainability
    # --------------------------------------------------
    print_section("STEP 8: SHAP Explainability (Random Forest)")
    rf_model = eval_results["Random Forest"]["model"]
    compute_shap_values(rf_model, x_train, x_test, feature_cols, OUTPUT_DIR)

    # --------------------------------------------------
    # STEP 9: Save reports and config
    # --------------------------------------------------
    print_section("STEP 9: Saving Reports")
    save_reports(eval_results, OUTPUT_DIR)
    save_config(feature_cols, n_classes, OUTPUT_DIR)

    risk_rows = [{"Disease": d, "Risk Level": r} for d, r in RISK_CLASSIFICATION.items()]
    risk_df   = pd.DataFrame(risk_rows)
    risk_df["Order"] = risk_df["Risk Level"].map({"High": 0, "Medium": 1, "Low": 2})
    risk_df   = risk_df.sort_values(["Order", "Disease"]).drop(columns="Order")
    risk_path = os.path.join(OUTPUT_DIR, "sctd_disease_risk_classification.csv")
    risk_df.to_csv(risk_path, index=False)
    print(f"  Saved: {risk_path}")

    # --------------------------------------------------
    # STEP 10: Evaluation plots
    # --------------------------------------------------
    print_section("STEP 10: Generating Evaluation Plots")
    plot_metrics_comparison(
        eval_results,
        os.path.join(OUTPUT_DIR, "01_metrics_comparison.png"),
    )
    plot_confusion_matrix(
        eval_results, le, best,
        os.path.join(OUTPUT_DIR, "02_confusion_matrix_best_model.png"),
    )
    plot_cv_comparison(
        cv_results,
        os.path.join(OUTPUT_DIR, "03_cv_overfit_analysis.png"),
    )
    plot_roc_curves(
        eval_results, le, best, y_test,
        os.path.join(OUTPUT_DIR, "04_roc_curves.png"),
    )
    plot_precision_recall_curves(
        eval_results, le, best, y_test,
        os.path.join(OUTPUT_DIR, "05_precision_recall_curves.png"),
    )
    plot_per_class_metrics(
        eval_results, le, best, y_test,
        os.path.join(OUTPUT_DIR, "06_per_class_metrics.png"),
    )
    plot_calibration_metrics(
        eval_results,
        os.path.join(OUTPUT_DIR, "07_calibration_metrics.png"),
    )

    # --------------------------------------------------
    # STEP 11: Save all model artifacts
    # --------------------------------------------------
    print_section("STEP 11: Saving Models and Artifacts")
    artifacts = {
        "sctd_question_tree.pkl":       models["Decision Tree"],
        "sctd_random_forest.pkl":       eval_results["Random Forest"]["model"],
        "sctd_ensemble.pkl":            eval_results["Ensemble"]["model"],
        "sctd_label_encoder.pkl":       le,
        "sctd_feature_columns.pkl":     feature_cols,
        "sctd_risk_classification.pkl": RISK_CLASSIFICATION,
        "sctd_symptom_severity.pkl":    SYMPTOM_SEVERITY_WEIGHTS,
    }
    if XGBOOST_AVAILABLE and "XGBoost" in eval_results:
        artifacts["sctd_xgboost.pkl"] = eval_results["XGBoost"]["model"]
    if "Log Regression" in eval_results:
        artifacts["sctd_logistic.pkl"] = eval_results["Log Regression"]["model"]

    for filename, obj in artifacts.items():
        path = os.path.join(OUTPUT_DIR, filename)
        joblib.dump(obj, path)
        print(f"  Saved: {path}")

    # --------------------------------------------------
    # Final summary
    # --------------------------------------------------
    print_section("PIPELINE COMPLETE")
    print(f"  Output directory : {os.path.abspath(OUTPUT_DIR)}")
    print(f"  Best model       : {best}")
    print()
    print("  All output files:")
    for f in sorted(os.listdir(OUTPUT_DIR)):
        print(f"    {f}")

    print()
    print("  Final Model Summary:")
    hdr = (
        f"  {'Model':<18} {'Accuracy':>10} {'Precision':>10}"
        f" {'Recall':>10} {'F1':>10} {'AUC':>10}"
    )
    print(hdr)
    print("  " + "-" * 72)
    for name in eval_results:
        if name.startswith("_"):
            continue
        r      = eval_results[name]
        auc_s  = f"{r['AUC']:.4f}" if not np.isnan(r["AUC"]) else "   N/A"
        marker = "  <-- BEST" if name == best else ""
        print(
            f"  {name:<18}"
            f" {r['Accuracy']:>10.4f}"
            f" {r['Precision']:>10.4f}"
            f" {r['Recall']:>10.4f}"
            f" {r['F1 Score']:>10.4f}"
            f" {auc_s:>10}"
            f"{marker}"
        )

    print()
    print("  Streamlit integration:")
    print("  " + "-" * 50)
    print("    import joblib")
    print("    from sctd_model_training import (")
    print("        predict_with_risk,")
    print("        get_next_question,")
    print("        explain_single_prediction,")
    print("    )")
    print("    ensemble = joblib.load('sctd_outputs/sctd_ensemble.pkl')")
    print("    le       = joblib.load('sctd_outputs/sctd_label_encoder.pkl')")
    print("    cols     = joblib.load('sctd_outputs/sctd_feature_columns.pkl')")
    print("    result   = predict_with_risk(ensemble, le, cols, symptom_vector)")


if __name__ == "__main__":
    main()
