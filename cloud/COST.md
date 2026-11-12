# Cost of the cloud runner

`node cloud/cost.mjs` prints these tables. It reads `cloud/cost-inputs.json`. It uses `episode()` and `price()` from `sandbox/cost.mjs`, so the local model and the cloud model use the same rules. `cloud/cost.mjs` adds three rules for this design:

1. Durable Object duration has a low bound and a high bound (see "Durable Object billing").
2. R2 has one GetObject for each container start and one PutObject for each run. It has one more PutObject at each container stop (the drain save).
3. A connected user with no container costs only storage. No alarm waits, and the object can leave memory.

## Rates

The rates were read on 2026-11-12. They are in `cost-inputs.json` under `rates`.

| Item | Rate | Included each month (Workers Paid) | Source |
|---|---|---|---|
| Container memory | $0.0000025 per GiB-s | 25 GiB-hours | https://developers.cloudflare.com/containers/pricing/ |
| Container CPU | $0.000020 per vCPU-s | 375 vCPU-minutes | same |
| Container disk | $0.00000007 per GB-s | 200 GB-hours | same |
| Durable Object duration | $12.50 per million GB-s | 400,000 GB-s | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Durable Object requests | $0.15 per million | 1 million | same |
| Durable Object SQLite storage | $0.20 per GB-month | 5 GB | same |
| R2 class A (PutObject) | $4.50 per million | 1 million | https://developers.cloudflare.com/r2/pricing/ |
| R2 class B (GetObject) | $0.36 per million | 10 million | same |
| R2 storage | $0.015 per GB-month | 10 GB | same |
| Worker requests | $0.30 per million | 10 million | https://developers.cloudflare.com/workers/platform/pricing/ |
| Workers Paid plan | $5 a month | | same |

Containers are billed for each 10 ms while the instance runs. Memory and disk are billed on the provisioned size. CPU is billed on use (READ, containers pricing page).

## Durable Object billing

- READ: Cloudflare bills a Durable Object "while the Durable Object is actively running". It does not bill an object that is "idle and eligible for hibernation". Source: https://developers.cloudflare.com/durable-objects/platform/pricing/
- GUESS: The docs do not say if a running container keeps its Durable Object active. So the model has two bounds.
  - The high bound bills the object for the whole life of its container. That is the rule of `sandbox/cost.mjs`.
  - The low bound bills the object only while it handles requests: the start, the run, the saves and the drain.
- GUESS: The docs do not say how an object that only waits for an alarm is billed. This design sets an alarm only while a container runs, or while a sign-in is open. A user with no container has no alarm.

The two bounds differ by 10 % at most. The container is most of the cost.

## Inputs

These numbers come from `cost-inputs.json`.

| Input | Value | Kind | Where it comes from |
|---|---|---|---|
| `cold_busy_s` | 8.6 s | measured | From the job to the end of the program on a new container. 1 real run, agentd, 1/2 vCPU, 4 GiB. |
| `warm_busy_s` | 4.6 s | measured | The same with a program that waits. 3 real runs: 4.45, 4.75 and 4.46 s. |
| `start_s` | 3 s | assumed | Cloudflare says that cold starts are often 1 to 3 s (https://developers.cloudflare.com/containers/faq/). agentd took 1.0 to 1.95 s from `docker run` to `/health` on a Mac. |
| `restore_s` | 0.2 s | part measured | The unpack took 9 ms. The R2 get is assumed at 0.1 s. |
| `save_s` | 0.6 s | part measured | The pack and the seal of the 118 KB archive took 0.57 s. The R2 put is assumed. |
| `archive_mb` | 0.118 | measured | The sealed archive of one signed-in Claude Code. |
| `do_requests_per_run` | 22 | counted | Counted in the design: the job, the progress and result callbacks, the MCP calls through the object, the alarms. |
| CPU of the program | 1.0 vCPU-s to start, 0.7 for each run, 0.05 for each second of wait | measured locally | `sandbox/cost-inputs.json` |

`node cloud/measure-after-deploy.mjs` measures the assumed numbers after a deploy. Its output says where each number goes.

## Results

The load is 20 runs for each user each month. The instance is `standard-1`: 1/2 vCPU, 4 GiB, 8 GB disk. "bursts of 4" means 4 comments 60 s apart. Each range is the low bound to the high bound.

### 1,000 users (20,000 runs a month)

| Policy | Arrivals | Billable s / run | Cost / run | Month | Month, after included usage |
|---|---|---|---|---|---|
| No linger | isolated | 12.4 | $0.00020 | $4.06 | $2.57 |
| 30 s linger | isolated | 41.8 | $0.00056 to $0.00061 | $11.29 to $12.19 | $9.78 |
| 90 s linger | isolated | 101.8 | $0.00126 to $0.00140 | $25.16 to $27.93 | $23.65 |
| 90 s linger | bursts of 4 | 69.4 | $0.00086 to $0.00096 | $17.23 to $19.18 | $15.98 |
| 10 min linger | isolated | 611.8 | $0.00715 to $0.00809 | $143.07 to $161.78 | $141.57 to $155.69 |
| Warm on intent + 90 s linger (the default) | isolated | 149.4 | $0.00182 to $0.00203 | $36.36 to $40.68 | $34.91 |
| Warm on intent + 90 s linger (the default) | bursts of 4 | 82.3 | $0.00101 to $0.00113 | $20.26 to $22.63 | $19.03 |

### 10,000 users (200,000 runs a month)

| Policy | Arrivals | Billable s / run | Cost / run | Month | Month, after included usage |
|---|---|---|---|---|---|
| No linger | isolated | 12.4 | $0.00020 | $40.60 | $32.77 |
| 30 s linger | isolated | 41.8 | $0.00056 to $0.00061 | $112.88 to $121.88 | $104.87 to $112.93 |
| 90 s linger | isolated | 101.8 | $0.00126 to $0.00140 | $251.60 to $279.35 | $243.59 to $270.40 |
| 90 s linger | bursts of 4 | 69.4 | $0.00086 to $0.00096 | $172.33 to $191.79 | $166.87 to $183.58 |
| 10 min linger | isolated | 611.8 | $0.00715 to $0.00809 | $1,430.72 to $1,617.84 | $1,422.71 to $1,608.89 |
| Warm on intent + 90 s linger (the default) | isolated | 149.4 | $0.00182 to $0.00203 | $363.55 to $406.83 | $356.16 to $397.85 |
| Warm on intent + 90 s linger (the default) | bursts of 4 | 82.3 | $0.00101 to $0.00113 | $202.63 to $226.29 | $197.33 to $218.06 |

Add $5 a month for the Workers Paid plan.

### Idle cost

A connected user with no run costs only storage. There is no container, no alarm and no duration.

| Users | R2 archives | Durable Object storage | Month, after included usage | Month, with no included usage |
|---|---|---|---|---|
| 1,000 | 0.12 GB | 2.0 MB | $0 | $0.0021 |
| 10,000 | 1.15 GB | 19.5 MB | $0 | $0.021 |

## Latency and cost

The warm policy buys time to the first tool call. Each row is a real run through agentd at 1/2 vCPU on a Mac.

| Case | First tool after the job | Reply stored after the POST | Extra billable s / run |
|---|---|---|---|
| Cold container (no linger) | 4.86 s | 9.6 s | 0 |
| Next run in the 90 s linger | 0.85 s | 4.09 s | about 90 |
| Warm on intent, 8 s of typing | 0.98 s | 3.69 s | about 137 |
| Warm on intent, 3 s of typing | 2.2 s | 5.0 s | about 137 |

The cold case does not include the Cloudflare start of 1 to 3 s. So a cold run in the cloud is likely 2 to 4 s slower than this row.

Warm on intent and the linger each cost about 90 to 140 billable seconds for an isolated run. That adds about $0.001 to $0.0015 to each run. It saves 3 to 5 s on the first visible reply. The default is warm on intent with a 90 s linger. To lower the cost, set `LINGER_MS` lower, or set `WARM_MS=0` to turn off warm on intent.

## What only a deploy can measure

`cloud/measure-after-deploy.mjs` measures these numbers.

- The Cloudflare start time of a container with this image, from `start()` to the first answer of agentd. The runner log has it as `ms_boot` in `ev: "container_started"`.
- The R2 get and put times from the location of the container.
- The latency between the Durable Object and its container. Cloudflare says that they "are not guaranteed to run in the same location" (https://developers.cloudflare.com/containers/concepts/architecture/).
- If a running container keeps its Durable Object billed. The billing page of the account shows it after one day of use. That picks the low or the high bound.
- The real CPU use of the program on Cloudflare hardware.
