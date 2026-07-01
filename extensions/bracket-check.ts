import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ── 括号配对 ──────────────────────────────────────────────
const OPENERS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
};
const CLOSERS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};
function isBracket(ch: string): boolean {
  return ch in OPENERS || ch in CLOSERS;
}

// ── 位置类型 ──────────────────────────────────────────────
interface Pos {
  line: number; // 1-based
  col: number; // 1-based
}

interface TopLevelForm {
  open: Pos;
  close: Pos | null; // null = 尚未闭合
}

interface StackEntry {
  char: string;
  openPos: Pos;
  enclosingTopLevel: Pos | null; // 所在顶层括号的开位置，null 表示自身就是顶层
}

interface BracketIssue {
  pos: Pos;
  char: string;
  message: string;
  enclosingTopLevel: Pos | null; // null = 自身就是顶层括号
}

// ── 扫描 + 解析 ──────────────────────────────────────────

function scanRacket(
  text: string
): { issues: BracketIssue[]; topLevelForms: TopLevelForm[] } {
  const stack: StackEntry[] = [];
  const issues: BracketIssue[] = [];
  const topLevelForms: TopLevelForm[] = [];

  let currentTopLevelOpen: Pos | null = null; // 当前打开的顶层括号位置

  let inString = false;
  let inLineComment = false;
  let blockCommentDepth = 0;

  let line = 1;
  let col = 1;
  let i = 0;

  function advance(n: number = 1) {
    for (let k = 0; k < n; k++) {
      if (i >= text.length) break;
      if (text[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  }

  function err(pos: Pos, ch: string, msg: string) {
    const enclosing =
      stack.length === 0 ? null : currentTopLevelOpen;
    issues.push({ pos, char: ch, message: msg, enclosingTopLevel: enclosing });
  }

  while (i < text.length) {
    // ── 行注释 ──
    if (inLineComment) {
      if (text[i] === "\n") {
        inLineComment = false;
      }
      advance();
      continue;
    }

    // ── 块注释 #| ... |# （可嵌套）──
    if (blockCommentDepth > 0) {
      if (text[i] === "|" && text[i + 1] === "#") {
        blockCommentDepth--;
        advance(2);
      } else if (text[i] === "#" && text[i + 1] === "|") {
        blockCommentDepth++;
        advance(2);
      } else {
        advance();
      }
      continue;
    }

    // ── 字符串 ──
    if (inString) {
      if (text[i] === "\\") {
        advance(2); // 跳过转义字符
      } else if (text[i] === '"') {
        inString = false;
        advance();
      } else {
        advance();
      }
      continue;
    }

    // ── 正常区域 ──
    const ch = text[i];
    const curPos: Pos = { line, col };

    if (ch === '"') {
      inString = true;
      advance();
    } else if (ch === ";") {
      inLineComment = true;
      advance();
    } else if (ch === "#" && text[i + 1] === "|") {
      blockCommentDepth = 1;
      advance(2);
    } else if (OPENERS[ch]) {
      // Racket 约定：col=1 的开括号视为新顶层，自动截断前方未闭合的括号
      if (col === 1 && stack.length > 0) {
        while (stack.length > 0) {
          const entry = stack.pop()!;
          issues.push({
            pos: entry.openPos,
            char: entry.char,
            message: `未闭合的括号 "${entry.char}"（被第 ${line} 行的新顶层截断），缺少对应的 "${OPENERS[entry.char]}"`,
            enclosingTopLevel: entry.enclosingTopLevel,
          });
        }
        // 标记上一个顶层为被截断
        const lastTL = topLevelForms[topLevelForms.length - 1];
        if (lastTL && lastTL.close === null) {
          lastTL.close = curPos;
        }
        currentTopLevelOpen = null;
      }

      // 开括号
      const isTopLevel = stack.length === 0;
      if (isTopLevel) {
        currentTopLevelOpen = curPos;
        topLevelForms.push({ open: curPos, close: null });
      }
      stack.push({
        char: ch,
        openPos: curPos,
        enclosingTopLevel: isTopLevel ? null : currentTopLevelOpen,
      });
      advance();
    } else if (CLOSERS[ch]) {
      // 闭括号
      if (stack.length === 0) {
        // 多余的闭括号（深度 0）
        err(curPos, ch, `多余的闭括号 "${ch}"，前方没有对应的开括号`);
      } else {
        const top = stack[stack.length - 1];
        const expectedClose = OPENERS[top.char];
        if (expectedClose === ch) {
          // 正确匹配
          stack.pop();
          // 如果回到深度 0，记录顶层括号的闭合位置
          if (stack.length === 0) {
            const tl = topLevelForms[topLevelForms.length - 1];
            tl.close = curPos;
            currentTopLevelOpen = null;
          }
        } else {
          // 类型不匹配：报告问题，同时弹出栈顶以便后续检查不被污染
          err(
            curPos,
            ch,
            `括号类型不匹配：期望 "${expectedClose}" 来闭合第 ${top.openPos.line} 行第 ${top.openPos.col} 列的 "${top.char}"，但遇到 "${ch}"`
          );
          // 弹出栈顶，恢复正确的嵌套结构
          stack.pop();
          if (stack.length === 0) {
            const tl = topLevelForms[topLevelForms.length - 1];
            tl.close = curPos;
            currentTopLevelOpen = null;
          }
        }
      }
      advance();
    } else {
      advance();
    }
  }

  // ── 检查剩余的块注释 ──
  if (blockCommentDepth > 0) {
    issues.push({
      pos: { line, col },
      char: "#|",
      message: `未闭合的块注释 #|...|#（嵌套深度 ${blockCommentDepth}）`,
      enclosingTopLevel: null,
    });
  }

  // 检查未闭合的字符串
  if (inString) {
    issues.push({
      pos: { line, col },
      char: '"',
      message: "未闭合的字符串",
      enclosingTopLevel: currentTopLevelOpen,
    });
  }

  // 检查未闭合的括号（栈中剩余）
  for (const entry of stack) {
    issues.push({
      pos: entry.openPos,
      char: entry.char,
      message: `未闭合的括号 "${entry.char}"，缺少对应的 "${OPENERS[entry.char]}"`,
      enclosingTopLevel: entry.enclosingTopLevel,
    });
  }

  return { issues, topLevelForms };
}

// ── 格式化输出 ────────────────────────────────────────────

function formatOutput(
  filePath: string,
  issues: BracketIssue[],
  topLevelForms: TopLevelForm[]
): string {
  if (issues.length === 0) {
    return `✅ 括号检查通过 — ${filePath} 中所有括号配对平衡`;
  }

  const parts: string[] = [];
  parts.push(`❌ 发现 ${issues.length} 个括号问题:\n`);

  for (let idx = 0; idx < issues.length; idx++) {
    const issue = issues[idx];
    parts.push(
      `${idx + 1}. 第 ${issue.pos.line} 行第 ${issue.pos.col} 列: ${issue.message}`
    );

    if (issue.enclosingTopLevel !== null) {
      // 找到对应的顶层范围
      const tl = topLevelForms.find(
        (f) =>
          f.open.line === issue.enclosingTopLevel!.line &&
          f.open.col === issue.enclosingTopLevel!.col
      );
      if (tl && tl.close) {
        parts.push(
          `   └─ 所在顶层: ( 第 ${tl.open.line} 行第 ${tl.open.col} 列 … ) 第 ${tl.close.line} 行第 ${tl.close.col} 列`
        );
      } else if (tl && tl.close === null) {
        parts.push(
          `   └─ 所在顶层: ( 第 ${tl.open.line} 行第 ${tl.open.col} 列 … ⚠ 该顶层括号本身也未闭合`
        );
      }
    }
    // enclosingTopLevel === null: 自身就是顶层，不显示外围结构

    if (idx < issues.length - 1) parts.push("");
  }

  return parts.join("\n");
}

// ── 扩展入口 ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "check_racket_brackets",
    label: "Check Racket Brackets",
    description:
      "检查 Racket 源文件中括号 () [] {} 的配对平衡。自动跳过字符串、行注释 (;) 和块注释 (#|...|#)。" +
      "对每个问题标出行列号，并显示所在顶层 S-表达式的括号范围。",
    promptSnippet:
      "检查 Racket 括号配对，跳过字符串和注释 (check_racket_brackets)",
    promptGuidelines: [
      "编辑 Racket 代码后，使用 check_racket_brackets 验证所有括号是否配对正确。",
    ],
    parameters: Type.Object({
      filePath: Type.String({
        description: "Racket 源文件路径（相对或绝对路径）",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = path.resolve(ctx.cwd, params.filePath);

      if (!fs.existsSync(filePath)) {
        return {
          content: [
            {
              type: "text",
              text: `❌ 文件不存在: ${filePath}`,
            },
          ],
          details: { error: "file not found", path: filePath },
        };
      }

      const ext = path.extname(filePath).toLowerCase();
      if (ext !== ".rkt" && ext !== ".scrbl" && ext !== ".rktl" && ext !== ".ss" && ext !== ".scm") {
        // 仍然检查，但给出提示
      }

      let text: string;
      try {
        text = fs.readFileSync(filePath, "utf-8");
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `❌ 无法读取文件: ${err.message}`,
            },
          ],
          details: { error: "read error", message: err.message },
        };
      }

      const { issues, topLevelForms } = scanRacket(text);
      const output = formatOutput(filePath, issues, topLevelForms);

      return {
        content: [{ type: "text", text: output }],
        details: {
          balanced: issues.length === 0,
          path: filePath,
          issueCount: issues.length,
          issues: issues.map((i) => ({
            line: i.pos.line,
            col: i.pos.col,
            char: i.char,
            message: i.message,
            enclosingTopLevel: i.enclosingTopLevel,
          })),
        },
      };
    },
  });
}
