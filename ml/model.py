"""CPU intent inference shared by the benchmark and the application."""

from itertools import accumulate, chain
import re

import torch
from torch import nn

from .dataset import MODEL_RUNTIME

TOKEN_PATTERN = re.compile(r"[^\W_]+(?:['’][^\W_]+)*")
EMBEDDING_DIM = 96
HIDDEN_DIM = 128


def terms(text):
    words = TOKEN_PATTERN.findall(text.casefold().replace("’", "'"))
    return words + [f"{first} {second}" for first, second in zip(words, words[1:])]


def pack(examples):
    return (
        torch.tensor(list(chain.from_iterable(examples)), dtype=torch.long),
        torch.tensor(list(accumulate(map(len, examples), initial=0)), dtype=torch.long),
    )


class IntentNet(nn.Module):
    def __init__(self, vocabulary_size, num_labels):
        super().__init__()
        self.embedding = nn.EmbeddingBag(
            vocabulary_size, EMBEDDING_DIM, mode="mean", include_last_offset=True
        )
        self.classifier = nn.Sequential(
            nn.LayerNorm(EMBEDDING_DIM),
            nn.Linear(EMBEDDING_DIM, HIDDEN_DIM),
            nn.GELU(),
            nn.Dropout(0.2),
            nn.Linear(HIDDEN_DIM, num_labels),
        )

    def forward(self, ids, offsets):
        return self.classifier(self.embedding(ids, offsets))


class IntentModel:
    def __init__(self):
        checkpoint = torch.load(
            MODEL_RUNTIME / "model.pt", map_location="cpu", weights_only=True
        )
        self.labels = checkpoint["labels"]
        self.vocabulary = checkpoint["vocabulary"]
        self.threshold = checkpoint["threshold"]
        self.temperature = checkpoint["temperature"]
        self.network = IntentNet(len(self.vocabulary), len(self.labels))
        self.network.load_state_dict(checkpoint["state"])
        self.network.eval()

    @torch.inference_mode()
    def predict(self, text):
        ids = [self.vocabulary[word] for word in terms(text) if word in self.vocabulary]
        if not ids:
            return {"text": text, "intent": None, "confidence": 0.0, "needsReview": True}
        logits = self.network(*pack([ids]))
        confidence, label = (logits / self.temperature).softmax(dim=1).max(dim=1)
        score = confidence.item()
        return {
            "text": text,
            "intent": self.labels[label.item()],
            "confidence": score,
            "needsReview": self.threshold is None or score < self.threshold,
        }
