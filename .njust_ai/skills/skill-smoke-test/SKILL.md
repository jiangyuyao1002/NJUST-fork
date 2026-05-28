---
name: skill-smoke-test
description: 当用户明确要求「技能冒烟测试」「测试 skills 功能」或英文 "skills smoke test" 时使用；用于验证扩展能发现 Skill 且 skill 工具可加载本文档。
---

# Skills 冒烟测试

## 目的

确认工作区 `.njust_ai/skills/` 下的技能已被扫描，且助手通过 **skill** 工具加载了本文件。

## 你需要做的事情

1. 向用户简短确认：**Skills 工作正常**：已加载 `skill-smoke-test`，系统提示中的 AVAILABLE SKILLS 与 `skill` 工具链路可用。
2. 说明本技能路径为：工作区 `.njust_ai/skills/skill-smoke-test/SKILL.md`。
3. **不要**再调用 `skill` 工具重复加载本技能（除非用户在新任务里再次请求测试）。

## 可选自检（用户若在设置页）

用户可在 **设置 → Skills** 中刷新列表，应能看到 **skill-smoke-test**。
