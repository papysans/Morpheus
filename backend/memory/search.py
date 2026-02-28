import json
import logging
import numpy as np
from typing import List, Dict, Optional, Any
from pathlib import Path

logger = logging.getLogger(__name__)

try:
    import lancedb

    LANCEDB_AVAILABLE = True
except ImportError:
    LANCEDB_AVAILABLE = False


class VectorStore:
    def __init__(self, db_path: str, dimension: int = 1536):
        self.db_path = Path(db_path)
        self.dimension = dimension
        self.db = None
        self.table = None
        self._init_db()

    def _init_db(self):
        if not LANCEDB_AVAILABLE:
            self._init_fallback()
            return

        try:
            self._fallback_mode = False
            self.db_path.mkdir(parents=True, exist_ok=True)
            self.db = lancedb.connect(str(self.db_path))
            try:
                self.table = self.db.open_table("memories")
            except Exception:
                self.table = self.db.create_table(
                    "memories",
                    data=[
                        {
                            "id": "__bootstrap__",
                            "vector": np.zeros(self.dimension, dtype=np.float32),
                            "layer": "L2",
                            "source_path": "",
                            "summary": "",
                            "content": "",
                            "entities": "[]",
                            "importance": 5,
                            "recency": 1,
                        }
                    ],
                )
                self.table.delete("id = '__bootstrap__'")
        except Exception:
            self._init_fallback()

    def _init_fallback(self):
        self._fallback_mode = True
        self.db_path.mkdir(parents=True, exist_ok=True)
        self.embeddings_file = self.db_path / "embeddings.json"
        if not self.embeddings_file.exists():
            self.embeddings_file.write_text("{}", encoding="utf-8")

    def add_embedding(self, item_id: str, embedding: List[float], metadata: Dict[str, Any]):
        if self._fallback_mode:
            self._add_fallback(item_id, embedding, metadata)
            return
        if self.table is None:
            self._init_fallback()
            self._add_fallback(item_id, embedding, metadata)
            return

        record = {
            "id": item_id,
            "vector": np.array(embedding, dtype=np.float32),
            "layer": metadata.get("layer", ""),
            "source_path": metadata.get("source_path", ""),
            "summary": metadata.get("summary", ""),
            "content": metadata.get("content", ""),
            "entities": json.dumps(metadata.get("entities", [])),
            "importance": metadata.get("importance", 5),
            "recency": metadata.get("recency", 1),
        }

        try:
            self.table.delete(f"id = '{item_id}'")
        except Exception as exc:
            logger.debug("vector delete failed before upsert id=%s err=%s", item_id, exc)
        self.table.add([record])

    def _add_fallback(self, item_id: str, embedding: List[float], metadata: Dict[str, Any]):
        data = json.loads(self.embeddings_file.read_text(encoding="utf-8"))
        data[item_id] = {"embedding": embedding, "metadata": metadata}
        self.embeddings_file.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def search(self, query_embedding: List[float], top_k: int = 20) -> List[Dict]:
        if self._fallback_mode:
            return self._search_fallback(query_embedding, top_k)
        if self.table is None:
            return self._search_fallback(query_embedding, top_k)

        results = (
            self.table.search(np.array(query_embedding, dtype=np.float32)).limit(top_k).to_list()
        )

        formatted = []
        for r in results:
            formatted.append(
                {
                    "item_id": r["id"],
                    "layer": r["layer"],
                    "source_path": r["source_path"],
                    "summary": r["summary"],
                    "content": r["content"],
                    "score": r["_distance"],
                    "entities": json.loads(r["entities"]) if r.get("entities") else [],
                }
            )
        return formatted

    def _search_fallback(self, query_embedding: List[float], top_k: int) -> List[Dict]:
        data = json.loads(self.embeddings_file.read_text(encoding="utf-8"))

        results = []
        for item_id, item_data in data.items():
            emb = np.array(item_data["embedding"])
            query = np.array(query_embedding)

            cosine_sim = np.dot(emb, query) / (np.linalg.norm(emb) * np.linalg.norm(query) + 1e-8)

            results.append(
                {
                    "item_id": item_id,
                    "layer": item_data["metadata"].get("layer", ""),
                    "source_path": item_data["metadata"].get("source_path", ""),
                    "summary": item_data["metadata"].get("summary", ""),
                    "content": item_data["metadata"].get("content", ""),
                    "score": float(1 - cosine_sim),
                    "entities": item_data["metadata"].get("entities", []),
                }
            )

        results.sort(key=lambda x: x["score"])
        return results[:top_k]


class HybridSearchEngine:
    def __init__(
        self,
        fts_search_func,
        vector_store: VectorStore,
        layer_weights: Optional[Dict[str, float]] = None,
    ):
        self.fts_search = fts_search_func
        self.vector_store = vector_store

        self.layer_weights = layer_weights or {"L1": 1.0, "L2": 0.7, "L3": 0.5}

    def search(
        self,
        query: str,
        query_embedding: Optional[List[float]] = None,
        fts_top_k: int = 30,
        vector_top_k: int = 20,
        hybrid_top_k: int = 30,
        filter_layers: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        fts_results = self.fts_search(query, fts_top_k)

        vector_results = []
        if query_embedding:
            vector_results = self.vector_store.search(query_embedding, vector_top_k)

        merged = self._merge_results(fts_results, vector_results)

        if filter_layers:
            merged = [r for r in merged if r.get("layer") in filter_layers]

        merged.sort(key=lambda x: x["combined_score"], reverse=True)

        return merged[:hybrid_top_k]

    def _merge_results(self, fts_results: List[Dict], vector_results: List[Dict]) -> List[Dict]:
        item_map = {}

        for r in fts_results:
            item_id = r.get("item_id", r.get("id"))
            layer = r.get("layer", "L2")
            weight = self.layer_weights.get(layer, 0.5)

            item_map[item_id] = {
                "item_id": item_id,
                "layer": layer,
                "source_path": r.get("source_path", ""),
                "summary": r.get("summary", ""),
                "content": r.get("content", ""),
                "evidence": r.get("evidence"),
                "fts_score": 1.0 - (r.get("score", 0) / 100),
                "vector_score": 0.0,
                "combined_score": (1.0 - (r.get("score", 0) / 100)) * weight,
                "entities": r.get("entities", []),
            }

        for r in vector_results:
            item_id = r.get("item_id")
            layer = r.get("layer", "L2")
            weight = self.layer_weights.get(layer, 0.5)

            if item_id in item_map:
                item_map[item_id]["vector_score"] = 1.0 - r.get("score", 0)
                item_map[item_id]["combined_score"] += (1.0 - r.get("score", 0)) * weight * 0.5
            else:
                item_map[item_id] = {
                    "item_id": item_id,
                    "layer": layer,
                    "source_path": r.get("source_path", ""),
                    "summary": r.get("summary", ""),
                    "content": r.get("content", ""),
                    "evidence": None,
                    "fts_score": 0.0,
                    "vector_score": 1.0 - r.get("score", 0),
                    "combined_score": (1.0 - r.get("score", 0)) * weight,
                    "entities": r.get("entities", []),
                }

        return list(item_map.values())


class EmbeddingProvider:
    def __init__(
        self,
        model_name: str = "embo-01",
        api_key: Optional[str] = None,
        provider: str = "minimax",
        base_url: Optional[str] = None,
    ):
        self.model_name = model_name
        self.provider = provider
        from core.llm_client import create_llm_client

        self.llm_client = create_llm_client(
            provider=provider,
            api_key=api_key,
            embedding_model=model_name,
            base_url=base_url,
        )

    def embed_text(self, text: str) -> List[float]:
        return self.llm_client.embed_text(text)

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        return self.llm_client.embed_batch(texts)
