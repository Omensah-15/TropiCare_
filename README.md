# TropiCare

TropiCare helps people identify tropical disease risks through adaptive symptom assessment, machine learning prediction, risk classification, and nearby clinic navigation. Individuals can screen themselves, and health workers can register and screen patients in their care.

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

Built for West Africa, TropiCare bridges the gap between symptom onset and clinical support by providing early risk assessment and actionable health guidance, for both individuals checking their own symptoms and health workers screening people in their community.

**Key capabilities:**
- Adaptive symptom assessment
- ML disease risk prediction
- High / Medium / Low risk classification
- AI-powered recommendations
- Assessment history tracking
- Nearby clinic finder and navigation, available at every risk level
- Individual and health-worker accounts

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

Health worker accounts add a patient-management layer on top of the same assessment engine:

- **Patient registration with consent** — name, age, gender, and community, gated on an explicit consent confirmation.
- **Screening on a patient's behalf** — the worker runs the full adaptive assessment for a registered patient, with the result and PDF report attributed to that patient.
- **Patient roster** — every registered patient shows their most recent risk tier, sorted highest-risk first, with full assessment history per patient.
- **Red-flag reporting** — PDF reports carry a high-visibility warning block whenever an assessment triggers a red-flag symptom pattern, so it can't be missed by a clinician skimming the report.

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
