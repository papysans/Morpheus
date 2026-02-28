import unittest
import os
import io
import zipfile
import tempfile

from fastapi.testclient import TestClient
from uuid import uuid4

os.environ["REMOTE_LLM_ENABLED"] = "false"
os.environ["REMOTE_EMBEDDING_ENABLED"] = "false"

from api.main import app


class TestExportImport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def _create_project(self):
        payload = {
            "name": f"测试项目-{uuid4().hex[:8]}",
            "genre": "奇幻",
            "style": "冷峻",
            "target_length": 300000,
        }
        res = self.client.post("/api/projects", json=payload)
        self.assertEqual(res.status_code, 200)
        return res.json()["id"]

    def test_export_excludes_lancedb(self):
        project_id = self._create_project()
        res = self.client.get(f"/api/projects/{project_id}/export")
        self.assertEqual(res.status_code, 200)
        self.assertIn("zip", res.headers.get("content-type", ""))

        tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
        try:
            tmp.write(res.content)
            tmp.close()
            with zipfile.ZipFile(tmp.name) as zf:
                names = zf.namelist()
                for name in names:
                    self.assertNotIn("index/", name)
                    self.assertNotIn("index\\", name)
                has_project_json = any("project.json" in n for n in names)
                self.assertTrue(has_project_json, f"Expected project.json in archive, got: {names}")
        finally:
            os.unlink(tmp.name)

    def test_export_nonexistent_returns_404(self):
        res = self.client.get("/api/projects/nonexistent-id-xyz/export")
        self.assertEqual(res.status_code, 404)

    def test_import_creates_new_project(self):
        project_id = self._create_project()
        export_res = self.client.get(f"/api/projects/{project_id}/export")
        self.assertEqual(export_res.status_code, 200)
        zip_bytes = export_res.content

        import_res = self.client.post(
            "/api/projects/import",
            files={"file": ("project.zip", zip_bytes, "application/zip")},
        )
        self.assertEqual(import_res.status_code, 200)
        data = import_res.json()
        self.assertIn("project_id", data)
        self.assertIn("name", data)
        self.assertIn("chapter_count", data)
        self.assertNotEqual(data["project_id"], project_id)

        get_res = self.client.get(f"/api/projects/{data['project_id']}")
        self.assertEqual(get_res.status_code, 200)

    def test_import_invalid_zip_returns_400(self):
        res = self.client.post(
            "/api/projects/import",
            files={"file": ("bad.zip", b"not a zip", "application/zip")},
        )
        self.assertEqual(res.status_code, 400)

    def test_import_missing_project_json_returns_400(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("readme.txt", "hello")
        buf.seek(0)

        res = self.client.post(
            "/api/projects/import",
            files={"file": ("no_project.zip", buf.read(), "application/zip")},
        )
        self.assertEqual(res.status_code, 400)


if __name__ == "__main__":
    unittest.main()
