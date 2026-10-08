"""A pod env file saved with a byte-order mark by a Windows editor.

Notepad's "UTF-8" writes UTF-8 with a BOM, and PowerShell's default ``>`` writes
UTF-16LE with one. Every reader of the per-pod env file must read the first key
without the mark, and a wide-encoded file must refuse with a message naming the
fix rather than raising a bare ``UnicodeDecodeError``.
"""

from __future__ import annotations

import codecs
from pathlib import Path

import pytest

from kiro_crew.apps.builtins.dev_fleet import worktree_ops
from kiro_crew.pod import runtime as rt
from kiro_crew.pod import runtime_ports
from kiro_crew.pod.config import PodConfig

_BODY = "MYVAR='hello'\r\nPORT='7999'\r\n"


def _cfg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> PodConfig:
    monkeypatch.setenv("KIROCREW_POD_ENV_DIR", str(tmp_path))
    cfg = PodConfig.load()
    cfg.pods_dir.mkdir(parents=True, exist_ok=True)
    return cfg


def test_utf8_bom_first_key_is_read_without_the_mark(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _cfg(tmp_path, monkeypatch)
    cfg.env_file("x").write_bytes(codecs.BOM_UTF8 + _BODY.encode("utf-8"))

    assert rt.read_env_file(cfg, "x") == {"MYVAR": "hello", "PORT": "7999"}


def test_utf8_bom_non_ascii_value_decodes_as_utf8(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The mark says UTF-8, so the value decodes as UTF-8 whatever the locale is.
    cfg = _cfg(tmp_path, monkeypatch)
    cfg.env_file("x").write_bytes(codecs.BOM_UTF8 + "SEED='caf\u00e9'\n".encode("utf-8"))

    assert rt.read_env_file(cfg, "x") == {"SEED": "caf\u00e9"}


def test_bomless_file_reads_as_before(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = _cfg(tmp_path, monkeypatch)
    cfg.env_file("x").write_bytes(_BODY.encode("utf-8"))

    assert rt.read_env_file(cfg, "x") == {"MYVAR": "hello", "PORT": "7999"}


def test_missing_file_still_reads_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert rt.read_env_file(_cfg(tmp_path, monkeypatch), "absent") == {}


@pytest.mark.parametrize(
    ("bom", "codec", "family"),
    [
        (codecs.BOM_UTF16_LE, "utf-16-le", "UTF-16"),
        (codecs.BOM_UTF16_BE, "utf-16-be", "UTF-16"),
        (codecs.BOM_UTF32_LE, "utf-32-le", "UTF-32"),
    ],
)
def test_wide_encoded_file_refuses_with_the_fix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bom: bytes, codec: str, family: str
) -> None:
    cfg = _cfg(tmp_path, monkeypatch)
    cfg.env_file("x").write_bytes(bom + _BODY.encode(codec))

    with pytest.raises(rt.PodError, match=rf"{family} byte-order mark; save it as UTF-8"):
        rt.read_env_file(cfg, "x")


def test_wide_encoded_file_is_not_overwritten_by_a_merge(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _cfg(tmp_path, monkeypatch)
    original = codecs.BOM_UTF16_LE + _BODY.encode("utf-16-le")
    cfg.env_file("x").write_bytes(original)

    with pytest.raises(rt.PodError):
        rt.write_env_file(cfg, "x", {"SEED": "/s"})
    assert cfg.env_file("x").read_bytes() == original


def test_merge_over_a_bom_file_keeps_the_first_key_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _cfg(tmp_path, monkeypatch)
    cfg.env_file("x").write_bytes(codecs.BOM_UTF8 + _BODY.encode("utf-8"))

    rt.write_env_file(cfg, "x", {"MYVAR": "bye"})

    assert rt.read_env_file(cfg, "x") == {"MYVAR": "bye", "PORT": "7999"}


def test_parse_env_text_drops_a_decoded_mark() -> None:
    assert rt._parse_env_text("\ufeffMYVAR='hello'\n") == {"MYVAR": "hello"}


def test_peer_env_reader_drops_the_mark(tmp_path: Path) -> None:
    path = tmp_path / "peer.env"
    path.write_bytes(codecs.BOM_UTF8 + _BODY.encode("utf-8"))

    assert runtime_ports._read_peer_env(path) == {"MYVAR": "hello", "PORT": "7999"}


def test_dev_fleet_strict_pin_reader_drops_the_mark(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _cfg(tmp_path, monkeypatch)
    cfg.env_file("x").write_bytes(codecs.BOM_UTF8 + b"CHECKOUT='/abs/co'\n")

    assert worktree_ops._read_pin_strict(cfg, "x") == (True, "/abs/co")
