from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Optional


_TEMPLATES: List[Dict[str, Any]] = [
    {
        "id": "serial-gintama",
        "name": "超长连载 · 单元喜剧主线",
        "category": "serial",
        "description": "单元剧日常 + 季度主线并行，强制反收束，适合长期连载。",
        "recommended": {
            "target_length": 320000,
            "scope": "book",
            "mode": "studio",
            "chapter_count": 24,
            "words_per_chapter": 1800,
            "chapter_range": [18, 40],
        },
        "genre_suggestion": "科幻喜剧 / 都市奇想",
        "style_suggestion": "吐槽喜剧 + 热血底色",
        "default_taboos": [
            "单章直接终结主线",
            "关键谜团一次性揭晓",
            "主角团关系永久定型",
        ],
        "identity_rules": [
            "本季禁止最终决战、终极真相、世界重置。",
            "每章新增1个钩子，最多回收1个钩子，至少保留2个未决事项。",
            "主线推进上限20%，其余用于角色关系/日常冲突/喜剧桥段。",
            "章尾必须保留续写触发点（人物、线索或危机至少1项）。",
        ],
        "prompt_hint": "本章只推进到“更复杂”，不要推进到“已解决”。",
    },
    {
        "id": "short-story",
        "name": "短篇小说",
        "category": "length",
        "description": "聚焦单一冲突，结尾强收束。参考 SFWA/Hugo 短篇定义。",
        "recommended": {
            "target_length": 6000,
            "scope": "volume",
            "mode": "cinematic",
            "chapter_count": 1,
            "words_per_chapter": 6000,
            "chapter_range": [1, 2],
        },
        "genre_suggestion": "不限",
        "style_suggestion": "高密度叙事",
        "default_taboos": ["多主线并发", "信息过度外溢到续集"],
        "identity_rules": [
            "只保留一条核心冲突线。",
            "中段必须完成一次价值翻转或认知翻转。",
            "结尾完成核心情绪闭环。",
        ],
        "prompt_hint": "只写一个冲突，不开第二战场。",
    },
    {
        "id": "novelette",
        "name": "中短篇（Novelette）",
        "category": "length",
        "description": "7,500–17,500 字区间，适合单主线+少量副线。",
        "recommended": {
            "target_length": 14000,
            "scope": "volume",
            "mode": "studio",
            "chapter_count": 4,
            "words_per_chapter": 3500,
            "chapter_range": [3, 6],
        },
        "genre_suggestion": "不限",
        "style_suggestion": "紧凑剧情推进",
        "default_taboos": ["超过两条副线", "未回收核心伏笔"],
        "identity_rules": [
            "每章必须有推进与转折。",
            "最后一章回收主伏笔并留少量余韵。",
        ],
        "prompt_hint": "集中火力讲完一个命题，副线只服务主线。",
    },
    {
        "id": "novella",
        "name": "中篇（Novella）",
        "category": "length",
        "description": "17,500–40,000 字区间，角色弧可完整但世界观不必完全展开。",
        "recommended": {
            "target_length": 30000,
            "scope": "volume",
            "mode": "studio",
            "chapter_count": 10,
            "words_per_chapter": 3000,
            "chapter_range": [8, 14],
        },
        "genre_suggestion": "不限",
        "style_suggestion": "角色驱动叙事",
        "default_taboos": ["前6章无关键转折", "结尾只留悬念不兑现"],
        "identity_rules": [
            "主角弧必须完整闭环。",
            "世界观展开只保留与主冲突直接相关部分。",
        ],
        "prompt_hint": "重点写人物变化，不追求铺满全世界设定。",
    },
    {
        "id": "novel-standard",
        "name": "长篇小说（Novel）",
        "category": "length",
        "description": "40,000+ 长篇模板，适合主线+两条以内副线。",
        "recommended": {
            "target_length": 90000,
            "scope": "book",
            "mode": "studio",
            "chapter_count": 20,
            "words_per_chapter": 4500,
            "chapter_range": [16, 30],
        },
        "genre_suggestion": "不限",
        "style_suggestion": "稳健长线叙事",
        "default_taboos": ["连续三章无主线推进", "主线高潮前提前透底"],
        "identity_rules": [
            "主线稳定推进，副线严格围绕主线。",
            "全书至少两次中段重大反转，末段集中回收。",
        ],
        "prompt_hint": "把冲突阶梯拉长，避免早期透支高潮。",
    },
    {
        "id": "three-act",
        "name": "三幕式结构",
        "category": "structure",
        "description": "开端-对抗-解决的经典三幕，适合大多数商业叙事。",
        "recommended": {
            "target_length": 70000,
            "scope": "book",
            "mode": "studio",
            "chapter_count": 18,
            "words_per_chapter": 3800,
            "chapter_range": [12, 24],
        },
        "genre_suggestion": "不限",
        "style_suggestion": "因果驱动",
        "default_taboos": ["第一幕过长", "第二幕无升级", "第三幕无兑现"],
        "identity_rules": [
            "第一幕建立目标与代价。",
            "第二幕持续升级阻力并逼迫主角改变策略。",
            "第三幕兑现核心承诺并完成主题表达。",
        ],
        "prompt_hint": "先定义幕目标，再写章目标。",
    },
    {
        "id": "hero-journey",
        "name": "英雄之旅",
        "category": "structure",
        "description": "适合成长/冒险线，强调从召唤到归来的角色蜕变。",
        "recommended": {
            "target_length": 100000,
            "scope": "book",
            "mode": "studio",
            "chapter_count": 24,
            "words_per_chapter": 4200,
            "chapter_range": [18, 32],
        },
        "genre_suggestion": "奇幻 / 科幻 / 冒险",
        "style_suggestion": "史诗成长",
        "default_taboos": ["导师线缺失", "试炼段无代价", "归来段无变化"],
        "identity_rules": [
            "必须包含召唤、越界、试炼、深渊、归来五段。",
            "每次升级都要付出明确代价。",
        ],
        "prompt_hint": "成长来自代价，不来自外挂。",
    },
]


def list_story_templates() -> List[Dict[str, Any]]:
    return deepcopy(_TEMPLATES)


def get_story_template(template_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not template_id:
        return None
    for item in _TEMPLATES:
        if item["id"] == template_id:
            return deepcopy(item)
    return None
