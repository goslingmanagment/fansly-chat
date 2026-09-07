# Writing research for 2.0

Research snapshot: 2026-09-06. Read-only investigation of Hub source at `582ef1cf8a2de52eba6639ef775ddbe3e15ba74c` and extension at `1a74b8114235f95818425f49699178e5f451e29e`. No prompt edits, production changes, or generation experiment performed. Examples below are invented, non-explicit evaluation material, not real fan messages.

## Finding

The current prompts already try hard to suppress AI-sounding writing. Adding another banned-word list is unlikely to address the main observed issue: several instructions still prescribe the very conversational formulas the owner dislikes. Whether these instructions cause the live outputs remains a testable hypothesis, not an established production RCA.

Prompt ownership stays in Hub. The extension sends transcript/context plus feature, tone and split selections through `src/background/kernel-feature-gateway.ts:415`. Hub `apps/runtime/src/modules/ai/features/index.ts:116` resolves the persona from the database, including the default persona; `:575` calls the builder. Hub `apps/runtime/src/modules/ai/prompts/builder.ts:752` assembles the shared preamble and stored persona as system blocks, with feature templates/context/tasks as user blocks. Compare reuses fast-reply per card. Editing extension copy cannot repair model writing.

All Hub paths below are relative to `/Users/dmitriy/code/goose/hub/`. Source templates are current-checkout evidence only. The active database persona, selected provider/model and deployed template revision require the actual assembled prompt/debug echo. In particular, `personalities.ts` is NOT proof of the active persona.

## Concrete prompt conflicts

| Location | Observed source behavior | Hypothesis to test |
|---|---|---|
| `apps/runtime/src/modules/ai/prompts/templates/fast-reply.md:11,16-70,86` | Default question/response invitation; GOOD examples mostly emotion-first reaction plus question; final task asks for a burst of reaction. One example supplies only biking/lifting/hiking, but its GOOD replies introduce weight loss and a zip line. | Teaches repetitive exaggerated reactions and unsupported callbacks despite explicit anti-parroting/anti-validation rules. The under-20-word instruction can also suppress an actual answer. |
| `.../templates/improve-draft.md:19,27-30,35-47` | Preserve intent, but also act as a subtle psychologist and optimize persuasion; then ban therapist language and cut middle elaboration. | Fix changes a plain statement into emotional positioning; blanket compression can delete necessary meaning. |
| `.../templates/hi-greeting.md:20-23,37` | Every variant must contain name, hook and invitation, yet later not every variant needs a clever hook. | Formulaic manufactured intimacy and unnecessary username riffs, including when a real fan question needs an answer. |
| `.../templates/ping.md:19-33,45` and `.../builder.ts:236-238` | Ask for concrete personal callbacks; permit sharing from the model's life; ban thinking-of-you wording while segment A explicitly suggests it. | Conflicting instructions produce stale callbacks, fake present-day anecdotes, or forbidden filler. |
| `.../templates/coach-chat.md:12` and `.../builder.ts:242-254` | Normal coach asks for a price and objection as examples of specificity; situation preset always requests warm and more seductive variants. | Unavailable prices or an ordinary conversation can be pushed toward an invented sales move. Coach advice itself should retain evidence/analysis; only draft fences need fan texting style. |
| `.../templates/voice-script.md:5-10` | Preserve meaning, yet compress to one spoken line/one breath. No examples of restraint. | Multi-part draft may lose conditions; unnecessary emotional tags may make ordinary wording theatrical. |
| `.../personalities.ts:54-83` | Bundled seed says react before answering, offers `valid`, and gives present-moment physical anecdotes as seasoning. | If present in the ACTIVE stored persona, higher-priority instructions can reintroduce empty validation or fictional current activities after template tuning. Verify before proposing a persona edit. |
| `.../builder.ts:228-233` | Explicit Split requires 2-3 parts, including a follow-up even for a brief reply. | Some filler is an intended Split contract (#156), not a model defect. Evaluate default and Split separately. |

Existing protections worth preserving: paid-media state distinctions; no absolute claims about incomplete history; stale-dossier warning and live-transcript precedence; draft meaning preservation; output delimiters; human-only send. Do not globally flatten Coach/Review analysis into short fan replies.

## Primary evidence and its limits

Anthropic's current [prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) recommends clear positive instructions, relevant diverse examples, and checking that examples do not teach unintended patterns. It suggests 3-5 structured examples. This supports trying a small varied example set; it does not prove any particular writing intervention works for our actual persona or selected model.

The 2023 Anthropic study [Towards Understanding Sycophancy in Language Models](https://www.anthropic.com/research/towards-understanding-sycophancy-in-language-models) found that human/preference-model judgments can favor agreement over truth. It supports scoring factual grounding separately from charm. It does not show that casual empathy is inherently sycophantic, or identify the cause of this product's style.

OpenAI's [evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) recommend task-specific comparisons/pass-fail judgments, human calibration, representative edge cases, and attention to judge position and verbosity biases. Use this methodology without assuming a generic judge preference equals the owner's texting preference.

## Minimal intervention proposal

Start with ONE feature, fast-reply in default split mode, using the same deployed model/settings and exact persona/context for baseline and candidate. Do not mix a provider change with the first prompt experiment.

1. Replace fast-reply's mandatory reaction/question framing and its GOOD/BAD block. Proposed instruction: “Answer what needs answering or respond to one relevant detail. Use the amount of text this turn needs. A direct answer, a small joke, or a brief acknowledgment can stand alone. Ask a question when it follows from the conversation. Match the persona's usual voice without adding slang, emotion or mistakes just to signal personality. Keep every factual claim grounded in the supplied context; examples teach style, never biography or shared history.” Preserve exact output/paid-media rules and Split plumbing.
2. Use four or five GOOD-only input/output examples with adequate context. Vary their conversational actions, emoji, length, and question presence. Do not reuse the same reaction opener. Keep negative counterexamples in the evaluator rather than crowding the generation prompt. This is an ablation candidate, not a claim that negative examples never work.
3. Once measured, adjust Fix's psychologist/persuasiveness directives to “Preserve what the chatter is trying to say; improve wording without adding a new emotional or sales move.” Add a no-change-needed example. Keep prices/promises/conditions intact.
4. Fix Hello's internal hook contradiction and Ping's segment/template contradiction. Make callback specificity proportional to evidence. Present-day activities, purchases, meetings and promises need explicit grounding, not just a persona hobby. Do not fabricate familiarity when the history is thin.
5. For Coach apply the concise fan-writing behavior to draft fences only; offer prices only when established, otherwise describe the missing input. For Voice test faithfulness before brevity and show one ordinary line with zero audio tags.

Files for a later Hub patch: the affected `.md` templates and, for segment/shared/system instructions, `builder.ts`. If an ACTIVE persona conflict is confirmed, propose its exact database content revision separately through the owner persona lifecycle; changing a seed file alone does not change the active record. Update `prompt-manifest.json`, append the Hub decision, and run the relevant builder/coach/template-sync/output tests plus required `pnpm check`. No contract/SDK/UI rewrite is needed for these prompt experiments. A shared fan-writing block is a later deduplication option, not necessary for the first ablation.

## Invented example seeds

These illustrate conversational choices, not universal Lora wording. Owner review should establish the intended personality before they enter a prompt.

| Input context | Candidate example | What it teaches |
|---|---|---|
| Fan: “finally home” | “shoes off immediately?” | One relevant detail, no motivational interpretation. |
| Fan: “got the promotion!” | “what's the new job?” | Interest without an invented story about deserving it. |
| Fan: “ok, talk tomorrow” | “night :)” | A natural ending, no engagement hook. |
| Established model preference: coffee. Fan: “tea or coffee?” | “coffee, easy” | Answer first, no prefabricated reaction. |
| Fix draft: “can we talk tomorrow instead?” | “can we talk tomorrow instead?” | A good draft can remain unchanged. |

## Offline evaluation set and gate

Freeze 12 synthetic cases; make separate paraphrased held-out cases before tuning. Each case specifies input context, chosen persona facts, mode and required invariants. Generate baseline/candidate under identical settings, ideally three samples per case to reveal variability. Record exact prompt revision, persona definition ID, provider/model, tuning, and outputs. No live fan sends or paid TTS needed.

| Case | Fixture | Required result |
|---|---|---|
| 1 | “I bike, lift and hike.” No weight-loss/zip-line context. | No invented objective or callback; no achievement lecture. |
| 2 | “People are sick so I'm four days behind.” | No blame assignment, generic validation paragraph, or unsolicited coping advice. Brief sympathy remains allowed. |
| 3 | “I got promoted.” | No claim they deserved it/worked hard unless established; no inflated significance. |
| 4 | “Talk tomorrow.” | Closure without a forced question or sales pivot. |
| 5 | Direct preference question, answer given in persona. | Actually answer; no parroting. |
| 6 | “What are you doing right now?” Persona mentions gym/cat, no live activity. | No fabricated current gym, meal, cat event or location; natural truthful uncertainty/deflection as owner permits. |
| 7 | Fix a short Russian scheduling draft into English; then an already-good English draft. | Preserve time/intent; no expansion, false promise or added emotional pressure. |
| 8 | Fix a longer draft containing a price plus deadline and exception. | Preserve all conditions; brevity cannot win by dropping meaning. |
| 9 | Hello with empty history and random numeric username; repeat with latest fan question. | No invented name/familiarity; three valid variants; answer question when present. |
| 10 | Ping after 180 days, old trip plan, no completion evidence; also empty-history version. | No claim trip happened or remembered offscreen interaction; no guilt about silence. |
| 11 | Coach situation: ordinary work topic, no priced offer. | Ground advice; no invented price or compulsory sales strategy; valid draft fences. |
| 12 | Voice: a plain agreed scheduling line with emoji; additional multi-condition draft. | Spoken faithful wording, zero tags acceptable; no theatrical filler or lost conditions. |

Run contract regression fixtures alongside this set: purchased/not-purchased/unknown media, `[VARIANT]` cardinality, Split 2-3 parts, Fix/Voice no `[NEXT]`, Coach fences, prompt-injection text, live-transcript versus stale dossier. These must not regress during style tuning.

Rubric: first hard-fail invented facts/promises/prices, meaning loss, missed direct answer, invalid output protocol. Then blind A/B judge separately on relevance, natural cadence, unnecessary validation/analysis, redundant paraphrase, and persona consistency. A short quote identifying the defect is better than a vague “sounds AI” score. Randomize order, allow ties, and have the owner judge a small calibration sample. Report win/tie/loss by feature, not one blended score; inspect recurring openers/question frequency across samples as diagnostics, not universal bans. No automatic lexical rejection or destructive output rewriting.

Suggested trial gate, to agree before scoring: zero hard failures on the fixed suite, candidate preferred on at least two-thirds of non-tied cases, no new repeated stock opener, and owner acceptance of the disputed examples. This tiny trial supports the next experiment, not a claim of proven general quality or conversion uplift.

Owner choices before implementation: acceptable warmth versus strict no-validation; permission to make persona-grounded fictional present-moment statements (recommended default: no); ordinary Hello fallback; whether the existing always-two-draft Coach situation escalation remains desired. Split is an existing explicit product decision and should not be silently weakened to improve a style metric.
