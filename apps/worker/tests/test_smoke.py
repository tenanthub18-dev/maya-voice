import importlib


def test_worker_package_imports() -> None:
    package = importlib.import_module("voice_receptionist_worker")

    assert package.__name__ == "voice_receptionist_worker"
