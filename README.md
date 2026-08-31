# TropiCare

TropiCare helps individuals identify tropical disease risks through adaptive symptom assessment, machine learning prediction, risk classification, and nearby clinic navigation — and lets health workers run that same screening on behalf of the patients in their care.

🌐 **Live App:** [TropiCare](https://tropi-care.vercel.app/)

---

## Demo

<div align="center">
  <img src="https://github.com/Omensah-15/TropiCare_/raw//8135125c8155dc16b36e1b6429e58780e08a68e5/assets/tropicaredemo.gif" 
  alt="TropiCare Demo" width="800">
</div>

---

## Overview

<div align="center">
<img src="https://github.com/Omensah-15/TropiCare_/blob/80033a3d52f672b459fbfedea78d75276443397d/assets/overview.png"
alt="app">
</div>

Built for West Africa, TropiCare bridges the gap between symptom onset and clinical support by providing early risk assessment and actionable health guidance — whether someone is checking their own symptoms or a health worker is screening someone in their community.

**Key capabilities:**
- Adaptive symptom assessment
- ML disease risk prediction
- High / Medium / Low risk classification
- AI-powered recommendations
- Assessment history tracking
- Nearby clinic finder and navigation, available at every risk level
- Two account types — self-screening individuals and health workers

**System coverage:**
- 41 diseases
- 130 symptoms
- 15 maximum questions
- 3 ML models:
  - Random Forest
  - XGBoost
  - Logistic Regression

---

## For Health Workers

Anyone can sign up as an individual for self-screening, exactly as before — or as a **health worker**, unlocking a patient-management layer on top of the same assessment engine:

- **Register patients with consent** — name, age, gender, and community, gated on an explicit consent confirmation before any record is created.
- **Screen on a patient's behalf** — run the full adaptive assessment for a registered patient rather than yourself, with the result and PDF report correctly attributed to them (not the worker's own account).
- **Track a patient roster** — every registered patient shows their most recent risk tier, sorted highest-risk first, with full assessment history per patient.
- **Red-flag reporting** — PDF reports surface a high-visibility warning block when an assessment triggers a red-flag symptom pattern, so it can't be missed by a clinician skimming the report.

A worker's own account never mixes with their patients' identities: reports for a worker-entered patient show that patient's own details, falling back to "Not provided" rather than ever substituting the worker's stored information.

---

## Confidence Evolution

<div align="center">
<img src="https://github.com/Omensah-15/TropiCare_/blob/587e1aa8f0c2c13437433d96316cbd12edce02d6/assets/example_confidence_evolution.png"
alt="Confidence Evolution Chart">
</div>

Model confidence changes dynamically as symptoms are added during an assessment.

---

## Clinic Finder & Navigation

<div align="center">
<img src="https://github.com/Omensah-15/TropiCare_/raw/deec85a53b913aba2a6d0aa6d36699ef7271a334/assets/clinifinder-navigation-demo.gif"
alt="Clinic Finder Navigation Demo"
width="300">
</div>

Nearby clinics and directions are available for every assessment result, regardless of risk tier.

---

## Disclaimer

TropiCare is an informational health support tool and does not replace professional medical diagnosis or clinical consultation.

---

## Author

**Mensah Obed**

[![Email](https://img.shields.io/badge/Email-heavenzlebron7%40gmail.com-red?style=for-the-badge&logo=gmail)](mailto:heavenzlebron7@gmail.com)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Obed_Mensah-blue?style=for-the-badge&logo=linkedin)](https://www.linkedin.com/in/obed-mensah-87001237b)
