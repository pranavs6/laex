// Hunspell spelling in a worker, so loading the dictionary (about a second)
// and generating suggestions never block typing.
import NSpell from "nspell";

let spell = null;
const suggestions = new Map();

function correct(word) {
  if (spell.correct(word)) return true;
  // Sentence-initial or title-case words: accept if the lower-case form is known.
  if (/^\p{Lu}\p{Ll}+$/u.test(word) && spell.correct(word.toLowerCase())) return true;
  // Possessives: "Claude's", "Chennai’s".
  const base = word.replace(/['’]s$/u, "");
  if (base !== word && correct(base)) return true;
  return false;
}

self.onmessage = ({ data }) => {
  if (data.type === "init") {
    spell = NSpell(data.aff, data.dic);
    for (const w of data.words) spell.add(w);
    suggestions.clear();
    self.postMessage({ type: "ready" });
  } else if (data.type === "add") {
    spell?.add(data.word);
  } else if (data.type === "check") {
    if (!spell) return;
    const bad = data.words.filter((w) => !correct(w));
    self.postMessage({ type: "checked", id: data.id, bad });
    // Suggestions are slower; send them after the first result.
    const out = {};
    for (const w of bad.slice(0, 60)) {
      if (!suggestions.has(w)) suggestions.set(w, spell.suggest(w).slice(0, 4));
      out[w] = suggestions.get(w);
    }
    self.postMessage({ type: "suggestions", id: data.id, suggestions: out });
  }
};
