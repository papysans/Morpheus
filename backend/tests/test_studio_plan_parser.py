import unittest

from agents.studio import StudioWorkflow
from models import Chapter


class StudioPlanParserTest(unittest.TestCase):
    def _workflow(self) -> StudioWorkflow:
        return StudioWorkflow(studio=object(), memory_search_func=lambda *_args, **_kwargs: [])

    def _chapter(self) -> Chapter:
        return Chapter(
            id="ch-1",
            project_id="p-1",
            chapter_number=1,
            title="密钥的最后一次校准",
            goal="陈砚在数据洪流中定位到备份神谕的初始密钥，并在校准时触发深网防御机制。",
        )

    def test_extract_plan_payload_from_markdown_sections(self):
        workflow = self._workflow()
        chapter = self._chapter()
        text = """
节拍
1. 陈砚完成初步定位，但发现密钥信号被人为伪装。
2. 他在封锁窗口期强行校准，触发深网防御反制。
3. 章尾确认密钥只是诱饵，真正入口转向旧镜城节点。

冲突点
- 外部：深网防御系统与追踪者双向夹击。
- 内部：陈砚必须在救同伴与保线索之间二选一。

伏笔
- 旧镜城节点坐标与陈砚童年记忆重叠。

回收目标
- 回收上一章“六边形符号”来源。

角色目标
陈砚：在接口崩溃前拿到真实入口坐标。
"""
        parsed = workflow._extract_plan_payload(text, chapter)
        self.assertGreaterEqual(len(parsed["beats"]), 3)
        self.assertTrue(any("旧镜城节点" in item for item in parsed["beats"]))
        self.assertTrue(any("外部" in item for item in parsed["conflicts"]))
        self.assertEqual(parsed["role_goals"].get("陈砚"), "在接口崩溃前拿到真实入口坐标。")

    def test_extract_plan_payload_fallback_is_not_rigid_template(self):
        workflow = self._workflow()
        chapter = self._chapter()
        parsed = workflow._extract_plan_payload("（模型返回异常）", chapter)
        self.assertGreaterEqual(len(parsed["beats"]), 3)
        self.assertNotIn("中段制造冲突并推进人物关系", parsed["beats"])
        self.assertNotIn("结尾留下悬念或下一章引子", parsed["beats"])
        self.assertNotIn("主角目标与外部阻力发生碰撞", parsed["conflicts"])

    def test_extract_plan_quality_marks_template_output(self):
        workflow = self._workflow()
        chapter = self._chapter()
        template_text = """
{
  "beats": [
    "开场建立章节目标",
    "中段制造冲突并推进人物关系",
    "结尾留下悬念或下一章引子"
  ],
  "conflicts": [
    "主角目标与外部阻力发生碰撞",
    "内部价值观冲突抬升"
  ],
  "foreshadowing": [],
  "callback_targets": [],
  "role_goals": {}
}
"""
        _, quality = workflow._extract_plan_payload_with_quality(template_text, chapter)
        self.assertIn(quality["status"], {"warn", "bad"})
        self.assertGreaterEqual(quality.get("template_phrase_hits", 0), 2)
        self.assertTrue(any("模板化" in item for item in quality.get("issues", [])))


if __name__ == "__main__":
    unittest.main()
