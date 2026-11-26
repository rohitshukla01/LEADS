# LEADS source code

LEADS is a Next.js web app. This folder holds its full source code, and this guide shows how to build your own LEADS from it.
The quickest way to try LEADS is the [Docker version](../DOCKER.md).

## How LEADS answers a question

| Step | What happens | Code |
|---|---|---|
| 1. Plan | The question and the user's profile set the query mode, evidence sources, reservoir and depth, variables and dates, and forecast horizon. No language model is used. | [`router.ts`](lib/leads/router.ts) |
| 2. Gather evidence | Sensor readings (VERA), the FLARE ensemble forecast, its skill record and literature passages are collected into one numbered list. | [`sensor-public.ts`](lib/leads/sensor-public.ts), [`forecast.ts`](lib/leads/forecast.ts), [`literature.ts`](lib/leads/literature.ts), [`skill/`](lib/skill/) |
| 3. Test the rule | When the user's decision has an operating rule, code tests the latest reading against it before the model writes. | [`constraint-eval.ts`](lib/leads/constraint-eval.ts) |
| 4. Write | The writer model drafts the answer from the evidence, citing each source it uses. | [`generator.ts`](lib/leads/generator.ts) |
| 5. Check | The checker model tests each claim against the evidence. A failed check leads to up to two more attempts. | [`verification.ts`](lib/leads/verification.ts) |
| 6. Show | The answer is shown with its citations, and with a chart and skill card for forecasts. It can be downloaded as a decision report. | [`components/`](components/) |

[`lib/leads/orchestrator.ts`](lib/leads/orchestrator.ts) runs the steps in order.

## What you need

| Requirement | Used for | Settings in `.env.local` |
|---|---|---|
| [Node.js](https://nodejs.org/) 20.9 or later | Running the app | |
| OpenAI API key | Writer, claim checker and literature embeddings | `OPENAI_API_KEY` |
| Cohere API key | Reranking literature passages | `COHERE_API_KEY` |
| [Qdrant](https://qdrant.tech/) database, local or cloud | Searching the literature passages | `QDRANT_URL` (`QDRANT_API_KEY` for cloud) |
| [Supabase](https://supabase.com/) project | Sign-in, the paper list and saved conversations | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Your copies of the 63 papers ([list](data/papers.csv)) | The literature library | |
| [Docling](https://github.com/docling-project/docling) (optional) | Reading the PDFs with their structure; without it, a built-in reader is used | |

LEADS downloads the near-real-time sensor data from VERA and the water quality forecasts from FLARE; no API key is needed.

## Set up and run

Run the commands from this folder (`tool/`).

### 1. Settings

Copy the template and fill in the required settings. Every setting is explained in
[.env.example](.env.example). Never commit `.env.local`.

```bash
cp .env.example .env.local
```

### 2. Install and check

```bash
npm ci          # installs the exact package versions
npm run check   # type checks and the tool's own tests
```

### 3. Databases

Run the two SQL files in [supabase/migrations/](supabase/migrations/) once in your Supabase
project, then create the literature collection in Qdrant:

```bash
npm run init-qdrant
```

### 4. Literature library

Put your copies of the papers in a folder named `LLM_Papers` next to `tool/`, then index
them. This uses your OpenAI key for the embeddings and passage summaries.

```bash
npm run ingest-corpus
```

### 5. Start

```bash
npm run dev -- -H 127.0.0.1
```

LEADS then runs at http://localhost:3000, on your computer only.

## Models

| Role | Default | Setting |
|---|---|---|
| Writer | GPT-4.1 | `OPENAI_MODEL` |
| Claim checker | GPT-4.1 mini | `LEADS_AUX_MODEL` |
| Literature embeddings | OpenAI `text-embedding-3-small` | |
| Literature reranking | Cohere `rerank-english-v3.0` | |

The writer and checker can run on any OpenAI-compatible provider (see [.env.example](.env.example)). The settings of
the paper's benchmark runs are in [reproduce_paper/benchmark/README.md](../reproduce_paper/benchmark/README.md).

## Folder structure

```
tool/
├── app/             pages and API routes (questions go to api/query)
├── components/      interface: profile, answer, citations, forecast chart, skill card, report button
├── lib/
│   ├── leads/       question pipeline: plan, evidence, rule test, writing, claim checks
│   ├── skill/       forecast-skill record and its plot
│   └── *.ts         literature search, PDF reading, decision report and shared helpers
├── scripts/         set-up scripts, the skill-record builder and the checks in npm run check
├── supabase/        database set-up (SQL)
├── data/            paper list and corpus manifest
├── public/          logos
├── .env.example     every setting, explained
└── Dockerfile       used by the Docker version
```
