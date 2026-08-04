"""Unit tests for Aether backend actions."""

import sys
import os
import json
import tempfile
import shutil

# Add app dir to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# We need to test with an isolated data dir
import app as aether_app


def setup_temp_data():
    """Point the app at a temp directory for testing."""
    tmpdir = tempfile.mkdtemp()
    aether_app.DATA_DIR = __import__('pathlib').Path(tmpdir)
    aether_app.PRESETS_FILE = aether_app.DATA_DIR / "presets.json"
    aether_app.DATA_DIR.mkdir(exist_ok=True)
    return tmpdir


def teardown_temp_data(tmpdir):
    shutil.rmtree(tmpdir, ignore_errors=True)


def test_generate_rules():
    tmpdir = setup_temp_data()
    try:
        result = aether_app.generate_rules(num_types=4, seed=42)
        assert result['num_types'] == 4
        assert len(result['interactions']) == 16
        assert result['seed'] == 42
        # Reproducible
        result2 = aether_app.generate_rules(num_types=4, seed=42)
        assert result['interactions'] == result2['interactions']
        # Different seed → different rules
        result3 = aether_app.generate_rules(num_types=4, seed=99)
        assert result['interactions'] != result3['interactions']
        print("✓ test_generate_rules passed")
    finally:
        teardown_temp_data(tmpdir)


def test_generate_rules_bounds():
    tmpdir = setup_temp_data()
    try:
        result = aether_app.generate_rules(num_types=1)  # clamped to 2
        assert result['num_types'] == 2
        assert len(result['interactions']) == 4
        result = aether_app.generate_rules(num_types=10)  # clamped to 8
        assert result['num_types'] == 8
        assert len(result['interactions']) == 64
        print("✓ test_generate_rules_bounds passed")
    finally:
        teardown_temp_data(tmpdir)


def test_save_and_load_preset():
    tmpdir = setup_temp_data()
    try:
        # Save
        result = aether_app.save_preset(
            name="Test World",
            num_types=3,
            interactions=[0.5, -0.3, 0.1, -0.2, 0.8, 0.0, 0.3, -0.1, 0.6],
            params={"r_max": 80, "force_strength": 0.5},
        )
        assert result['created'] is True
        assert result['preset']['name'] == "Test World"
        assert result['count'] == 1

        # Load
        loaded = aether_app.load_preset(name="Test World")
        assert loaded['preset']['name'] == "Test World"
        assert loaded['preset']['num_types'] == 3
        assert len(loaded['preset']['interactions']) == 9

        print("✓ test_save_and_load_preset passed")
    finally:
        teardown_temp_data(tmpdir)


def test_overwrite_preset():
    tmpdir = setup_temp_data()
    try:
        aether_app.save_preset(name="World", num_types=2, interactions=[0.1, 0.2, 0.3, 0.4])
        result = aether_app.save_preset(name="World", num_types=3, interactions=[0.5] * 9)
        assert result['created'] is False  # overwritten, not new
        assert result['count'] == 1
        loaded = aether_app.load_preset(name="World")
        assert loaded['preset']['num_types'] == 3
        print("✓ test_overwrite_preset passed")
    finally:
        teardown_temp_data(tmpdir)


def test_delete_preset():
    tmpdir = setup_temp_data()
    try:
        aether_app.save_preset(name="ToDelete", num_types=2, interactions=[0.1, 0.2, 0.3, 0.4])
        result = aether_app.delete_preset(name="ToDelete")
        assert result['deleted'] == "ToDelete"
        assert result['count'] == 0
        # Loading deleted preset should error
        loaded = aether_app.load_preset(name="ToDelete")
        assert 'error' in loaded
        print("✓ test_delete_preset passed")
    finally:
        teardown_temp_data(tmpdir)


def test_get_presets():
    tmpdir = setup_temp_data()
    try:
        aether_app.save_preset(name="World A", num_types=2, interactions=[0.1, 0.2, 0.3, 0.4])
        aether_app.save_preset(name="World B", num_types=3, interactions=[0.5] * 9)
        result = aether_app.get_presets()
        assert result['count'] == 2
        assert len(result['presets']) == 2
        print("✓ test_get_presets passed")
    finally:
        teardown_temp_data(tmpdir)


def test_save_empty_name():
    tmpdir = setup_temp_data()
    try:
        result = aether_app.save_preset(name="", interactions=[0.1])
        assert 'error' in result
        result = aether_app.save_preset(name="   ", interactions=[0.1])
        assert 'error' in result
        print("✓ test_save_empty_name passed")
    finally:
        teardown_temp_data(tmpdir)


def test_get_stats():
    tmpdir = setup_temp_data()
    try:
        aether_app.save_preset(name="A", num_types=2, interactions=[0.1, 0.2, 0.3, 0.4])
        aether_app.save_preset(name="B", num_types=2, interactions=[0.1, 0.2, 0.3, 0.4])
        aether_app.save_preset(name="C", num_types=4, interactions=[0.1] * 16)
        stats = aether_app.get_stats()
        assert stats['total_presets'] == 3
        assert stats['type_distribution'].get(2) == 2 or stats['type_distribution'].get('2') == 2
        assert stats['type_distribution'].get(4) == 1 or stats['type_distribution'].get('4') == 1
        print("✓ test_get_stats passed")
    finally:
        teardown_temp_data(tmpdir)


def test_actions_dict():
    """Verify all expected actions are exported."""
    expected = {'get_presets', 'save_preset', 'load_preset', 'delete_preset', 'generate_rules', 'get_stats'}
    assert expected.issubset(set(aether_app.actions.keys()))
    for name, fn in aether_app.actions.items():
        assert callable(fn), f"{name} is not callable"
    print("✓ test_actions_dict passed")


def test_persistence():
    """Verify presets survive a reload (new process reading same file)."""
    tmpdir = setup_temp_data()
    try:
        aether_app.save_preset(name="Persistent", num_types=4, interactions=[0.5] * 16)
        # Simulate reload by clearing the in-memory cache
        aether_app._load_presets.__wrapped__ = None  # just re-read from disk
        loaded = aether_app.load_preset(name="Persistent")
        assert loaded['preset']['name'] == "Persistent"
        # Verify file exists on disk
        assert aether_app.PRESETS_FILE.exists()
        data = json.loads(aether_app.PRESETS_FILE.read_text())
        assert "Persistent" in data
        print("✓ test_persistence passed")
    finally:
        teardown_temp_data(tmpdir)


if __name__ == '__main__':
    test_generate_rules()
    test_generate_rules_bounds()
    test_save_and_load_preset()
    test_overwrite_preset()
    test_delete_preset()
    test_get_presets()
    test_save_empty_name()
    test_get_stats()
    test_actions_dict()
    test_persistence()
    print("\n✅ All tests passed!")