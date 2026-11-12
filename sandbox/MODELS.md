# Which model answers a comment

This file records the model evaluation of 2026-11-12 and the decision that came from it. `eval/` has the harness, the documents, the tasks and the raw results.

## The decision

| Engine | Default | Options in `/status` | Why |
|---|---|---|---|
| Claude | `sonnet` | `sonnet` ("Faster"), `opus` ("More careful") | Sonnet got the same results as Opus on each task, in half the time (5.1 s against 10.9 s median to the reply). |
| Codex | `gpt-6.1-sol` | `gpt-6.1-sol` ("Standard"), `gpt-6-luna` ("Faster"), `gpt-6-astra` ("More careful") | All three were correct in the 6 runs. `gpt-6.1-sol` is the default of the ChatGPT account, so the runner now names it, and the log shows the model of each run. |

Haiku is not an option. It was correct in 3 runs, but it was slower than Sonnet (6.8 s against 5.1 s median).

The order of choice for one run:

1. The `model` field of the job.
2. `SANDBOX_CLAUDE_MODEL` or `SANDBOX_CODEX_MODEL` of the runner. An empty value gives the default of the account.
3. `default_model` of `MODELS` in `run-comment.mjs`.

`MODELS` in `run-comment.mjs` holds the options, with a label and a note for each one. `POST /status` returns them for each assistant, with `default_model`. A unit test checks that each default is one of the options, and that `jobError` takes each option.

## The evaluation set

`eval/tasks.json` has 11 tasks on 4 documents. Each task is one comment on a new copy of one document.

| Task | Comment | Expected |
|---|---|---|
| `tighten` | tighten the second paragraph | edit |
| `typo` | fix the typo in the heading | edit |
| `tone` | reword the introduction so it sounds warm and casual, not corporate | edit |
| `halve` | cut the 'Your first week' section to about half its length | edit |
| `caveat` | add a short caveat to the savings claim | edit |
| `table` | change the Plus price to $24 a month and add a Team row | edit |
| `slide-title` | the title of this slide wraps onto two lines. Shorten it (on the slide `bets`) | edit |
| `better` | make it better | ask |
| `fix-this` | fix this | ask |
| `thoughts` | thoughts? | ask |
| `outside` | copy this plans table to our onboarding page too, and email the sales team | decline |

```bash
node sandbox/eval/run.mjs --host http://localhost:8804 --label sonnet-after
node sandbox/eval/run.mjs --host http://localhost:8804 --label codex-sol --agent chatgpt --tasks typo,better
```

The runner decides the model, so start it with `SANDBOX_CLAUDE_MODEL=opus` (or another model) for each set. `eval/judge.md` is the rubric: 5 criteria, 1 point each.

## The results

43 Claude runs in docker mode, and 6 Codex runs in host mode through the egress proxy.

| Set | Runs | Clear requests: edit and resolve | Unclear requests: question, thread open | Outside request: declined | Median to the reply | Score |
|---|---|---|---|---|---|---|
| Sonnet, old prompt | 14 | 7/7 | 5/6 | 1/1 | 5.2 s | 63/70 |
| Sonnet, new prompt | 14 | 7/7 | 6/6 | 1/1 | 5.1 s | 69/70 |
| Opus, new prompt | 11 | 7/7 | 3/3 | 1/1 | 10.9 s | 54/55 |
| Haiku, new prompt (3 tasks) | 3 | 2/2 | 1/1 | not run | 6.8 s | 15/15 |
| Codex `gpt-6.1-sol` | 2 | 1/1 | 1/1 | not run | 10.6 s | 10/10 |
| Codex `gpt-6-luna` | 2 | 1/1 | 1/1 | not run | 8.4 s | 10/10 |
| Codex `gpt-6-astra` | 2 | 1/1 | 1/1 | not run | 12.5 s | 10/10 |

The smoke run (1 Sonnet run of `typo`) is not in the table. It was correct.

Points that the runs lost:

| Set | Task | Score | Cause |
|---|---|---|---|
| Sonnet, old prompt | `better` | 1 | It edited the page and resolved the thread. The request did not say what to change. |
| Sonnet, old prompt | `halve` | 4 | The reply says "from about 150 words to about 75". The real count is 171 to 96. |
| Sonnet, old prompt | `thoughts` | 4 | A review of five sentences, not one short question. |
| Sonnet, old prompt | `slide-title` | 4 | The reply has a remark about another slide. |
| Sonnet, new prompt | `outside` | 4 | The reply has a second clause with advice that nobody asked for. |
| Opus, new prompt | `tone` | 4 | The new text adds "first few weeks", a small change of fact. |

## The fault: an unclear request got an edit

With the old prompt, "make it better" got an edit and a resolved thread in 1 of 2 runs. The prompt told the assistant to edit when it could, and the assistant chose the changes for the owner.

The fix has three parts:

- The prompt (`prompt` in `run-comment.mjs`) now defines a clear request and an unclear request. It names "make it better", "improve this", "fix this" with no quote, "thoughts?" and "any feedback?" as unclear. It says "do not choose for the owner". An unclear request gets `reply_to_comment` with `resolve: false` and one short question that names two or three changes.
- The prompt says that a quote or a slide of the thread gives the meaning of "this".
- The connector (`host/src/mcp.ts`) never resolves a thread when the reply ends with a question mark, in `edit_page` and in `reply_to_comment`. So a question keeps the thread open even when a model sets `resolve: true`. Two unit tests in `host/src/mcp.test.ts` check this.

The counts for the unclear tasks:

| | Edit and resolve | Question, thread open |
|---|---|---|
| Old prompt (Sonnet, 6 runs) | 1 | 5 |
| New prompt (Sonnet, 6 runs) | 0 | 6 |
| New prompt (Opus, 3 runs) | 0 | 3 |

The clear tasks did not get worse: 7/7 before and 7/7 after, and the median time changed from 5.45 s to 5.58 s.

## Examples

"make it better" on the heat pump page, Sonnet.

- Old prompt. An edit and a resolved thread: "Fixed the typo in the heading ("pmups") and split the long run-on sentence in the winter paragraph into three shorter ones. Tell me if you wanted something broader."
- New prompt. No edit, and the thread stays open: "Which change do you want: fix the typo in the heading ("pmups"), split the long winter paragraph into shorter sentences, or add more detail to the running-cost section?"

"thoughts?" on the onboarding page, Sonnet.

- Old prompt: "The page is clear and friendly, with two weak spots. The intro is stiff ("personnel", "commencement date") and doesn't match the warm tone below it. The "Your first week" paragraph is a long block that would scan better as a day-by-day list. I made no edit since you asked for thoughts. Tell me if you want either change."
- New prompt: "Which change would you like: rewrite the stiff intro paragraph in plainer words, split the long "Your first week" paragraph into a day-by-day list, or something else?"

The slide title, Sonnet.

- Old prompt: "Shortened the long heading on the "bets" slide to "Three bets customers asked for most" so it fits on one line. The "Q3 roadmap" title slide was already short, so I left it alone."
- New prompt: "Shortened the slide title to "Three bets customers asked for most" so it fits on one line."

Sonnet and Opus on the same tasks, new prompt.

| Task | Sonnet | Opus |
|---|---|---|
| `tighten` | 65 words to 41, 5.6 s | 65 words to 42, 10.7 s |
| `halve` | 171 words to 92, 7.3 s. "Cut the 'Your first week' section from about 190 words to about 90." | 171 words to 91, 16.6 s. "I cut the 'Your first week' section from about 190 words to about 95." |
| `slide-title` | 20 words to 6, 7.4 s | 20 words to 7, 9.9 s |
| `outside` | Declined, with advice that nobody asked for | Declined in one sentence |

Both models give the same quality of edit. Opus writes slightly better replies, but it takes twice the time.

## What the evaluation does not show

- The set is small: 11 tasks, 1 run of most tasks for each set. A difference of one run is not a trend.
- Codex had 2 tasks only, because each Codex run uses the ChatGPT plan of the person.
- A person scored the runs. The scorer also wrote the prompt.
- The times are for docker mode on one machine with a warm program. `PERF.md` has the times in other conditions.
