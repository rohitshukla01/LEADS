# Try LEADS with Docker

## Before you start

You need:

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- about 1.4 GB of disk space for the LEADS image
- internet access
- [this repository](README.md#get-the-repository)
- your own API key for the language model

A separate key with a spending limit is safest. Delete it at the provider after trying LEADS.

Tested on macOS 14.8 (Apple M1, 8 GB) with Docker 29.9.3. Not tested on Windows or Linux.

## Run LEADS

### 1. Start Docker Desktop

Leave it running.

### 2. Open a terminal in the repository folder

On macOS open Terminal; on Windows open PowerShell. Go to the repository folder, for example:

```bash
cd LEADS
```

If you downloaded the ZIP, use `cd ~/Downloads/LEADS-main` instead. Run all later commands there. `ls` should list `docker-compose.yml` and `docker.env.example`.

### 3. Copy the settings file

macOS and Linux:

```bash
cp docker.env.example .env
```

Windows PowerShell:

```powershell
Copy-Item docker.env.example .env
```

### 4. Add your model key

Open `.env` in a text editor. On macOS:

```bash
open -e .env
```

Windows PowerShell:

```powershell
notepad .env
```

Put your key directly after `OPENAI_API_KEY=`. For OpenAI, the default, that is all:

```
OPENAI_API_KEY=your-key
```

For another provider, such as Gemini or Claude, also remove the `# ` in front of that provider's three lines. Save and close the file.

The key stays in `.env` on your computer. LEADS sends it only to your model provider.

### 5. Build and start LEADS

```bash
docker compose up --build
```

The first build takes several minutes. You should see a line containing `Ready in`. Leave this terminal open.

### 6. Open LEADS in your browser

Go to http://localhost:3000. If the browser cannot connect, wait for `Ready in`. Only your own computer can reach LEADS.

Above the question box you should see an amber bar starting **LEADS PROFILE · STEP 1**. Click it. On later visits the browser remembers your profile, so the bar is not shown.

### 7. Confirm the user profile

The form is already filled in with **Reservoir / Utility Manager**, **FCR** and **Hypoxia management (HOx)**. Keep these and click **Confirm profile → Planning**. With the Researcher profile, answers come without the operating-rule check. To change the persona, reservoir or decision later, click **EDIT PROFILE** next to the question box.

### 8. Ask a first question

For example:

> Should I turn on the oxygenation system at FCR this week?

You should see a written answer with the data, the operating-rule check and the forecast.

The Docker version does not remember earlier questions. Write the reservoir, the depth and the dates into every question.

## Stop, start again, update and remove

### Stop LEADS

Press Ctrl+C in the terminal where LEADS runs.

### Start it again

```bash
docker compose up
```

No new build is needed.

### Change the key or the provider

Stop LEADS, edit `.env` as in step 4, then start it again.

### Run without the authors' literature server

Literature search goes through a server run by the authors. To run LEADS without it, stop LEADS, delete the
`LEADS_RELAY_URL` line in `.env` and start LEADS again. Answers then have no literature evidence.

### Update LEADS

If you used `git clone`, run:

```bash
git pull
docker compose up --build
```

If `docker.env.example` has changed, copy its new lines into your `.env`. If you downloaded the ZIP, copy your key from `.env` and remove LEADS (see below). Then download and unzip the repository again and repeat steps 2 to 5.

### Remove LEADS

```bash
docker compose down --rmi local
```

This removes the LEADS container and image. To also remove Docker's build cache and the `node:22-slim` base image (about 0.35 GB), run these and answer `y` to the first:

```bash
docker builder prune --all
docker image rm node:22-slim
```

The first clears the build cache of every image built on this computer, which only makes later builds slower.

Then delete `.env`, which holds your key. The command also works in PowerShell:

```bash
rm .env
```

## If something goes wrong

After any change to `.env`, stop LEADS and start it again.

| What you see | What to do |
|---|---|
| `failed to connect to the docker API` or `Cannot connect to the Docker daemon` (on Windows, `error during connect`), or the `docker` command is not found | Start or install Docker Desktop and wait until it is running. |
| `no configuration file provided` or `env file … .env not found` | Go to the repository folder and check that `.env` exists (steps 2 and 3). |
| `port is already allocated` or `Ports are not available` for port 3000 | Another program, such as another copy of LEADS, uses port 3000. Stop it. |
| The build stops with `no space left on device`, `Killed` or `exit code: 137` | Free disk space or, on a Mac, raise the Memory limit in Docker Desktop's settings. |
| The page shows only `Open LEADS at http://localhost:3000` | Use http://localhost:3000 on the computer that runs LEADS. |
| The answer has a line starting `LEADS fallback answer for` and a list of the evidence | LEADS found no key in `.env`. Add your key as in step 4. |
| The answer has a paragraph starting `Current sensor context:` that lists the evidence, although `.env` has a key | The model provider refused the request. The terminal shows why, for example `API error 401` with `Invalid API Key`, or `API error 429` when the free allowance is used up. Check that the key is complete and is for the provider you set up in step 4, or wait until the allowance resets. If you set your own model in `.env`, choose one that does not think at length before answering. |
| An answer takes up to about two minutes | This can happen, especially with a free key. Free keys also limit requests per minute, so wait for each answer before asking the next. |

You can ignore these messages:

- `Network: http://172.…:3000` at start-up
- `Failed to set Next.js data cache … items over 2MB can not be cached`
- `using deprecated parameters for the initialization function`
