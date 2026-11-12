# What the sandbox costs on Cloudflare

Date: 2026-11-12. Nothing here is deployed. The run numbers come from one Mac (Apple silicon, OrbStack, Docker 29.4.0), Claude Code 2.1.311 and the model `sonnet`. The prices come from the Cloudflare pages that "Rates" lists.

`node sandbox/cost.mjs` prints the table below from `sandbox/cost-inputs.json`. Change an input when a new measurement replaces it, and run the command again. `--instance=basic` prints the same table for another instance type. `--engine=codex` prints the table for the Codex image, with its own inputs and the `basic` instance type.

## The short answers

1. **A container that waits is billed while it waits.** Cloudflare bills memory and disk "based on the provisioned resources for the instance type" for "every 10ms that they are actively running". Charges stop only "after the container instance goes to sleep". So a 10-minute linger after a 5-second run bills about 609 seconds of a 4 GiB instance. CPU is the only part that is billed by use ("CPU usage is based on active usage only"), and CPU is the small part. The runner now lingers 90 seconds by default, not 10 minutes.
2. **A person with no ChatGPT sign-in gets no Codex container.** Each engine has its own image now. The runner checks for the sign-in volume of the engine before it starts anything. With no volume, the run ends as `not_signed_in` in 49 ms, with no container, and the viewer shows "ChatGPT: not connected". `POST /warm` warms Claude only, unless the call names `"engine": "codex"`, and it warms nothing for an engine that the person has not connected.
3. **The earlier "$15 to $25 a month" holds only for a short linger.** For 1,000 users with 20 runs each, on `standard-1`: $27 a month with a 90-second linger and runs that are each alone, and $19 when runs come in bursts of 4. With the old 10-minute linger it is $161 (alone) or $53 (bursts). Warm on intent adds about half again for runs that are alone ($40), because the container also waits while the person types. The Workers Paid plan fee of $5 comes on top in each case. The included usage of the plan takes off $1 to $6.

## Rates

Sources, read on 2026-11-12: https://developers.cloudflare.com/containers/pricing/, https://developers.cloudflare.com/durable-objects/platform/pricing/, https://developers.cloudflare.com/r2/pricing/, https://developers.cloudflare.com/workers/platform/pricing/

| Item | Rate | Included each month with Workers Paid |
|---|---|---|
| Container memory | $0.0000025 for each GiB-second of the instance type | 25 GiB-hours |
| Container CPU | $0.000020 for each vCPU-second of active use | 375 vCPU-minutes |
| Container disk | $0.00000007 for each GB-second of the instance type | 200 GB-hours |
| Durable Object duration | $12.50 for each million GB-seconds. An active object is billed for 128 MB. | 400,000 GB-seconds |
| Durable Object requests | $0.15 for each million | 1 million |
| R2 class A (PutObject) | $4.50 for each million | 1 million |
| R2 class B (GetObject) | $0.36 for each million | 10 million |
| Worker requests | $0.30 for each million | 10 million |
| Workers Paid plan | $5 a month minimum | |

| Instance type | vCPU | Memory | Disk | Price of one second that the instance runs (memory and disk) |
|---|---|---|---|---|
| lite | 1/16 | 256 MiB | 2 GB | $0.00000077 |
| basic | 1/4 | 1 GiB | 4 GB | $0.0000028 |
| standard-1 | 1/2 | 4 GiB | 8 GB | $0.0000106 |

## Which instance type

| Measure | Value | Source |
|---|---|---|
| Memory of a Claude container with one program that waits | 134 MB (110 MB anonymous memory, 14 MB file cache). Peak 146 MB in 60 s. | cgroup `memory.current`, `memory.peak` |
| Memory of a Claude container at its peak in a run | 175 to 392 MB, in 9 runs. The number includes the file cache of the 273 MB binary, and the old program and the new program at the same moment at the end of a run. | `peak_memory_mb` in the runner log |
| Memory of a Codex container, one `codex exec` with one tool call | 249 to 260 MB peak when the binary is not in the page cache (2 runs), 26 to 41 MB when it is (8 runs) | A stand-in model, `node sandbox/codex-standin.mjs`. No Codex run with the real model ran in a container. |
| Reply time with a CPU limit of 1/4 vCPU (`basic`) | 9.2 s. The program that waited was not ready after 10 s, and `init` came 4.0 s after the job. | 1 run, `SANDBOX_CPUS=0.25` |
| The same, with a program that waited 50 s | 10.6 s from the job (`init` 2.1 s, first token 6.3 s). The program start used 3.6 vCPU-s over about 15 s, and the run used 3.6 vCPU-s more. | 1 run, `SANDBOX_CPUS=0.25`, 2026-11-12 |
| A Codex stand-in run at 1/4 vCPU | 1.07 to 1.47 s, against 0.85 s at 2 vCPU | `STANDIN_CPUS=0.25 node sandbox/codex-standin.mjs` |
| Reply time with a CPU limit of 1/2 vCPU (`standard-1`) | 3.55 s. The same as with no limit (3.4 to 3.7 s). | 1 run, `SANDBOX_CPUS=0.5` |

- `lite` is too small. 256 MiB is less than the peak, and 1/16 vCPU is a quarter of `basic`.
- `basic` has enough memory for Claude. But a quarter of a vCPU makes the reply about 3 times slower, and no warm policy fixes it. The program start takes about 15 s, so a program started on intent is not ready when the person posts. A program that waited 50 s was ready, and the run still took 10.6 s, because Claude Code needs about 4 times the CPU between the model turns at this limit.
- **`standard-1` is the smallest type that keeps the speed of Claude.** It also meets the "4 GB+ RAM" that Claude Code states as its requirement.
- **`basic` is enough for Codex.** Codex is a native binary, it has no waiting program, and a stand-in run at 1/4 vCPU was only 0.2 to 0.6 s slower. Its model turns take 2 to 5 s, so the CPU limit is a small part of a run.

## The formula

One **episode** is the life of one container, from its start to its stop. The container bills its instance type for the whole episode.

```
life  = start + restore + wait_before + busy + max(save, linger)
cpu   = runs x cpu_run + programs x cpu_program_start + waiting x cpu_idle_per_s
price = life x (memory_gib x $0.0000025 + disk_gb x $0.00000007) + cpu x $0.000020
      + life x 0.125 GB x $0.0000125 + DO requests + R2 operations + Worker requests
```

- `busy` is `cold_busy` for a run that starts its own program, and `warm_busy` for a run that gets a program that waits. A burst of `n` runs that one container serves has `busy = (n - 1) x gap + warm_busy`.
- `wait_before` is the typing time for warm on intent, and 0 otherwise.
- `programs` is 1, plus one program that waits after each run when the linger is more than 0.
- `waiting` is the time that a program waits with no job: `life - start - restore - busy`, when a program waits.
- In a burst, one container serves the next run only when `linger >= gap - warm_busy`. Else each run is its own episode.
- Warm on intent adds `unused_warms_per_episode` episodes of `start + restore + warm_s` with no run: a person opens the comment box and posts nothing.
- The month is `20,000 x` the price of one run. "After included usage" subtracts the included amounts from the month totals first.

## Inputs

| Input | Value | Measured or assumed |
|---|---|---|
| `cold_busy_s`: job to the end of the program, with a new program | 6.7 s | Measured: 6.66 s (1 run) |
| `warm_busy_s`: the same with a program that waits | 5.1 s | Measured: 4.8 to 7.1 s, median 5.1 s (6 runs) |
| `cpu_program_start_s` | 1.0 s | Measured: 0.75 s at 3 s after the start, 1.24 s at 20 s (2 containers) |
| `cpu_run_s` | 0.7 s | Measured: 0.5 to 0.8 s from the cumulative `cpu.stat` between runs |
| `cpu_idle_per_s`: a program that waits | 0.05 vCPU-s each second | Measured: 0.017 with no CPU limit, about 0.05 with a 1/2 vCPU limit. The model takes the higher value. |
| `warm_s`: how long a container from `POST /warm` waits with no job | 60 s | The default of `SANDBOX_WARM_MS` |
| `start_s`: the cold start of a container on Cloudflare | 2 s | Assumed. Cloudflare: "often in the 1-3 second range". Local: 0.26 to 0.36 s. |
| `restore_s`, `save_s`: the sign-in folder from and to R2 | 0.5 s each | Assumed. The folder is 512 KB. Not measured. |
| `typing_s`: from the open comment box to the post | 20 s | Assumed |
| `unused_warms_per_episode` | 0.5 | Assumed: one comment box in three closes with no post |
| Durable Object requests for each run | 25 | Assumed: the job, about 10 connector calls through the outbound handler, about 8 progress events, the result |
| Worker requests for each run | 20 | Assumed |

The measured life of 4 containers checks the formula. The runner logs `container_stopped` with `s_billable`, `cpu_s`, `runs` and `peak_memory_mb`:

| Container | Runs | Billable s | CPU s | Peak MB | The formula with the local start (0.3 s), no restore, and the real wait |
|---|---|---|---|---|---|
| Started by a run, 4 runs 7 to 10 s apart, 90 s linger | 4 | 150.7 | 10.0 | 339 | 0.3 + 6.7 + 3 gaps (53 s in all) + 90 = 150 s |
| Started by `/warm`, 2 runs, 90 s linger | 2 | 117.2 | 7.2 | 366 | |
| Started by `/warm`, 8 s wait, 1 run, 90 s linger (1/2 vCPU) | 1 | 104.8 | 6.2 | 279 | 0.36 + 8 + 5.1 + 90 = 103.5 s |
| Started by `/warm`, no run | 0 | 60.7 | 1.9 | 146 | 0.3 + 60 = 60.3 s |

## The table

`standard-1`, 1,000 users x 20 runs = 20,000 runs a month. A burst is 4 runs 60 s apart.

| Policy | Arrivals | Billable s / run | CPU s / run | Cost / run | Month, no included usage | Month, after included usage |
|---|---|---|---|---|---|---|
| No linger | isolated | 9.7 | 1.7 | $0.00017 | $3.32 | $2.00 |
| No linger | bursts of 4 | 9.7 | 1.7 | $0.00017 | $3.32 | $2.00 |
| 30 s linger | isolated | 39.2 | 4.2 | $0.00057 | $11.48 | $9.23 |
| 30 s linger | bursts of 4 | 39.2 | 4.2 | $0.00057 | $11.48 | $9.23 |
| 90 s linger | isolated | 99.2 | 7.2 | $0.00136 | $27.22 | $23.11 |
| 90 s linger | bursts of 4 | 69.4 | 5.1 | $0.00096 | $19.16 | $15.98 |
| 10 min linger | isolated | 609.2 | 32.7 | $0.00805 | $161.07 | $155.06 |
| 10 min linger | bursts of 4 | 196.9 | 11.5 | $0.00263 | $52.62 | $46.61 |
| Warm on intent + 90 s linger | isolated | 148.8 | 10.2 | $0.00202 | $40.47 | $34.79 |
| Warm on intent + 90 s linger | bursts of 4 | 82.2 | 5.9 | $0.00113 | $22.57 | $18.99 |

Add $5 a month for the Workers Paid plan in each row. Memory is 72 to 76 percent of each month with a linger of 90 s or more, and 58 percent with no linger. The Durable Object is 11 to 12 percent, and CPU is 8 to 20 percent. R2 and Worker requests are $0.22 a month together.

### The other engine and the other instance type

`node sandbox/cost.mjs --engine=claude --instance=basic` uses the numbers that were measured at 1/4 vCPU (`engine_at.basic` in the inputs: a cold run of 16 s, a warm run of 12.4 s, and 3.6 vCPU-s for the program start and for each run). `node sandbox/cost.mjs --engine=codex` uses the `codex` block: a run of 12 s, 0.25 vCPU-s, and no waiting program.

| Engine and instance type | 90 s linger, runs alone | 90 s linger, bursts of 4 | Reply time |
|---|---|---|---|
| Claude, `standard-1` | $27.22 | $19.16 | 3.5 s with a waiting program |
| Claude, `basic` | $15.84 | $10.86 | 10.6 s with a waiting program, about 3 times slower |
| Codex, `basic` | $9.47 | $6.56 | About 10 s, as with no limit |
| Codex, `standard-1` | $25.73 | $17.63 | About 10 s |

Each number is for one month, with no included usage. For Codex, warm on intent buys nothing, because no program waits. Its rows in the output of `cost.mjs` only show the price of a container that starts early.

## What the policy buys

| Policy | First tool call after the comment | Reply stored after the comment |
|---|---|---|
| No linger: each run starts a container and a program | 2.65 s locally, plus the cloud start and the restore (2.5 s assumed) | 5.3 s locally, about 8 s in the cloud |
| A linger, the next run in the linger | 0.8 to 1.1 s | 3.4 to 4.4 s for an edit |
| Warm on intent: the container and the program start while the person types | 0.9 s | 3.65 s, for the first run of the person |

- With no linger, each run costs $0.00017 and waits for a cold start.
- A 30-second linger costs 3.5 times more, and it helps only a person who writes a second comment within 30 s of a reply.
- A 90-second linger keeps a person who works through several comments on the fast path. Each run that is alone pays for 90 s that nobody uses.
- Warm on intent makes the first run fast, which no linger can do. It costs the typing time and the comment boxes that close with no post.

## Recommendation

- Use warm on intent with a short linger. On Cloudflare, a container class with `sleepAfter` of 60 to 90 s does the linger, and the viewer call `POST /api/assistants/warm` starts the container.
- Set `standard-1` for the Claude image. Claude on `basic` costs about 40 percent less, but each reply is about 3 times slower.
- Set `basic` for the Codex image. It costs about a third of `standard-1` ($9.47 against $25.73 a month for a 90 s linger with runs alone), at the same speed. Do not send `/warm` for Codex.
- Expect $23 to $40 a month for 20,000 Claude runs with this policy, plus $5 for the plan. The arrival pattern decides where in that range. A 30 s linger with no warm on intent costs $11.48, and it loses the fast path for most next comments and for every first comment.
- Do not keep a 10-minute linger. It costs 2.7 to 5.9 times more than a 90 s linger, and it is faster only for a comment that comes 90 s to 10 minutes after the last one.

## Not measured in the cloud

- The cold start of the 135 MB compressed image on Cloudflare, and the time of a pull to a new location.
- The restore and the save of the sign-in folder (R2 or a snapshot). The model takes 0.5 s each.
- Whether a Durable Object is billed while its container waits. The model bills the object for the whole life of the container, so it is an upper limit for that part.
- The number of Durable Object and Worker requests in a run. The model takes 25 and 20.
- CPU and memory with a real model in a Codex container. Codex has no program that waits, so its container idles at about 1 MB and almost no CPU. A Codex run takes 8 to 15 s (host mode), so its `busy` is 2 to 3 times that of Claude. The CPU of a Codex run at 1/4 vCPU comes from the stand-in model only.
- How long people type and how often they close a comment box with no post.
