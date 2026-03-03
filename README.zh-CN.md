[English](README.md) | [中文](README.zh-CN.md)

# @indiekitai/trello-autopilot

Trello bug 自动修复 CLI — 从 Trello 看板扫描 bug 卡片，调用 coding agent（如 Claude Code）修复，运行测试验证，管理 git 分支/PR，修复后将卡片移到 "Done" 并添加摘要评论。

## 特性 (v0.2.0)

- **测试验证** — 修复后自动运行 `npm test` 或 `pytest`；测试失败 → 卡片添加 "fix-failed" 标签和失败详情评论
- **Git 集成** — 创建 `fix/card-{id}` 分支，生成 diff 摘要，`--pr` 模式通过 `gh` CLI 创建 Pull Request，`git blame` 分析
- **优先级排序** — 按标签优先级处理卡片：critical > high > medium > low
- **智能过滤** — `--label critical` 只修复特定标签，`--limit N` 限制数量
- **失败处理** — 修复失败的卡片添加 "needs-human" 标签和详细建议评论
- **重试** — `--retry` 重新尝试之前失败的卡片（fix-failed / needs-human）
- **报告** — 汇总报告包含修复/失败/跳过计数和耗时；`--json` 结构化输出；`--webhook` POST 结果

## 安装

```bash
npm install -g @indiekitai/trello-autopilot
# 或直接运行
npx @indiekitai/trello-autopilot --board "MyBoard" --list "Bugs" --repo ./myapp
```

## 配置

在 https://trello.com/power-ups/admin 获取 Trello API 凭据

```bash
export TRELLO_API_KEY="your-api-key"
export TRELLO_TOKEN="your-token"
```

## CLI 用法

```bash
# 修复 "Cutie" 看板上的所有 bug
trello-autopilot --board "Cutie" --repo /path/to/repo

# 只修复 critical bug，最多 3 个
trello-autopilot --board "Cutie" --label critical --limit 3

# 创建 PR 而不是直接 push 到 main
trello-autopilot --board "Cutie" --repo ./myapp --pr

# 重试之前失败的卡片
trello-autopilot --board "Cutie" --repo ./myapp --retry

# 自定义测试命令
trello-autopilot --board "Cutie" --repo ./myapp --test-command "make test"

# JSON 输出 + webhook 通知
trello-autopilot --board "Cutie" --json --webhook https://hooks.slack.com/xxx

# 仅预览（不做任何改动）
trello-autopilot --board "Cutie" --dry-run
```

### 选项

| 参数 | 缩写 | 默认值 | 说明 |
|------|------|--------|------|
| `--board` | `-b` | （必填） | Trello 看板名 |
| `--list` | `-l` | `"Bugs"` | 来源列表名 |
| `--done` | `-d` | `"Done"` | 修复后移入的目标列表 |
| `--repo` | `-r` | 当前目录 | 仓库路径 |
| `--agent` | `-a` | `"claude"` | Coding agent CLI 命令 |
| `--dry-run` | | `false` | 仅预览 |
| `--json` | | `false` | JSON 输出 |
| `--limit` | `-n` | 全部 | 最大处理卡片数 |
| `--label` | | 全部 | 只修复带此标签的卡片 |
| `--pr` | | `false` | 通过 `gh` CLI 创建 PR |
| `--retry` | | `false` | 重试 fix-failed/needs-human 卡片 |
| `--test-command` | `-t` | 自动检测 | 自定义测试命令 |
| `--webhook` | `-w` | | POST 结果到 URL |
| `--help` | `-h` | | 显示帮助 |

## 工作流程

1. 连接 Trello，找到指定的看板/列表
2. 按优先级标签排序卡片（critical > high > medium > low）
3. 应用过滤条件（`--label`、`--limit`、`--retry`）
4. 对每张卡片：
   - 创建 `fix/card-{id}` git 分支
   - 运行 `git blame` 分析获取上下文
   - 将卡片详情作为 prompt 调用 coding agent
   - 运行测试（`npm test` / `pytest` / 自定义命令）
   - **测试通过：** 提交、push（或用 `--pr` 创建 PR），移动卡片到 Done
   - **测试失败：** 添加 "fix-failed" 标签和失败评论，不移动卡片
   - **Agent 失败：** 添加 "needs-human" 标签和详细失败评论
5. 输出汇总报告（或 `--json` 结构化输出）
6. 如配置了 `--webhook` 则发送通知

## MCP Server

作为 MCP 工具服务器供 AI agent 使用：

```json
{
  "mcpServers": {
    "trello-autopilot": {
      "command": "npx",
      "args": ["@indiekitai/trello-autopilot/mcp"],
      "env": {
        "TRELLO_API_KEY": "your-key",
        "TRELLO_TOKEN": "your-token"
      }
    }
  }
}
```

### MCP 工具

| 工具 | 说明 |
|------|------|
| `scan_bugs` | 扫描 Trello 列表中的 bug 卡片（支持优先级排序和过滤） |
| `fix_bug` | 修复特定 bug 卡片，含测试验证和 git 集成 |
| `move_card` | 移动卡片到其他列表，可附带评论 |
| `retry_failed` | 重试之前失败的卡片 |
| `get_report` | 运行 autopilot 并返回结构化报告 |

## 编程式 API

```typescript
import {
  TrelloClient,
  scanBugs,
  fixBug,
  sortByPriority,
  filterByLabel,
  generateReport,
} from "@indiekitai/trello-autopilot";

const client = new TrelloClient({
  apiKey: process.env.TRELLO_API_KEY!,
  token: process.env.TRELLO_TOKEN!,
});

let bugs = await scanBugs(client, "Cutie", "Bugs");
bugs = sortByPriority(bugs);
bugs = filterByLabel(bugs, "critical");
console.log(`Found ${bugs.length} critical bugs`);
```

## 使用的标签

| 标签 | 含义 |
|------|------|
| `critical` / `high` / `medium` / `low` | 排序优先级 |
| `fix-failed` | 自动修复已应用但测试失败 |
| `needs-human` | 自动修复完全失败，需要人工介入 |

## License

MIT
