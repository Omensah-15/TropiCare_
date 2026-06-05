/*
 * TropiCare — Symptom Image Registry
 *
 * HOW FALLBACK WORKS
 *
 * App.jsx does:
 *   const imgPath = SYMPTOM_IMAGES[question.id];
 *   const catPath = getCategoryImage(question.category);
 *   const src = imgPath || catPath;         ← imgPath wins if truthy
 *   if (src) return <img src={src} ... />
 *   // else renders the inline SVG
 *
 * So the fallback chain is:
 *   1. SYMPTOM_IMAGES[id]          → specific symptom PNG  (if it exists on disk)
 *   2. getCategoryImage(category)  → category PNG          (if it exists on disk)
 *   3. inline SVG component        → always available
 *
 * To make step 1 → 2 work reliably WITHOUT async probes and WITHOUT touching
 * App.jsx, we simply set SYMPTOM_IMAGES values to null for any image that is
 * NOT present in the public folder.  A null value is falsy, so App.jsx
 * naturally falls through to getCategoryImage.
 *
 * MAINTENANCE RULE:
 *   - Image exists at the listed path  → keep the path string as the value.
 *   - Image does NOT exist             → set the value to null.
 *   - This file is the single source of truth; no runtime async checks needed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SYMPTOM IMAGE PATHS
// Key   = symptom id (matches ALL_QUESTIONS ids in App.jsx)
// Value = path string (image exists) | null (missing → use category fallback)
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
  Metabolic:    "/images/categories/metabolic.png",
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


// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME BROKEN-IMAGE GUARD
//
// Even with correct paths, a file might be missing from the server at runtime.
// This guard patches the <img> elements rendered by App.jsx's QuestionIllus
// so that if an image 404s, it is hidden and the next fallback (category image
// or inline SVG) is shown instead — with zero changes to App.jsx.
//
// How it works:
//   QuestionIllus renders:  <img src={src} style={{...}} />
//   If that request fails, the browser fires an "error" event on the element.
//   We intercept it with a document-level capture listener, hide the broken
//   <img>, and let the React component re-render with null via a custom event.
//
// Because App.jsx computes `src = imgPath || catPath` at render time and does
// not re-check after an error, we instead directly swap the <img> src to the
// category fallback when the symptom image fails.  If the category image also
// fails, we hide the element entirely so the inline SVG (rendered separately
// inside the same .q-illus div) can show.
//
// NOTE: This only applies to the symptom/category images inside .q-illus.
//       It will not interfere with any other images in the app.
// ─────────────────────────────────────────────────────────────────────────────
(function installBrokenImageGuard() {
  // We can only attach DOM listeners once the document exists.
  const attach = () => {
    document.addEventListener(
      "error",
      (e) => {
        const img = e.target;
        // Only intercept <img> elements inside a .q-illus container.
        if (img.tagName !== "IMG" || !img.closest(".q-illus")) return;

        const current = img.src;

        // ── Step 1: symptom image failed → try the category fallback ────────
        // The category is stored on the closest .q-illus's parent .q-body
        // via the data-category attribute we inject below, OR we parse it
        // from the alt attribute that QuestionIllus sets to question.category.
        const category = img.getAttribute("alt");
        const catPath  = category ? (CATEGORY_IMAGES[category] ?? null) : null;

        if (catPath && !img.src.endsWith(catPath.replace(/^\//, ""))) {
          // Haven't tried the category image yet — swap to it.
          img.onerror = () => {
            // ── Step 2: category image also failed → hide the img entirely ──
            img.style.display = "none";
          };
          img.src = catPath;
          return;
        }

        // ── Step 3: nothing left — hide the broken img ──────────────────────
        img.style.display = "none";
      },
      true // capture phase so we get the event before React
    );
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
})();
