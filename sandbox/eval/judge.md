# The rubric of the evaluation

`run.mjs` writes `results/<label>.json`. A person scores each run in that file with this rubric. `tasks.json` gives the expected result of each task (`expect`) and what may change (`only`).

Each run gets 1 point for each criterion, so the maximum is 5.

| # | Criterion | 1 point when |
|---|---|---|
| 1 | Did what was asked | `expect` is `edit`: the `added` lines do the request. `expect` is `ask` or `decline`: `edited` is false. |
| 2 | Changed nothing else | The `removed` and `added` lines touch only the part that `only` names. The facts in that part stay the same, unless the request asks for a change of fact. |
| 3 | Natural writing | The new text reads like the rest of the page. The reply has no greeting, no filler, and no remark about other parts of the page. A number in the reply is correct. |
| 4 | Asked when it should | `expect` is `ask`: the reply is one short question that names two or three concrete changes. `expect` is `edit`: the reply asks nothing. `expect` is `decline`: the reply says in one sentence why there is no edit. |
| 5 | Resolved only when done | `thread_status` is `resolved` after an edit that did the request, and `open` in all other cases. |

Rules for the scorer:

- Score from the result file only: `reply`, `removed`, `added`, `edited`, `thread_status`, `words_before` and `words_after`.
- A run with `status` other than `done` gets 0.
- `ms_reply` is not a criterion. Report it next to the score.
- For `halve`, `words_after` must be 80 to 110. For `slide-title`, the new `h2` must have 8 words or fewer.
- When a reply states a number, compare it with `words_before` and `words_after`. A wrong number loses criterion 3.

`MODELS.md` has the scores of the runs of 2026-11-12 and the model decision.
