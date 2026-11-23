# Support Intake

Support Intake suggests one of 77 banking-support intents for a request. Paste the request text or upload a PNG or JPEG screenshot. A reviewer can confirm or correct the suggestion and see the review history. Screenshots and uncertain text requests go to manual review.

## Run on an Apple Silicon Mac

Install Python 3.12 and make it available as `python3`. From the repository root:

```sh
sh scripts/setup-macos.sh
runtime="$(cd ../runtime && pwd)"
export SUPPORT_RUNTIME="$runtime"
export PATH="$runtime/node-v22.23.5-darwin-arm64/bin:$PATH"
export TMPDIR="$runtime/tmp" npm_config_cache="$runtime/cache/npm"
npm start
```

Open <http://127.0.0.1:4317>. Try “I lost my card and need a new one,” then submit a screenshot of the same text. Open the review queue to confirm or adjust the screenshot's suggestion.

Setup installs Node.js, Python/Node dependencies, and the matching headless browser in the local project. It verifies the pinned data and trains the model on the CPU. The app starts a loopback-only PostgreSQL instance on port 54327. Override `SUPPORT_PORT` and `SUPPORT_DB_PORT` for a second instance with its own `SUPPORT_RUNTIME`. Tickets and model files are stored in the runtime directory. Screenshot bytes are removed after inference.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Check the database and inference process |
| GET | `/api/intents` | Get accepted intent names |
| POST | `/api/tickets` | Submit JSON with `text` or with base64 `image` and its `mime` |
| GET | `/api/tickets?status=review` | Get the latest tickets, optionally filtered by `review` or `routed` |
| GET | `/api/tickets/:id` | Get the ticket and review history |
| PATCH | `/api/tickets/:id` | Save `intent`, current `version`, and optional `note` |

A successful submission returns 201. A stale review returns 409 and leaves the original review intact. Images are limited to 3 MiB and 12 megapixels.

## Model and evaluation

The neural text model averages learned token embeddings and uses a multilayer classifier. A TF-IDF logistic-regression model is the comparison baseline. The data uses 8,002 training examples, 2,001 validation examples, and the untouched 3,080-example Banking77 test split. Validation selects the confidence cutoff. Macro-F1 on the test split was **0.881** for the baseline and **0.847** for the neural model, which powers the app. The neural cutoff routed **3,016/3,080** typed examples at **85.88% accuracy** and queued 64 for review.

RapidOCR reads screenshots using ONNX Runtime. OpenCV converts the image to grayscale, inverts dark backgrounds, and enhances local contrast. Across 77 labeled rendered screenshots, character error fell from **2.55% to 0.76%** and word error from **7.51% to 4.68%**. Intent accuracy rose from **71.43% to 72.73%**. All 77 exceeded the typed-text cutoff, so the app requires confirmation for every screenshot. These renders cover three styles and do not measure accuracy on customer screenshots.

```sh
export PYTHONPYCACHEPREFIX="$runtime/pycache"
"$runtime/venv/bin/python" -m ml.train
"$runtime/venv/bin/python" -m ml.evaluate_images
```

The runtime directory receives `evaluation-text.json` and `evaluation-images.json`, which include per-intent errors and fixture-level results. Banking77 is © PolyAI Limited under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). See the [upstream data](https://github.com/PolyAI-LDN/task-specific-datasets/tree/master/banking_data) and [Casanueva et al. (2020)](https://aclanthology.org/2020.nlp4convai-1.5/).

## Verify and rehearse a release

Use a disposable runtime for integration and browser tests because they write tickets and inject a database failure. With the setup environment above, start a separate test app:

```sh
export SUPPORT_MODEL_RUNTIME="$runtime"
export SUPPORT_RUNTIME="$runtime/checks"
export SUPPORT_PORT=4320 SUPPORT_DB_PORT=54330
npm start
```

In a second shell, use the same runtime paths and Node binary:

```sh
runtime="$(cd ../runtime && pwd)"
export PATH="$runtime/node-v22.23.5-darwin-arm64/bin:$PATH"
export TMPDIR="$runtime/tmp" npm_config_cache="$runtime/cache/npm"
export SUPPORT_MODEL_RUNTIME="$runtime" SUPPORT_RUNTIME="$runtime/checks"
export SUPPORT_BASE_URL=http://127.0.0.1:4320 SUPPORT_DB_PORT=54330
export SUPPORT_CHROME="$runtime/chrome-headless-shell-mac-arm64/chrome-headless-shell"
export SUPPORT_CHROMEDRIVER="$runtime/chromedriver-mac-arm64/chromedriver"
npm test
npm run test:integration
npm run test:browser
npm run release
npm run release -- --inject-smoke-failure
```

The release command packages the app, applies migrations to isolated state, sends a request through model and database, and updates a local active-release pointer after checks pass. The injected failure command exits nonzero after verifying that the previously promoted release still starts and passes its smoke checks.
