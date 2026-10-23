/* Preposition Quest Quiz Manager — Stage 9.4 foundation.
 * Keeps the existing multiple-choice flow while centralizing shared rules
 * for upcoming typing, sentence-building, and speaking modes.
 */
(() => {
  "use strict";
  const SUPPORTED_MODES = Object.freeze([
    "multiple-choice", "picture-sentence", "drag-drop", "typing", "speaking"
  ]);
  function normalizeAnswer(value) {
    return String(value == null ? "" : value)
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .replace(/[’‘]/g, "'")
      .replace(/-/g, " ")
      .replace(/[^\p{L}\p{N}' ]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function validateChoice(answer, question) {
    if (!question) return false;
    return normalizeAnswer(answer) === normalizeAnswer(question.correct);
  }
  function validateTypedAnswer(answer, question) {
    if (!question) return false;
    const accepted = Array.isArray(question.acceptedAnswers) && question.acceptedAnswers.length
      ? question.acceptedAnswers : [question.correct];
    const candidate = normalizeAnswer(answer);
    return candidate.length > 0 && accepted.some(value => normalizeAnswer(value) === candidate);
  }
  function calculatePoints(incorrectAttempts) {
    const mistakes = Math.max(0, Number(incorrectAttempts) || 0);
    return mistakes === 0 ? 3 : mistakes === 1 ? 2 : mistakes === 2 ? 1 : 0;
  }
  function worldForQuestion(index) {
    return index >= 6 ? "SKY TEMPLE" : index >= 4 ? "MYSTERY CAVE" : "FOREST TRAIL";
  }
  function getMode(question) {
    const mode = question && question.mode;
    return SUPPORTED_MODES.includes(mode) ? mode : "multiple-choice";
  }
  function validateQuestion(question) {
    if (!question || !question.id || !question.prompt || question.correct == null) return false;
    const mode = question.mode;
    const optionsAreValid = Array.isArray(question.options) && question.options.length >= 2;
    // Choice-based modes require options. Typing/picture-sentence challenges can
    // be answered through acceptedAnswers and do not need multiple-choice buttons.
    if (mode === "multiple-choice" || mode === "drag-drop") return optionsAreValid;
    if (mode === "typing" || mode === "picture-sentence" || mode === "speaking") {
      return (Array.isArray(question.acceptedAnswers) && question.acceptedAnswers.length > 0) ||
        optionsAreValid;
    }
    return optionsAreValid;
  }
  window.PrepositionQuizManager = Object.freeze({
    supportedModes: SUPPORTED_MODES,
    normalizeAnswer,
    validateChoice,
    validateTypedAnswer,
    calculatePoints,
    worldForQuestion,
    getMode,
    validateQuestion
  });
})();
