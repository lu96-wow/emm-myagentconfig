# pi-config

可复现的 pi coding agent 配置文件集合。在新机器上一键部署。

## 包含内容

| 文件 | 说明 |
|------|------|
| `settings.json` | 全局设置：模型、思考级别、Ctrl+P 轮换等 |
| `SYSTEM.md` | 精简系统提示词（~520 tokens） |
| `PI_DOCS.md` | pi 文档路径片段，由 `pi-doc` alias 按需追加 |
| `extensions/bracket-check.ts` | Racket 括号检查扩展 |
| `setup.rkt` | Racket 一键部署脚本 |

## 前置：获取 API Key

1. 打开 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys)
2. 登录后点击「创建 API Key」
3. 复制生成的 key（格式：`sk-xxx...`）

## 部署

```bash
cd pi-config
racket setup.rkt     # Racket 脚本，跨平台
source ~/.bashrc
```

`setup.rkt` 自动完成：
- 复制 `settings.json`、`SYSTEM.md` 到 `~/.pi/agent/`
- 安装 `bracket-check` 扩展
- 交互式写入 `~/.pi/agent/auth.json`（API key）
- 添加 `pi` / `pi-doc` shell 函数到 `.bashrc`

## 设置 API Key（三种方式任选）

```bash
# 方式一：写入 auth.json（推荐，pi 原生支持）
echo '{"deepseek":{"type":"api_key","key":"sk-你的key"}}' > ~/.pi/agent/auth.json

# 方式二：环境变量 ~/.bashrc
echo 'export DEEPSEEK_API_KEY=sk-你的key' >> ~/.bashrc

# 方式三：每次启动时指定
DEEPSEEK_API_KEY=sk-你的key pi
```

> `auth.json` 支持多供应商：`{"deepseek":{...}, "anthropic":{...}, "openai":{...}}`

## 使用

| 命令 | 提示词 | 场景 |
|------|--------|------|
| `pi` | ~520 tokens | 日常编码 |
| `pi-doc` | ~820 tokens | 编写 pi 扩展/skill/主题（追加 PI_DOCS.md） |
| `Ctrl+P` | — | DeepSeek V4 Flash ↔ Pro 切换 |
| `Ctrl+L` | — | 查看所有可用模型 |

## 手动部署

```bash
# 全局配置
cp settings.json ~/.pi/agent/settings.json
cp SYSTEM.md ~/.pi/agent/SYSTEM.md
mkdir -p ~/.pi/agent/extensions
cp extensions/bracket-check.ts ~/.pi/agent/extensions/

# Shell 函数（动态解析 pi 文档路径，不受版本更新影响）
cat >> ~/.bashrc << 'FUNC'

# pi aliases
alias pi='pi'
pi-doc() {
  local PI_PKG=$(dirname $(dirname $(readlink -f $(which pi))))
  pi --append-system-prompt "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${PI_PKG}/README.md
- Additional docs: ${PI_PKG}/docs
- Examples: ${PI_PKG}/examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)"
}
FUNC
```
