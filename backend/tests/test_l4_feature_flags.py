"""Tests for L4 feature flags in backend Settings."""

import os
import unittest


class TestL4FeatureFlags(unittest.TestCase):
    def _make_settings(self, **env_overrides):
        """Create a fresh Settings instance with optional env overrides."""
        keys = ["L4_PROFILE_ENABLED", "L4_AUTO_EXTRACT_ENABLED"]
        saved = {k: os.environ.pop(k, None) for k in keys}
        for k, v in env_overrides.items():
            os.environ[k] = v
        try:
            from api.main import Settings

            return Settings()
        finally:
            for k in keys:
                os.environ.pop(k, None)
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v

    def test_l4_profile_enabled_default_true(self):
        s = self._make_settings()
        self.assertTrue(s.l4_profile_enabled)

    def test_l4_auto_extract_enabled_default_true(self):
        s = self._make_settings()
        self.assertTrue(s.l4_auto_extract_enabled)

    def test_l4_profile_disabled_via_env(self):
        s = self._make_settings(L4_PROFILE_ENABLED="false")
        self.assertFalse(s.l4_profile_enabled)

    def test_l4_auto_extract_disabled_via_env(self):
        s = self._make_settings(L4_AUTO_EXTRACT_ENABLED="false")
        self.assertFalse(s.l4_auto_extract_enabled)

    def test_flags_are_independent(self):
        s = self._make_settings(
            L4_PROFILE_ENABLED="false",
            L4_AUTO_EXTRACT_ENABLED="true",
        )
        self.assertFalse(s.l4_profile_enabled)
        self.assertTrue(s.l4_auto_extract_enabled)


if __name__ == "__main__":
    unittest.main()
