// Taxonomy version 1 (docs/api.md, "Values"). Codes are stable: append, never rename.

export const TAXONOMY_VERSION = 1;

export const SOURCE = [
  { value: "me", label: "Me", key: "1" },
  { value: "live", label: "Live person", key: "2" },
  { value: "device", label: "Device", key: "3" },
  { value: "call", label: "Call", key: "4" },
  { value: "none", label: "No voice", key: "5" },
  { value: "cant_tell", label: "Can't tell", key: "6" },
  { value: "several", label: "Several", key: "7" },
];

// "Several" lets the owner pick up to two of these.
export const SEVERAL = ["me", "live", "device", "call"];

export const DEVICE_TYPE = [
  { value: "tv", label: "TV" },
  { value: "phone", label: "Phone" },
  { value: "laptop", label: "Laptop" },
  { value: "car", label: "Car" },
  { value: "assistant", label: "Assistant" },
  { value: "other", label: "Other" },
];

export const CONTENT = [
  { value: "speech", label: "Speech" },
  { value: "singing", label: "Singing" },
  { value: "vocal", label: "Vocal sounds" },
  { value: "music", label: "Music" },
  { value: "other_sound", label: "Other sound" },
  { value: "silence", label: "Silence" },
];

export const TRANSCRIPT = [
  { value: "right", label: "Right", key: "1" },
  { value: "small_errors", label: "Small errors", key: "2" },
  { value: "wrong_words", label: "Wrong words", key: "3" },
  { value: "made_up", label: "Made up", key: "4" },
  { value: "cant_hear", label: "Can't hear", key: "5" },
];

export const OVERLAP = [
  { value: "one", label: "One voice", key: "1" },
  { value: "two", label: "Two at once", key: "2" },
  { value: "three_plus", label: "Three or more", key: "3" },
  { value: "cant_tell", label: "Can't tell", key: "4" },
];

export const FLAGS = [
  { value: "quiet", label: "Quiet or far" },
  { value: "noisy", label: "Noisy background" },
  { value: "overlap", label: "Overlapping voices" },
  { value: "muffled", label: "Muffled" },
  { value: "clipped", label: "Clipped" },
  { value: "two_speakers", label: "Two speakers in one line" },
];

export const LANGUAGE = [
  { value: "uk", label: "uk" },
  { value: "ru", label: "ru" },
  { value: "en", label: "en" },
  { value: "mixed", label: "mixed" },
  { value: "other", label: "other" },
];

/** The big buttons for the axis an item asks. */
export const ASK = {
  source: { field: "source", title: "Where does the voice come from?", options: SOURCE },
  transcript: { field: "transcript", title: "Is the text right?", options: TRANSCRIPT },
  overlap: { field: "overlap", title: "How many voices talk at once?", options: OVERLAP },
};

export const TASK_NAMES = {
  device: "Device audio",
  voice: "My voice",
  quiet: "Quiet audio",
  transcript: "Transcript",
  overlap: "Several voices",
};

/** Answers that need one more step before they can be sent. */
export function needsMore(field, value) {
  return (field === "source" && value === "several") || (field === "transcript" && value === "wrong_words");
}
