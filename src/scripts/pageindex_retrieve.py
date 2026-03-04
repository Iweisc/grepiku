#!/usr/bin/env python3
import argparse
import asyncio
import json
import math
import re
import sys
import tempfile
import types
from pathlib import Path
from typing import Any


def install_dependency_stubs() -> None:
    # PageIndex markdown mode does not need these at runtime for our flags,
    # but pageindex.utils imports them eagerly.
    if "dotenv" not in sys.modules:
        dotenv = types.ModuleType("dotenv")
        dotenv.load_dotenv = lambda *args, **kwargs: None
        sys.modules["dotenv"] = dotenv

    if "tiktoken" not in sys.modules:
        tiktoken = types.ModuleType("tiktoken")

        class _Encoding:
            def encode(self, text: str):
                if not text:
                    return []
                return text.split()

        tiktoken.encoding_for_model = lambda _model=None: _Encoding()
        sys.modules["tiktoken"] = tiktoken

    if "openai" not in sys.modules:
        openai = types.ModuleType("openai")

        class _UnsupportedClient:
            def __init__(self, *args, **kwargs):
                pass

            def __getattr__(self, _name):
                raise RuntimeError("OpenAI client is unavailable in this environment")

        openai.OpenAI = _UnsupportedClient
        openai.AsyncOpenAI = _UnsupportedClient
        sys.modules["openai"] = openai

    if "PyPDF2" not in sys.modules:
        pypdf2 = types.ModuleType("PyPDF2")

        class _PdfReader:
            def __init__(self, *args, **kwargs):
                raise RuntimeError("PyPDF2 is unavailable in this environment")

        pypdf2.PdfReader = _PdfReader
        sys.modules["PyPDF2"] = pypdf2

    if "pymupdf" not in sys.modules:
        pymupdf = types.ModuleType("pymupdf")
        pymupdf.open = lambda *args, **kwargs: (_ for _ in ()).throw(
            RuntimeError("pymupdf is unavailable in this environment")
        )
        sys.modules["pymupdf"] = pymupdf

    if "yaml" not in sys.modules:
        yaml = types.ModuleType("yaml")
        yaml.safe_load = lambda *args, **kwargs: {}
        yaml.dump = lambda *args, **kwargs: ""
        sys.modules["yaml"] = yaml


STOPWORDS = {
    "a",
    "an",
    "the",
    "and",
    "or",
    "to",
    "of",
    "in",
    "on",
    "for",
    "is",
    "are",
    "be",
    "from",
    "by",
    "with",
    "this",
    "that",
    "it",
    "as",
}


def tokenize(value: str) -> set[str]:
    tokens = []
    for token in re.split(r"[^a-z0-9_./-]+", (value or "").lower()):
        token = token.strip()
        if len(token) >= 2 and token not in STOPWORDS:
            tokens.append(token)
    return set(tokens)


def lexical_similarity(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    overlap = sum(1 for token in a if token in b)
    return overlap / math.sqrt(len(a) * len(b))


def normalize_path(path_value: str) -> str:
    return (path_value or "").strip().replace("\\", "/").replace("./", "").lstrip("/").replace("//", "/")


def directory_path(path_value: str) -> str:
    idx = path_value.rfind("/")
    return "" if idx < 0 else path_value[:idx]


def format_item_heading(item: dict[str, Any]) -> str:
    item_id = item.get("id")
    kind = str(item.get("kind") or "chunk")
    path = str(item.get("path") or "")
    symbol = str(item.get("symbol") or "")
    if kind == "symbol" and symbol:
        label = f"symbol {symbol}"
    elif kind == "file":
        label = f"file {path}"
    else:
        label = f"{kind} {path}"
    return f"[ITEM:{item_id}] {label}"


def build_repo_markdown(items: list[dict[str, Any]]) -> str:
    lines: list[str] = ["# Repository Index"]
    by_path: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        path = normalize_path(str(item.get("path") or ""))
        by_path.setdefault(path, []).append(item)

    for path in sorted(by_path.keys()):
        section_name = path or "(unknown)"
        lines.append(f"## {section_name}")
        entries = by_path[path]
        entries.sort(key=lambda item: (str(item.get("kind") or ""), int(item.get("id") or 0)))
        for item in entries:
            lines.append(f"### {format_item_heading(item)}")
            text = str(item.get("text") or "").strip()
            lines.append(text[:12000] if text else "(empty)")
    return "\n\n".join(lines)


async def run_pageindex_tree(markdown_path: str, pageindex_root: Path):
    install_dependency_stubs()
    sys.path.insert(0, str(pageindex_root))

    from pageindex.page_index_md import md_to_tree
    from pageindex.utils import structure_to_list

    tree = await md_to_tree(
        md_path=markdown_path,
        if_thinning=False,
        min_token_threshold=5000,
        if_add_node_summary="no",
        summary_token_threshold=200,
        model="gpt-4o-2024-11-20",
        if_add_doc_description="no",
        if_add_node_text="yes",
        if_add_node_id="yes",
    )
    nodes = structure_to_list(tree.get("structure", []))
    return nodes


def main() -> None:
    parser = argparse.ArgumentParser(description="Run PageIndex retrieval over repository node records")
    parser.add_argument("--input", required=True, help="Path to JSON input payload")
    args = parser.parse_args()

    payload_path = Path(args.input).resolve()
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    query = str(payload.get("query") or "")
    top_k = int(payload.get("top_k") or 28)
    items = payload.get("items") or []
    changed_paths = {normalize_path(path) for path in (payload.get("changed_paths") or [])}
    changed_dirs = {directory_path(path) for path in changed_paths if directory_path(path)}

    if not isinstance(items, list):
        raise RuntimeError("Invalid input: items must be a list")

    item_map: dict[int, dict[str, Any]] = {}
    for raw in items:
        if not isinstance(raw, dict):
            continue
        try:
            item_id = int(raw.get("id"))
        except Exception:
            continue
        item_map[item_id] = raw

    markdown = build_repo_markdown(list(item_map.values()))

    pageindex_root_raw = str(payload.get("pageindex_root") or "")
    pageindex_root = Path(pageindex_root_raw).resolve() if pageindex_root_raw else (Path.cwd() / "PageIndex")

    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=True, encoding="utf-8") as handle:
        handle.write(markdown)
        handle.flush()
        nodes = asyncio.run(run_pageindex_tree(handle.name, pageindex_root))

    query_tokens = tokenize(query)
    id_pattern = re.compile(r"\[ITEM:(\d+)\]")
    by_item_id: dict[int, dict[str, float]] = {}

    for node in nodes:
        title = str(node.get("title") or "")
        matched = id_pattern.search(title)
        if not matched:
            continue
        item_id = int(matched.group(1))
        item = item_map.get(item_id)
        if not item:
            continue

        text = str(node.get("text") or "")
        clean_title = id_pattern.sub("", title).strip()
        title_score = lexical_similarity(query_tokens, tokenize(clean_title))
        text_score = lexical_similarity(query_tokens, tokenize(text[:10000]))

        path = normalize_path(str(item.get("path") or ""))
        path_boost = 0.0
        if path and path in changed_paths:
            path_boost += 0.16
        elif directory_path(path) in changed_dirs:
            path_boost += 0.08

        kind = str(item.get("kind") or "chunk")
        kind_boost = 0.02 if kind == "symbol" else (0.03 if kind == "chunk" else 0.0)
        base_score = title_score * 0.62 + text_score * 0.22 + path_boost + kind_boost

        existing = by_item_id.get(item_id)
        if existing is None or base_score > existing["score"]:
            by_item_id[item_id] = {
                "score": base_score,
                "semantic": title_score,
                "lexical": text_score,
                "pathBoost": path_boost,
                "kindBoost": kind_boost,
                "patternBoost": 0.0,
            }

    ordered = sorted(by_item_id.items(), key=lambda pair: pair[1]["score"], reverse=True)
    results = [
        {"id": item_id, **signals}
        for item_id, signals in ordered[: max(4, min(200, top_k * 3))]
    ]

    print(json.dumps({"results": results}, ensure_ascii=True))


if __name__ == "__main__":
    main()
