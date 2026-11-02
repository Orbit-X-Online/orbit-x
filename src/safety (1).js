// Shared safety rules for every AI surface (assistant, explain, summary, document explainer, workspace ask, voice).
// Orbit gives health INFORMATION only. It does not diagnose, infer causes, suggest treatment or self-care, or name/adjust medicines.
// 1) preCheck(): fixed, rule-based, runs BEFORE any model call and works with no AI key.
// 2) unsafe()/guardText(): wide check on every model output; anything that gives advice is replaced by a fixed text.
// Non-English wording coverage in preCheck is partial (a short keyword list); the output guard always reads English (replies are written in English, then translated).

export const EMERGENCY_REPLY = 'This may be an emergency. Call 112 now, or press the help button in Orbit-X. Do not wait for this app. Orbit-X cannot assess symptoms.';
export const SELFHARM_REPLY = 'I am sorry you are feeling this way. You deserve support right now. If you might hurt yourself or are in danger, call 112 now. Please do not stay alone: tell someone near you, or call your doctor, nurse or a trusted family member straight away. Orbit-X cannot give medical advice, but people can help.';
export const ADVICE_REPLY = 'Orbit-X gives information only. It cannot give medical advice, diagnose, or say what to take, stop or do. Please ask your doctor, nurse or pharmacist. If this is urgent, call 112 now. I can explain what a word or test in your records means.';
export const SAFE_FALLBACK = 'Orbit-X cannot give medical advice. Please ask your doctor, nurse or pharmacist. If this is urgent, call 112 now.';

const EMERGENCY = [
  /\b(chest (pain|pressure|tightness)|pain in (my |the )?chest|tight(ness)? in (my |the )?chest)\b/i,
  /\b(can'?t|cannot|unable to|hard to|trouble|difficulty|struggling to) (breathe|breathing)\b|\bshort(ness)? of breath\b|\bnot able to breathe\b/i,
  /\b(face (is )?droop\w*|drooping (face|mouth)|slurred speech|can'?t speak|weak(ness)? (in )?(my |the |one )?(arm|leg|side)|numb(ness)? (in )?(my |the |one )?(arm|face|side)|stroke)\b/i,
  /\b(severe|heavy|won'?t stop|uncontrolled) bleeding\b|\bbleeding (a lot|heavily|badly)\b/i,
  /\b(fainted|fainting|passed out|unconscious|unresponsive|collapsed|seizure|convulsion|fitting)\b/i,
  /\b(sudden|worst|thunderclap) (very |severe |terrible )?(bad |severe )?headache\b|\bworst headache\b/i,
  /\b(overdos\w*|took too (many|much)|swallowed (too|a lot))\b/i,
  /\b(is|are) (dying|having a heart attack)\b|\bheart attack\b/i,
  // partial coverage of other languages
  /\b(dolor de pecho|no puedo respirar|me desmay\w*)\b/i, /\b(douleur (dans|à|a) la poitrine|n'arrive pas à respirer|je n'arrive pas a respirer)\b/i,
  /\b(ciwon kirji|ba zan iya numfashi)\b/i, /\b(dor no peito|n[aã]o consigo respirar)\b/i, /(ألم في الصدر|لا أستطيع التنفس)/,
];
const SELFHARM = [
  /\b(kill(ing)? myself|end(ing)? (my|this) life|take my (own )?life|suicid\w*|want(ed)? to die|wish i (was|were) dead|self[- ]?harm\w*|hurt(ing)? myself|harm myself|don'?t want to (live|be alive)|better off dead|no reason to live)\b/i,
  /\b(quiero morir|me quiero matar|suicidarme|me suicider|je veux mourir|quero morrer|أريد أن أموت)\b/i,
];
const ADVICE = [
  /\b(should|shall|can|could|may|must|do) (i|we) (take|stop|skip|double|halve|reduce|increase|lower|raise|change|start|use|eat|drink|avoid|go|worry|ignore|wait|call|see|rest|exercise|fast)\b/i,
  /\bwhat (should|can|could|do) (i|we) (do|take|use|eat|drink)\b/i,
  /\b(what|which) (medicine|medication|tablet|tablets|pill|pills|drug|drugs|dose|dosage|treatment|remedy|painkiller)\b/i,
  /\b(how (much|many) (should|do|can) (i|he|she|they)|how (do|can|to) (i|we|you) (lower|reduce|treat|cure|fix|control|manage|get rid))\b/i,
  /\b(do|does|did) (i|he|she|they|my (mum|mom|dad|mother|father|husband|wife|friend)) have\b.{0,40}\b(diabet\w*|hypertension|cancer|disease|condition|infection|kidney|heart|stroke|anaemia|anemia|illness|problem)\b/i,
  /\b(diagnose|diagnosis|what('?s| is) (wrong|the cause|causing)|what caused|why (do|am|is|does) (i|my)|is it (serious|dangerous|safe|bad)|is (this|that|it) (a sign|normal|ok|okay|fine|safe|dangerous|serious))\b/i,
  /\bis (my |this |that |the )?(\d{2,3}\s*(\/|over)\s*\d{2,3}|reading|blood pressure|bp|result|results|level|sugar)\b.{0,30}\b(normal|ok|okay|fine|safe|dangerous|bad|high|low|serious|healthy|good|worrying)\b/i,
  /\b(is|are) \d{2,3}\s*(\/|over)\s*\d{2,3} (normal|ok|okay|fine|safe|dangerous|bad|high|low|serious|healthy)\b/i,
  /\b(prescribe|prescription|recommend (a|some|me)|treat(ment)? (for|of) my|natural remedy|home remedy|cure for|side effects? of my)\b/i,
  /\b(puedo tomar|debo tomar|dejar de tomar|puis-je prendre|dois-je prendre|devo tomar)\b/i,
];

const test = (list, t) => list.some((r) => r.test(t));
const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();

// Returns null when the text may go on, or { type, reply } with a fixed answer. Order matters: danger first.
export function preCheck(text) {
  const t = norm(text);
  if (!t) return null;
  if (test(SELFHARM, t)) return { type: 'selfharm', reply: SELFHARM_REPLY };
  if (test(EMERGENCY, t)) return { type: 'emergency', reply: EMERGENCY_REPLY };
  if (test(ADVICE, t)) return { type: 'advice', reply: ADVICE_REPLY };
  return null;
}

// Wide output guard. True means the text must NOT be shown.
const MED_NAME = /\b(ibuprofen|paracetamol|acetaminophen|tylenol|panadol|aspirin|metformin|insulin|warfarin|digoxin|furosemide|hydrochlorothiazide|diazepam|tramadol|codeine|morphine|antibiotics?|painkillers?|pain ?relie\w+|sedatives?|steroids?|supplements?|herbal|over[- ]the[- ]counter|\w+(pril|sartan|olol|dipine|statin|formin|azepam|cillin|mycin))\b/i;
const OUTPUT_RULES = [
  /\b(diagnos\w*|prognos\w*|prescri\w*|cure[sd]?|treat(ment|ments|ing|ed)?|therap(y|ies)|remed(y|ies))\b/i,
  /\bdos(e|es|age|ing)\b|\b\d+(\.\d+)?\s?(mg|mcg|µg|ml|g|iu|units?)\b|\b(once|twice|three times) (a|per|every) (day|daily|week)\b/i,
  /\byou (have|probably have|likely have|might have|may have|could have|are suffering|suffer|seem to have|appear to have)\b/i,
  /\b(you|they|he|she) (should|must|need to|ought to|have to|had better|can try|could try|might want to|may want to)\b/i,
  /\b(i|we) (recommend|suggest|advise|urge|would)\b|\b(it is|it's) (best|better|safe|fine|ok|okay|important) (to|for you to)\b|\b(i|we) (think|believe) (you|it)\b/i,
  /\b(try to|make sure (you|to)|be sure to|remember to|avoid|don'?t|do not (take|eat|drink|worry|skip|stop))\b/i,
  /\b(sit|lie|lay|get) down\b|\bsit or lie\b|\b(get|have|take) (some |a )?rest\b|\brest (for|a while|up|and)\b|\brelax\w*\b|\bsip\w*\b|\bdrink (some |a glass of |plenty of |more )?(water|fluids)\b|\bmeasure (it |your (blood pressure|bp|reading) )?again\b|\bretake\b|\bstay (calm|where you are|hydrated|still|put)\b|\bdeep breath\w*\b|\blie back\b/i,
  /\b(take|swallow|use|apply|have) (it|this|that|them|one|two|some|these|those)( now| later| when| with| after| before|\b)(?! (a look|a moment))/i,
  /\b(take|taking|took) (an? |some |your |the |one |two |another |extra |more |less |double )?(tablet|tablets|pill|pills|medicine|medication|drug|drugs|dose)\b|\b(stop|skip|halve|double|increase|decrease|reduce|raise|lower|change|adjust|miss|delay) (taking )?(your |the |that |a )?(tablet|tablets|pill|pills|medicine|medication|drug|drugs|dose)\b/i,
  /\b(is|are|was|were|be|being|been|can be|could be|may be|might be|often|usually|commonly|typically) (caused|brought on|triggered|due|linked|related|connected|associated|a sign|a symptom|a result|a side effect|a cause)\b/i,
  /\b(caused|brought on|triggered|provoked) (by|from)\b|\b(linked|related|connected|associated) (to|with)\b|\b(because of|due to|result of|sign of|symptom of|signs of|symptoms of|cause of|causes of|reason for|side effects? of|leads? to|lead to|means (that )?you|indicates? (that )?you|suggests? (that )?you|point(s)? to|go(es)? with|can go with)\b/i,
  /\b(nothing to worry|no need to worry|don'?t worry|do not worry|not serious|not dangerous|is (perfectly )?normal|are (perfectly )?normal|totally fine|you are (fine|ok|okay|healthy|safe)|you'?re (fine|ok|okay|healthy|safe)|healthy range|good sign|bad sign|worrying sign|concerning sign|reassur\w+)\b/i,
  /\b(lifestyle|diet|exercise|workout|weight loss|lose weight|salt intake|reduce salt|less salt|cut down on|quit smoking|stop smoking|alcohol|caffeine|stress management|hydrat\w+)\b/i,
];
export function unsafe(text) {
  const t = norm(text);
  if (!t) return true;
  if (MED_NAME.test(t)) return true;
  return OUTPUT_RULES.some((r) => r.test(t));
}
// For free text from the model: the text itself, or the fixed fallback. Length-capped.
export function guardText(text, max = 1200) {
  const t = String(text || '').trim();
  if (!t || t.length > max || unsafe(t)) return SAFE_FALLBACK;
  return t;
}
// For short plain definitions of a test or term (document explainer). Same guard; definitions may not mention numbers/doses.
export function safeDefinition(text, max = 260) {
  const t = norm(text);
  return t && t.length <= max && !unsafe(t) ? t : '';
}
