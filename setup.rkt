#!/usr/bin/env racket
#lang racket/base

;; setup.rkt — 一键部署 pi 配置
;; 用法: racket setup.rkt
;;       chmod +x setup.rkt && ./setup.rkt

(require racket/file
         racket/path
         racket/string
         racket/system)

(define target-dir (build-path (find-system-path 'home-dir) ".pi" "agent"))
(define src-dir (path-only (normalize-path (find-system-path 'run-file))))

(printf "==> 部署 pi 配置到 ~a\n" target-dir)
(make-directory* target-dir)

;; ── 复制文件 ────────────────────────────────────────────
(for ([file '("settings.json" "SYSTEM.md" "PI_DOCS.md")])
  (let ([src (build-path src-dir file)]
        [dst (build-path target-dir file)])
    (copy-file src dst #t)
    (printf "    ✓ ~a\n" file)))

;; ── 安装扩展 ────────────────────────────────────────────
(let ([ext-dir (build-path target-dir "extensions")])
  (make-directory* ext-dir)
  (for ([ext '("bracket-check.ts" "ssh-password.ts")])
    (copy-file (build-path src-dir "extensions" ext)
               (build-path ext-dir ext) #t)
    (printf "    ✓ extensions/~a\n" ext)))

;; ── 交互式设置 API Key ──────────────────────────────────
(define auth-file (build-path target-dir "auth.json"))
(if (file-exists? auth-file)
    (printf "==> auth.json 已存在，跳过\n")
    (begin
      (printf "\n==> 设置 DeepSeek API Key\n")
      (printf "    获取 key: https://platform.deepseek.com/api_keys\n")
      (display "    粘贴 API Key (回车跳过): ")
      (flush-output)
      (let ([key (string-trim (read-line))])
        (if (positive? (string-length key))
          (begin
            (call-with-output-file auth-file
              (lambda (out)
                (fprintf out "{\"deepseek\":{\"type\":\"api_key\",\"key\":\"~a\"}}" key))
              #:exists 'replace)
            (system (format "chmod 600 ~a" auth-file))
            (printf "    ✓ 已写入 ~a\n" auth-file))
          (printf "    ⚠ 已跳过，之后可手动写入 ~a\n" auth-file)))))

;; ── 添加 alias 到 ~/.bashrc ─────────────────────────────
(define bashrc (build-path (find-system-path 'home-dir) ".bashrc"))
(define block-start "# >>> pi aliases (auto-generated, do not edit below) >>>")
(define block-end   "# <<< pi aliases end <<<")
(define ssh-exclude "--exclude-tools ssh_bash,ssh_read,ssh_write,ssh_edit,ssh_connect,ssh_disconnect")
(define doc-cmd "\"$(cat ~/.pi/agent/PI_DOCS.md)\"")

;; 先移除旧的 pi alias 块（新版和旧版 marker 都处理）
(define old-lines (string-split (file->string bashrc) "\n"))
(define in-block? #f)
(define cleaned
  (for/list ([line (in-list old-lines)])
    (cond
      [(string-prefix? line "# >>> pi aliases") (set! in-block? #t) #f]
      [in-block?
       (when (string-prefix? line "# <<< pi aliases") (set! in-block? #f))
       #f]
      [(or (string-prefix? line "alias pi=")       ;; 旧版无标记
           (string-prefix? line "alias pi-doc=")
           (string-prefix? line "alias pi-ssh=")
           (and (string-prefix? line "# pi aliases") (not (string-prefix? line "# pi alias")))) ;; "# pi aliases" 旧 comment，别误杀 "# pi aliases (auto...)"
       #f]
      [else line])))

;; 写入新 alias 块
(printf "==> 更新 pi alias 到 .bashrc\n")
(call-with-output-file bashrc
  (lambda (out)
    (for ([line (in-list cleaned)] #:when line)
      (display line out)
      (newline out))
    (display "\n" out)
    (display block-start out) (newline out)
    (fprintf out "alias pi-agent='\\pi'\n")
    (fprintf out "alias pi='pi-agent ~a'\n" ssh-exclude)
    (fprintf out "alias pi-doc='pi-agent ~a --append-system-prompt ~a'\n" ssh-exclude doc-cmd)
    (fprintf out "alias pi-ssh='pi-agent'\n")
    (display block-end out) (newline out))
  #:exists 'replace)
(printf "    ✓ 已更新，执行 source ~~/.bashrc 生效\n")

(printf "\n    ✓ 全部完成！\n")
(printf "    pi       — 精简模式（无 SSH 工具）\n")
(printf "    pi-doc   — 带 pi 文档\n")
(printf "    pi-ssh   — 完整模式（含 SSH 远程工具）\n")
(printf "    进入 pi 后用 /ssh <host> 连接远程\n")
