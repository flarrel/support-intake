"""Train wording-based intent models and evaluate the untouched Banking77 test set."""

from collections import Counter
import copy
import hashlib
import json

import numpy as np
from scipy.optimize import minimize_scalar
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, f1_score
from sklearn.model_selection import train_test_split
import torch

from .dataset import FILES, MODEL_RUNTIME, REVISION, RUNTIME, load_splits
from .model import IntentNet, pack, terms

SEED = 42
EPOCHS = 26
BATCH_SIZE = 128
VALIDATION_SIZE = 0.2
TARGET_ACCURACY = 0.85
MIN_VALIDATION_ROUTES = 40


def validation_policy(logits, labels, has_features):
    """Temperature-scale scores and maximize coverage at the validation target."""
    targets = torch.tensor(labels)
    fit = minimize_scalar(
        lambda value: torch.nn.functional.cross_entropy(logits / value, targets).item(),
        method="bounded",
        bounds=(0.25, 8.0),
    )
    temperature = float(fit.x)
    confidence, predicted = (logits / temperature).softmax(dim=1).max(dim=1)
    scores = confidence.numpy()
    correct = predicted.numpy() == labels
    # Probe only observed score boundaries to include equal scores together.
    scores_to_try = sorted(set(scores[has_features]))
    for score in scores_to_try:
        selected = has_features & (scores >= score)
        if selected.sum() < MIN_VALIDATION_ROUTES:
            break
        if correct[selected].mean() >= TARGET_ACCURACY:
            return temperature, float(score)
    return temperature, None


def evaluate_policy(logits, labels, has_features, temperature, threshold):
    confidence, predicted = (logits / temperature).softmax(dim=1).max(dim=1)
    if threshold is None:
        selected = np.zeros_like(has_features)
    else:
        selected = has_features & (confidence.numpy() >= threshold)
    total = len(labels)
    count = int(selected.sum())
    return {
        "examples": total,
        "automaticRoutes": count,
        "automaticCoverage": count / total,
        "automaticAccuracy": float((predicted.numpy()[selected] == labels[selected]).mean())
        if count else None,
        "manualReview": total - count,
    }


def metrics(labels, predictions, names):
    return {
        "accuracy": accuracy_score(labels, predictions),
        "macroF1": f1_score(labels, predictions, average="macro"),
        "perClass": classification_report(
            labels, predictions, target_names=names, output_dict=True, zero_division=0
        ),
    }


def examples(rows, vocabulary):
    return [[vocabulary[term] for term in terms(text) if term in vocabulary] for text in rows]


def evaluate_model(model, rows):
    model.eval()
    with torch.inference_mode():
        batches = [model(*pack(rows[start:start + BATCH_SIZE]))
                   for start in range(0, len(rows), BATCH_SIZE)]
    return torch.cat(batches)


def train_network(x_train, y_train, x_val, y_val, vocabulary_size, label_count):
    model = IntentNet(vocabulary_size, label_count)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.006)
    schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS, eta_min=0.001)
    best_score, best_epoch, best_state = -1.0, 0, None
    rng = np.random.default_rng(SEED)
    for epoch in range(1, EPOCHS + 1):
        model.train()
        order = rng.permutation(len(x_train))
        for start in range(0, len(order), BATCH_SIZE):
            batch = order[start:start + BATCH_SIZE]
            ids, offsets = pack([x_train[index] for index in batch])
            target = torch.as_tensor(y_train[batch])
            optimizer.zero_grad()
            loss = torch.nn.functional.cross_entropy(model(ids, offsets), target)
            loss.backward()
            optimizer.step()
        schedule.step()
        predictions = evaluate_model(model, x_val).argmax(dim=1).numpy()
        score = f1_score(y_val, predictions, average="macro")
        if score > best_score:
            best_score, best_epoch = score, epoch
            best_state = copy.deepcopy(model.state_dict())
        print(f"Epoch {epoch:02d}/{EPOCHS} validation macro-F1 {score:.4f}", flush=True)
    model.load_state_dict(best_state)
    return model, best_epoch


def save_json(path, value):
    pending = path.with_suffix(".writing")
    pending.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    pending.replace(path)


def main():
    torch.manual_seed(SEED)
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    train_rows, test_rows = load_splits()
    all_text, all_intents = zip(*train_rows)
    test_text, test_intents = zip(*test_rows)
    labels = sorted(set(all_intents))
    if len(labels) != 77 or set(labels) != set(test_intents):
        raise ValueError("Banking77 splits do not share the expected 77 labels")
    label_index = {label: index for index, label in enumerate(labels)}
    y_all = np.array([label_index[label] for label in all_intents])
    y_test = np.array([label_index[label] for label in test_intents])
    train_text, val_text, y_train, y_val = train_test_split(
        all_text, y_all, test_size=VALIDATION_SIZE, random_state=SEED, stratify=y_all
    )

    vectorizer = TfidfVectorizer(ngram_range=(1, 2), min_df=2, sublinear_tf=True)
    baseline = LogisticRegression(C=8, max_iter=500, random_state=SEED)
    baseline.fit(vectorizer.fit_transform(train_text), y_train)
    baseline_predictions = baseline.predict(vectorizer.transform(test_text))

    frequencies = Counter(term for text in train_text for term in terms(text))
    vocabulary = {term: index for index, term in enumerate(
        sorted(term for term, count in frequencies.items() if count >= 2)
    )}
    x_train = examples(train_text, vocabulary)
    x_val = examples(val_text, vocabulary)
    x_test = examples(test_text, vocabulary)
    model, best_epoch = train_network(
        x_train, y_train, x_val, y_val, len(vocabulary), len(labels)
    )
    val_logits = evaluate_model(model, x_val)
    val_features = np.array(list(map(bool, x_val)))
    temperature, threshold = validation_policy(val_logits, y_val, val_features)
    test_logits = evaluate_model(model, x_test)
    test_features = np.array(list(map(bool, x_test)))

    MODEL_RUNTIME.mkdir(parents=True, exist_ok=True)
    metadata = {
        "schemaVersion": 1,
        "labels": labels,
        "threshold": threshold,
        "temperature": temperature,
        "datasetRevision": REVISION,
    }
    pending = MODEL_RUNTIME / "model.writing"
    torch.save({
        "labels": labels,
        "vocabulary": vocabulary,
        "threshold": threshold,
        "temperature": temperature,
        "state": model.state_dict(),
    }, pending)
    pending.replace(MODEL_RUNTIME / "model.pt")
    save_json(MODEL_RUNTIME / "model-metadata.json", metadata)
    report = {
        "datasetRevision": REVISION,
        "sourceSha256": {
            name: hashlib.sha256((RUNTIME / "banking77" / name).read_bytes()).hexdigest()
            for name in FILES
        },
        "license": "CC-BY-4.0",
        "splitCounts": {"train": len(train_text), "validation": len(val_text), "test": len(test_text)},
        "seed": SEED,
        "bestEpoch": best_epoch,
        "threshold": threshold,
        "temperature": temperature,
        "validationTargetAccuracy": TARGET_ACCURACY,
        "validationMinimumAutomaticRoutes": MIN_VALIDATION_ROUTES,
        "validationPolicy": evaluate_policy(
            val_logits, y_val, val_features, temperature, threshold
        ),
        "testPolicy": evaluate_policy(test_logits, y_test, test_features, temperature, threshold),
        "baseline": metrics(y_test, baseline_predictions, labels),
        "neural": metrics(y_test, test_logits.argmax(1).numpy(), labels),
    }
    save_json(RUNTIME / "evaluation-text.json", report)
    print(json.dumps({
        "baselineMacroF1": report["baseline"]["macroF1"],
        "neuralMacroF1": report["neural"]["macroF1"],
        "testPolicy": report["testPolicy"],
    }, indent=2))


if __name__ == "__main__":
    main()
