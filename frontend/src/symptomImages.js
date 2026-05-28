/*
 * TropiCare — Symptom Image Registry
 */

// ─────────────────────────────────────────────────────────────────────────────
// PER-SYMPTOM IMAGE PATHS
// Key   = symptom id (must match ALL_QUESTIONS ids in App.jsx exactly)
// Value = public asset path string  OR  null to use category/SVG fallback
// ─────────────────────────────────────────────────────────────────────────────
export const SYMPTOM_IMAGES = {

  // ── General ──────────────────────────────────────────────────────────────
  high_fever:    "/images/symptoms/fever.png",
  mild_fever:    "/images/symptoms/fever.png",
  fatigue:       "/images/symptoms/fatigue.png",
  malaise:       "/images/symptoms/malaise.png",
  chills:        "/images/symptoms/chills.png",
  sweating:      "/images/symptoms/sweating.png",
  headache:      "/images/symptoms/headache.png",
  muscle_pain:   "/images/symptoms/muscle_pain.png",
  joint_pain:    "/images/symptoms/joint_pain.png",
  back_pain:     "/images/symptoms/back_pain.png",

  // ── Respiratory ───────────────────────────────────────────────────────────
  cough:               "/images/symptoms/cough.png",
  phlegm:              "/images/symptoms/phlegm.png",
  rusty_sputum:        "/images/symptoms/sputum.png",
  blood_in_sputum:     "/images/symptoms/blood_in_sputum.png",
  breathlessness:      "/images/symptoms/breathlessness.png",
  chest_pain:          "/images/symptoms/chest_pain.png",
  runny_nose:          "/images/symptoms/runny_nose.png",
  continuous_sneezing: "/images/symptoms/sneezing.png",
  throat_irritation:   "/images/symptoms/sore_throat.png",
  sinus_pressure:      "/images/symptoms/sinus_pressure.png",
  watering_from_eyes:  "/images/symptoms/watering_from_eyes.png",
  loss_of_smell:       "/images/symptoms/loss_of_smell.png",

  // ── Digestive ─────────────────────────────────────────────────────────────
  nausea:                 "/images/symptoms/nausea.png",
  vomiting:               "/images/symptoms/vomiting.png",
  diarrhoea:              "/images/symptoms/diarrhoea.png",
  stomach_pain:           "/images/symptoms/abdominal_pain.png",
  abdominal_pain:         "/images/symptoms/abdominal_pain.png",
  indigestion:            "/images/symptoms/indigestion.png",
  distension_of_abdomen:  "/images/symptoms/distension_of_abdomen.png",
  constipation:           "/images/symptoms/constipation.png",
  passage_of_gases:       "/images/symptoms/gas.png",
  bloody_stool:           "/images/symptoms/bloody_stool.png",
  loss_of_appetite:       "/images/symptoms/loss_of_appetite.png",
  stomach_bleeding:       "/images/symptoms/stomach_bleeding.png",

  // ── Liver ─────────────────────────────────────────────────────────────────
  yellowish_skin:      "/images/symptoms/yellowish_skin.png",
  yellowing_of_eyes:   "/images/symptoms/yellowing_of_eyes.png",
  dark_urine:          "/images/symptoms/dark_urine.png",
  yellow_urine:        "/images/symptoms/dark_urine.png",
  internal_itching:    "/images/symptoms/internal_itching.png",
  acute_liver_failure: "/images/symptoms/acute_liver_failure.png",
  fluid_overload:      "/images/symptoms/fluid_overload.png",

  // ── Skin ──────────────────────────────────────────────────────────────────
  itching:              "/images/symptoms/itching.png",
  skin_rash:            "/images/symptoms/skin_rash.png",
  red_spots_over_body:  "/images/symptoms/skin_rash.png",
  nodal_skin_eruptions: "/images/symptoms/nodal_skin_eruptions.png",
  dischromic_patches:   "/images/symptoms/dischromic_patches.png",

  // ── Eyes ──────────────────────────────────────────────────────────────────
  redness_of_eyes:  "/images/symptoms/redness.png",
  blurred_vision:   "/images/symptoms/blurred.png",
  pain_behind_eyes: "/images/symptoms/pain_behind_eyes.png",

  // ── Urinary ───────────────────────────────────────────────────────────────
  burning_micturition:       "/images/symptoms/burning_micturition.png",
  urinating_frequently:      "/images/symptoms/urinating_frequently.png",
  continuous_feel_of_urine:  "/images/symptoms/urinating_frequently.png",
  bladder_discomfort:        "/images/symptoms/bladder_discomfort.png",
  foul_smell_of_urine:       "/images/symptoms/foul_smell_of_urine.png",
  spotting_urination:        "/images/symptoms/spotting_urination.png",

  // ── Rectal ────────────────────────────────────────────────────────────────
  pain_anal_region:     "/images/symptoms/pain_anal_region.png",
  pain_bowel_movements: "/images/symptoms/pain_bowel_movements.png",
  irritation_anus:      "/images/symptoms/pain_anal_region.png",

  // ── Neurological ──────────────────────────────────────────────────────────
  restlessness: "/images/symptoms/restlessness.png",
  mood_swings:  "/images/symptoms/mood_swings.png",
  confusion:    "/images/symptoms/confusion.png",
  coma:         "/images/symptoms/coma.png",

  // ── Metabolic ─────────────────────────────────────────────────────────────
  excessive_hunger:      "/images/symptoms/excessive_hunger.png",
  increased_appetite:    "/images/symptoms/increased_appetite.png",
  irregular_sugar_level: "/images/symptoms/irregular_sugar_level.png",
  polyuria:              "/images/symptoms/polyuria.png",
  dehydration:           "/images/symptoms/dehydration.png",
  weight_loss:           "/images/symptoms/slim.png",
  obesity:               "/images/symptoms/obesity.png",

  // ── Infection ─────────────────────────────────────────────────────────────
  swelled_lymph_nodes:    "/images/symptoms/swelled_lymph_nodes.png",
  swelling_stomach:       "/images/symptoms/swelling_stomach.png",
  fast_heart_rate:        "/images/symptoms/fast_heart_rate.png",
  toxic_look:             "/images/symptoms/toxic_look.png",
  swollen_lymph_neck:     "/images/symptoms/swollen_lymph_neck.png",
  loss_of_appetite_fever: "/images/symptoms/loss_of_appetite_fever.png",

  // ── History ───────────────────────────────────────────────────────────────
  family_history:       "/images/symptoms/family_history.png",
  blood_transfusion:    "/images/symptoms/blood_transfusion.png",
  unsterile_injections: "/images/symptoms/unsterile_injections.png",
  alcohol_history:      "/images/symptoms/alcohol_history.png",
};


// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY-LEVEL FALLBACK IMAGES
// Used when a specific symptom image is null or missing.
// Set a value to null to use the built-in inline SVG instead.
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_IMAGES = {
  General:      "/images/categories/general.png",
  Respiratory:  "/images/categories/respiratory.png",
  Digestive:    "/images/categories/digestive.png",
  Liver:        "/images/categories/liver.png",
  Skin:         "/images/categories/skin.png",
  Eyes:         "/images/categories/eyes.png",
  Urinary:      "/images/categories/urinary.png",
  Rectal:       "/images/categories/digestive.png",   // reuses digestive art
  Neurological: "/images/categories/general.png",     // reuses general art
  Metabolic:    "/images/categories/general.png",
  Infection:    "/images/categories/infection.png",
  History:      "/images/categories/history.png",
};

/**
 * getCategoryImage(category)
 * Returns the category-level fallback image path, or null if none configured.
 *
 * @param {string} category - The symptom category (e.g. "General", "Skin")
 * @returns {string|null}
 */
export function getCategoryImage(category) {
  return CATEGORY_IMAGES[category] ?? null;
}

