/*
 * TropiCare — Symptom Image Registry
 */

// ─────────────────────────────────────────────────────────────────────────────
// SYMPTOM IMAGE PATHS
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
  nausea:                "/images/symptoms/nausea.png",
  vomiting:              "/images/symptoms/vomiting.png",
  diarrhoea:             "/images/symptoms/diarrhoea.png",
  stomach_pain:          "/images/symptoms/abdominal_pain.png",
  abdominal_pain:        "/images/symptoms/abdominal_pain.png",
  indigestion:           "/images/symptoms/indigestion.png",
  distension_of_abdomen: "/images/symptoms/distension_of_abdomen.png",
  constipation:          "/images/symptoms/constipation.png",
  passage_of_gases:      "/images/symptoms/gas.png",
  bloody_stool:          "/images/symptoms/bloody_stool.png",
  loss_of_appetite:      "/images/symptoms/loss_of_appetite.png",
  stomach_bleeding:      "/images/symptoms/stomach_bleeding.png",

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
  burning_micturition:      "/images/symptoms/burning_micturition.png",
  urinating_frequently:     "/images/symptoms/urinating_frequently.png",
  continuous_feel_of_urine: "/images/symptoms/urinating_frequently.png",
  bladder_discomfort:       "/images/symptoms/bladder_discomfort.png",
  foul_smell_of_urine:      "/images/symptoms/foul_smell_of_urine.png",
  spotting_urination:       "/images/symptoms/spotting_urination.png",

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
  Metabolic:    "/images/categories/metabolic.png",
  Infection:    "/images/categories/infection.png",
  History:      "/images/categories/history.png",
};

/**
 * getCategoryImage(category)
 * Returns the category-level fallback image path, or null if none configured.
 */
export function getCategoryImage(category) {
  return CATEGORY_IMAGES[category] ?? null;
}


// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME BROKEN-IMAGE GUARD
//
// When a symptom or category PNG is missing from the server, the browser fires
// an error event on the <img> element.  This guard intercepts that event and
// cascades through the fallback chain:
//
//   symptom PNG failed  →  swap src to category PNG
//   category PNG failed →  hide <img> entirely (inline SVG below it shows)
//
// Uses a capture-phase listener so it fires before React's own event handling.
// Only acts on <img> elements inside a .q-illus container so it never touches
// anything else in the app.
//
// The "already tried" state is tracked with a data attribute on the element
// itself — no shared mutable state, no timing issues.
// ─────────────────────────────────────────────────────────────────────────────
(function installBrokenImageGuard() {

  function onImgError(e) {
    const img = e.target;

    // Only handle <img> tags inside the symptom illustration container.
    if (!(img instanceof HTMLImageElement) || !img.closest(".q-illus")) return;

    const alreadyTriedCategory = img.dataset.triedCategory === "1";

    if (!alreadyTriedCategory) {
      // ── Step 1: symptom image failed — try the category fallback ──────────
      // App.jsx sets alt={question.category} e.g. "General", "Skin".
      const category = img.getAttribute("alt");
      const catPath  = category ? (CATEGORY_IMAGES[category] ?? null) : null;

      if (catPath) {
        img.dataset.triedCategory = "1";  // mark so we don't loop
        img.src = catPath;                // triggers another load attempt
        return;                           // wait for load/error on the new src
      }
    }

    // ── Step 2: category image also failed (or no category) — hide the img ──
    // The inline SVG sibling inside .q-illus will now be visible instead.
    img.style.display = "none";
  }

  function attach() {
    document.addEventListener("error", onImgError, true /* capture */);
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", attach);
    } else {
      attach();
    }
  }
})();
